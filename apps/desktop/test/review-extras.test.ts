import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanCommitMessage, createHost, type Host } from '../src/host/app.ts';
import { runFile, type Runner } from '../src/host/connectors.ts';
import { parseRanking } from '../src/host/review-assistant.ts';

let root: string;
let repo: string;
let host: Host;
let ghCalls: string[][];

const fakeGh: Runner = async (file, args, env, cwd) => {
  if (file === 'git') return runFile(file, args, env, cwd);
  ghCalls.push(args);
  return { code: 0, stdout: 'Creating pull request\nhttps://github.com/example/demo/pull/7\n', stderr: '' };
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-rev-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  writeFileSync(join(repo, 'f.txt'), 'one\ntwo\nthree\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  ghCalls = [];
  host = createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
    github: { gh: 'gh', run: fakeGh },
  });
});

afterEach(async () => {
  await host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const text = (t: string) => [{ type: 'text' as const, text: t }];
const ready = (id: string, turns = 1) =>
  waitFor(() => host.repos.sessions.require(id).state === 'ready' && host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns);
const notices = (id: string) => host.repos.events.list(id).flatMap((e) => (e.type === 'notice' ? [e.text] : []));
const start = async (prompt: string) => {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask' });
  await ready(session.id);
  return { ws, session };
};

describe('RV-10 checks', () => {
  it('runs the chosen configurations in the worktree, on demand and after each turn', async () => {
    const { ws, session } = await start('edit a.txt hello');
    await expect(host.handlers['checks.run']({ sessionId: session.id })).rejects.toMatchObject({ code: 'no_checks' });
    const pass = host.repos.runs.saveUser({ workspaceId: ws.id, name: 'Has a.txt', command: ['node', '-e', "require('fs').statSync('a.txt')"], cwd: ws.rootPath });
    const fail = host.repos.runs.saveUser({ workspaceId: ws.id, name: 'Lint', command: ['node', '-e', "console.log('lint: 2 problems'); process.exit(3)"], cwd: ws.rootPath });
    await host.handlers['checks.saveSettings']({ workspaceId: ws.id, settings: { configIds: [pass.id, fail.id], afterTurn: false } });
    const results = await host.handlers['checks.run']({ sessionId: session.id });
    expect(results.map((r) => [r.name, r.exitCode])).toEqual([
      ['Has a.txt', 0],
      ['Lint', 3],
    ]);
    expect(results[1]!.output).toContain('lint: 2 problems');
    expect(notices(session.id)).toContain('Checks: 1 of 2 failed (Lint).');
    expect(host.repos.runs.history(ws.id).filter((r) => r.sessionId === session.id)).toHaveLength(2);

    await host.handlers['checks.saveSettings']({ workspaceId: ws.id, settings: { configIds: [pass.id], afterTurn: true } });
    await host.sessions.prompt(session.id, text('say again'));
    await waitFor(() => notices(session.id).includes('Checks: all 1 passed.'));
    expect(await host.handlers['checks.results']({ sessionId: session.id })).toHaveLength(1);
  }, 40_000);
});

describe('RV-11 base moved', () => {
  it('reports conflicts and moves the session onto the new base, asking the agent to resolve them', async () => {
    const { session } = await start('edit f.txt one\\nTWO-agent\\nthree\\n');
    // The user commits a conflicting change and an unrelated file in the checkout.
    writeFileSync(join(repo, 'f.txt'), 'one\nTWO-user\nthree\n');
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'user change'], { cwd: repo });
    const head = (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();

    const status = await host.handlers['sessions.baseStatus']({ sessionId: session.id });
    expect(status).toMatchObject({ head, behind: 1, conflicts: ['f.txt'], branch: 'main' });

    const after = await host.handlers['sessions.rebase']({ sessionId: session.id, askAgent: true });
    expect(after).toMatchObject({ base: head, behind: 0, conflicts: ['f.txt'] });
    expect(host.repos.sessions.require(session.id).baseCommit).toBe(head);
    const wt = session.worktreePath!;
    expect(readFileSync(join(wt, 'f.txt'), 'utf8')).toMatch(/<<<<<<<[\s\S]*TWO-user[\s\S]*TWO-agent[\s\S]*>>>>>>>|<<<<<<<[\s\S]*TWO-agent[\s\S]*TWO-user[\s\S]*>>>>>>>/);
    expect(readFileSync(join(wt, 'other.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('other\n');
    // Only the agent's change shows in review now, not the user's commit.
    expect((await host.review.changes(session.id, null)).map((c) => c.path)).toEqual(['f.txt']);
    await ready(session.id, 2);
    const prompts = host.repos.events.list(session.id).flatMap((e) => (e.type === 'user.message' ? [e.content.map((b) => ('text' in b ? b.text : '')).join('')] : []));
    expect(prompts.at(-1)).toContain('conflict markers');
  }, 40_000);
});

describe('RV-12 pull request', () => {
  it('commits, pushes the branch and opens the pull request with gh', async () => {
    const remote = join(root, 'remote.git');
    await git(['init', '-q', '--bare', remote], { cwd: root });
    await git(['remote', 'add', 'origin', remote], { cwd: repo });
    const { session } = await start('edit feature.txt done');
    const res = await host.handlers['sessions.pullRequest']({ sessionId: session.id, files: ['feature.txt'], title: 'Add the feature', body: 'Why it matters.', draft: true });
    expect(res.url).toBe('https://github.com/example/demo/pull/7');
    expect(ghCalls[0]).toEqual(['pr', 'create', '--head', session.branch!, '--title', 'Add the feature', '--body', 'Why it matters.', '--base', 'main', '--draft']);
    expect((await git(['branch', '--list', session.branch!], { cwd: remote })).trim()).toContain(session.branch!);
    expect(host.repos.sessions.require(session.id).state).toBe('landed');
    expect(host.repos.audit.forSession(session.id, 'session.land.pull-request')[0]!.detail).toMatchObject({ pullRequest: res.url, files: ['feature.txt'] });
  }, 40_000);

  it('refuses without an origin remote, before committing anything', async () => {
    const { session } = await start('edit feature.txt done');
    await expect(host.handlers['sessions.pullRequest']({ sessionId: session.id, files: ['feature.txt'], title: 'X', body: '', draft: false })).rejects.toMatchObject({ code: 'no_remote' });
    expect((await git(['log', '--oneline', session.branch!], { cwd: repo })).trim().split('\n')).toHaveLength(1);
  }, 40_000);
});

describe('RV-13 commit message and RV-14 review assistant', () => {
  it('asks the session agent for a commit message and cleans it up', async () => {
    const { session } = await start('edit a.txt hi');
    const { message } = await host.handlers['sessions.draftCommitMessage']({ sessionId: session.id, hint: 'say "Add the greeting file"' });
    expect(message).toBe('Add the greeting file');
    expect(cleanCommitMessage('```\nFix it\n\nBecause.\n```')).toBe('Fix it\n\nBecause.');
  }, 40_000);

  it('a second agent ranks the changed files read-only, in a throwaway worktree', async () => {
    const { session } = await start('edit a.txt hi\nedit b.txt there');
    const focus = 'say [{"path":"b.txt","risk":"low","reason":"text only"},{"path":"a.txt","risk":"high","reason":"touches auth"}]';
    const result = await host.handlers['sessions.reviewAssist']({ sessionId: session.id, agentId: 'fake', focus });
    expect(result.ranking.map((r) => [r.path, r.risk])).toEqual([
      ['a.txt', 'high'],
      ['b.txt', 'low'],
    ]);
    expect(await host.handlers['sessions.reviewAssessment']({ sessionId: session.id })).toMatchObject({ agentId: 'fake' });
    expect(await git(['worktree', 'list'], { cwd: repo })).not.toContain('review-tmp');
    // The session itself is untouched.
    expect(host.repos.turns.list(session.id)).toHaveLength(1);
    expect(existsSync(join(session.worktreePath!, 'a.txt'))).toBe(true);
    expect(parseRanking('no json here')).toBeNull();
  }, 40_000);
});

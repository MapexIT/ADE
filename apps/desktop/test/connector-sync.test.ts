import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { runFile, type Runner } from '../src/host/connectors.ts';
import { resultList, type ShortcutActions } from '../src/host/shortcut-actions.ts';
import { githubIssue, parseProjectItems, shortcutId } from '../src/host/work-item-sync.ts';

let root: string;
let repo: string;
let host: Host;
let gh: { args: string[]; cwd?: string }[];
let ghAnswers: (args: string[]) => { code: number; stdout: string } | null;
let sc: { calls: unknown[][] } & ShortcutActions;

const fakeGh: Runner = async (file, args, env, cwd) => {
  if (file === 'git') return runFile(file, args, env, cwd);
  gh.push({ args, ...(cwd ? { cwd } : {}) });
  if (args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/example/demo/pull/7\n', stderr: '' };
  const a = ghAnswers(args);
  return a ? { ...a, stderr: '' } : { code: 0, stdout: '{}', stderr: '' };
};

function fakeShortcut(): { calls: unknown[][] } & ShortcutActions {
  const calls: unknown[][] = [];
  return {
    calls,
    moveStory: async (...a) => void calls.push(['move', ...a]),
    comment: async (...a) => void calls.push(['comment', ...a]),
    workflowStates: async () => [
      { id: 500, name: 'In progress', type: 'started', position: 2 },
      { id: 400, name: 'Ready', type: 'unstarted', position: 1 },
      { id: 700, name: 'Done', type: 'done', position: 3 },
    ],
    currentIteration: async () => ({ id: 9, name: 'Sprint 9' }),
    iterationStories: async () => [
      { id: 42, name: 'Parser', url: 'https://app.shortcut.com/s/42', state: 500 },
      { id: 43, name: 'Docs', url: null, state: 'Ready' },
    ],
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-sync-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  await git(['init', '-q', '--bare', join(root, 'remote.git')], { cwd: root });
  await git(['remote', 'add', 'origin', join(root, 'remote.git')], { cwd: repo });
  gh = [];
  ghAnswers = () => null;
  sc = fakeShortcut();
  host = createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
    github: { gh: 'gh', run: fakeGh },
    shortcut: sc,
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
const prompts = (id: string) => host.repos.events.list(id).flatMap((e) => (e.type === 'user.message' ? [e.content.map((b) => ('text' in b ? b.text : '')).join('')] : []));
const start = async (prompt: string, workItemRef?: string) => {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask', ...(workItemRef ? { workItemRef } : {}) });
  await ready(session.id);
  return { ws, session };
};
const openPr = (sessionId: string, files: string[], body = 'Why.') =>
  host.handlers['sessions.pullRequest']({ sessionId, files, title: 'Add it', body, draft: false });

describe('parsing helpers', () => {
  it('reads refs, MCP results and project items', () => {
    expect(shortcutId('sc-42')).toBe(42);
    expect(shortcutId('o/r#1')).toBeNull();
    expect(githubIssue('example/demo#12')).toEqual({ repo: 'example/demo', number: 12 });
    expect(resultList({ content: [{ type: 'text', text: '{"data":[{"id":1}]}' }] })).toEqual([{ id: 1 }]);
    expect(resultList({ content: [{ type: 'text', text: 'not json' }] })).toEqual([]);
    expect(parseProjectItems('{"items":[{"title":"Fix","status":"Todo","content":{"number":3,"repository":"o/r","url":"https://x"}},{"title":"Draft"}]}')).toEqual([
      { ref: 'o/r#3', title: 'Fix', url: 'https://x', status: 'Todo' },
      { ref: 'Draft', title: 'Draft', url: null, status: 'No status' },
    ]);
  });
});

describe('CO-05 and CO-08 with Shortcut', () => {
  it('moves the story on start, pull request and merge, and posts progress notes, only when opted in', async () => {
    const off = await start('edit a.txt one', 'sc-41');
    expect(sc.calls).toEqual([]);
    await host.handlers['sync.save']({ workspaceId: off.ws.id, settings: { moveOnStart: 500, moveOnPullRequest: 600, moveOnMerge: 700, progressNotes: true, closeIssues: false } });

    const { session } = await start('edit feature.txt done\nsay I added the feature.', 'sc-42');
    await waitFor(() => sc.calls.length >= 1);
    expect(sc.calls[0]).toEqual(['move', 42, 500, undefined]);

    const { url } = await openPr(session.id, ['feature.txt']);
    expect(sc.calls).toContainEqual(['move', 42, 600, url]);
    expect(sc.calls.find((c) => c[0] === 'comment')?.[2]).toContain(`ADE opened a pull request: ${url}`);
    expect(host.repos.sessions.require(session.id).state).toBe('ready');

    ghAnswers = (args) => (args[1] === 'view' ? { code: 0, stdout: JSON.stringify({ state: 'MERGED', number: 7, reviewDecision: 'APPROVED' }) } : args[1] === 'checks' ? { code: 0, stdout: '[]' } : null);
    const status = await host.handlers['sessions.pullRequestStatus']({ sessionId: session.id });
    expect(status).toMatchObject({ state: 'MERGED', number: 7, reviewDecision: 'APPROVED' });
    expect(host.repos.sessions.require(session.id).state).toBe('landed');
    await waitFor(() => sc.calls.some((c) => c[0] === 'move' && c[2] === 700));
    expect(sc.calls.filter((c) => c[0] === 'comment').at(-1)?.[2]).toContain('The pull request was merged');
    expect(host.repos.audit.forSession(session.id, 'session.land.merged')[0]!.actor).toBe('github');
  }, 40_000);

  it('builds the iteration board with session badges', async () => {
    const { ws, session } = await start('say hi', 'sc-42');
    const board = await host.handlers['board.get']({ workspaceId: ws.id });
    expect(board.title).toBe('Sprint 9');
    expect(board.columns.map((c) => c.name)).toEqual(['Ready', 'In progress']);
    expect(board.columns[1]!.items[0]).toMatchObject({ ref: 'sc-42', title: 'Parser', sessions: [{ id: session.id }] });
  }, 40_000);
});

describe('CO-06, CO-07 and pushing to the pull request', () => {
  it('sends review comments and failing checks as one prompt each, and pushes new commits', async () => {
    const { session } = await start('edit feature.txt first');
    await openPr(session.id, ['feature.txt']);
    ghAnswers = (args) => {
      if (args[1] === 'view' && args.includes('reviews,comments'))
        return { code: 0, stdout: JSON.stringify({ reviews: [{ author: { login: 'ana' }, body: 'Please add tests.', state: 'CHANGES_REQUESTED' }], comments: [{ author: { login: 'bo' }, body: 'Nice.' }] }) };
      if (args[0] === 'api') return { code: 0, stdout: JSON.stringify([{ path: 'feature.txt', line: 1, body: 'Typo here.', user: { login: 'ana' } }]) };
      if (args[1] === 'checks') return { code: 1, stdout: JSON.stringify([{ name: 'test', bucket: 'fail', link: 'https://github.com/example/demo/actions/runs/1/job/99' }, { name: 'lint', bucket: 'pass', link: '' }]) };
      if (args[0] === 'run') return { code: 0, stdout: 'test\tRun tests\tExpected 2, got 3' };
      return null;
    };
    expect(await host.handlers['sessions.sendReviewComments']({ sessionId: session.id })).toEqual({ count: 3 });
    await ready(session.id, 2);
    const review = prompts(session.id).at(-1)!;
    expect(review).toContain('Review by ana (changes requested):\nPlease add tests.');
    expect(review).toContain('feature.txt:1 (ana): Typo here.');
    expect(gh.find((c) => c.args[0] === 'api')?.args[1]).toBe('repos/{owner}/{repo}/pulls/7/comments');

    expect(await host.handlers['sessions.sendFailedChecks']({ sessionId: session.id })).toEqual({ count: 1 });
    await ready(session.id, 3);
    expect(prompts(session.id).at(-1)).toContain('Expected 2, got 3');
    expect(gh.find((c) => c.args[0] === 'run')?.args).toEqual(['run', 'view', '--job', '99', '--log-failed']);

    await host.sessions.prompt(session.id, text('edit feature.txt second'));
    await ready(session.id, 4);
    await host.handlers['sessions.pushUpdate']({ sessionId: session.id, message: 'Address review' });
    const log = (await git(['log', '--format=%s', session.branch!], { cwd: join(root, 'remote.git') })).trim().split('\n');
    expect(log.slice(0, 2)).toEqual(['Address review', 'Add it']);
  }, 60_000);
});

describe('CO-08 with GitHub issues and CO-10 personal MCP servers', () => {
  it('closes the issue through the pull request and comments on landing', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['sync.save']({ workspaceId: ws.id, settings: { moveOnStart: null, moveOnPullRequest: null, moveOnMerge: null, progressNotes: true, closeIssues: true } });
    const { session } = await start('edit fix.txt fixed\nsay Fixed the crash.', 'example/demo#12');
    await openPr(session.id, ['fix.txt'], 'The fix.');
    const create = gh.find((c) => c.args[1] === 'create')!.args;
    expect(create[create.indexOf('--body') + 1]).toBe('The fix.\n\nCloses example/demo#12');
    const comment = gh.find((c) => c.args[0] === 'issue')!.args;
    expect(comment.slice(0, 5)).toEqual(['issue', 'comment', '12', '--repo', 'example/demo']);
    expect(comment[6]).toContain('Fixed the crash.');
  }, 40_000);

  it('validates personal MCP servers and gives them to every session', async () => {
    await expect(host.handlers['mcp.savePersonal']({ yaml: '- name: bad name\n' })).rejects.toMatchObject({ code: 'invalid' });
    await host.handlers['mcp.savePersonal']({ yaml: '- name: notes\n  command: ["node", "notes.js"]\n' });
    expect((await host.handlers['mcp.personal']({})).yaml).toContain('notes');
    const { session } = await start('mcp');
    const said = host.repos.events.list(session.id).flatMap((e) => (e.type === 'agent.message' ? [e.text] : []));
    expect(said.join(' ')).toContain('MCP servers: notes.');
  }, 40_000);
});

describe('workflow connector steps', () => {
  it('comment and move:<state> act on the work item; unknown actions explain what is supported', async () => {
    expect(await host.sync.runAction('shortcut', 'comment', 'sc-42', 'Done.')).toBe('Commented on sc-42.');
    expect(await host.sync.runAction('shortcut', 'move:700', 'sc-42', '')).toBe('Moved sc-42 to workflow state 700.');
    expect(sc.calls).toEqual([
      ['comment', 42, 'Done.'],
      ['move', 42, 700],
    ]);
    expect(await host.sync.runAction('github', 'comment', 'example/demo#3', 'Hi')).toBe('Commented on example/demo#3.');
    expect(gh.at(-1)!.args).toEqual(['issue', 'comment', '3', '--repo', 'example/demo', '--body', 'Hi']);
    await expect(host.sync.runAction('shortcut', 'archive', 'sc-42', '')).rejects.toThrow('support "comment" and "move:<workflow state id>"');
    await expect(host.sync.runAction('github', 'comment', 'sc-1', '')).rejects.toThrow('is not a GitHub issue');
  });
});

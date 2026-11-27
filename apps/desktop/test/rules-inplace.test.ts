import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionRule } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { ruleAnswer, ruleRegExp } from '../src/host/workspace-rules.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-rules-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  // The sandbox is covered in containment.test.ts; here sessions run without it on every platform.
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
  host.repos.settings.set('sandbox.byDefault', false);
});

afterEach(async () => {
  await host.dispose();
  removeTemp(root);
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
const ready = (id: string) => waitFor(() => host.repos.sessions.require(id).state === 'ready');

describe('AP-06 rule matching', () => {
  const request = (title: string, detail: string | null, kind: 'execute' | 'edit' = 'execute') => ({
    requestId: 'r',
    toolCallId: 't',
    title,
    kind,
    detail,
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
    ],
  });

  it('matches whole text with * as a wildcard, ignoring case', () => {
    expect(ruleRegExp('npm *').test('NPM test')).toBe(true);
    expect(ruleRegExp('npm *').test('pnpm test')).toBe(false);
    expect(ruleRegExp('git status').test('git status --short')).toBe(false);
    expect(ruleRegExp('rm -rf (all)').test('rm -rf (all)')).toBe(true);
  });

  it('lets deny win, respects the kind and answers nothing without a match', () => {
    const rules: PermissionRule[] = [
      { id: 'a', decision: 'allow', kind: 'any', pattern: 'npm *' },
      { id: 'd', decision: 'deny', kind: 'execute', pattern: 'npm publish*' },
      { id: 'e', decision: 'allow', kind: 'edit', pattern: 'git *' },
    ];
    expect(ruleAnswer(rules, request('Run npm test', 'npm test'))).toMatchObject({ decidedBy: 'rule:a', decision: { optionId: 'yes' } });
    expect(ruleAnswer(rules, request('Run npm publish', 'npm publish --tag x'))).toMatchObject({ decidedBy: 'rule:d', decision: { optionId: 'no' } });
    expect(ruleAnswer(rules, request('Run git push', 'git push'))).toBeNull();
    expect(ruleAnswer(rules, request('Run cargo build', 'cargo build'))).toBeNull();
  });
});

describe('AP-06 workspace rules in a session', () => {
  it('answers matching requests, logs every automatic answer and still asks for the rest', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['rules.save']({
      workspaceId: ws.id,
      rules: [
        { id: 'allow-tests', decision: 'allow', kind: 'execute', pattern: 'npm test' },
        { id: 'deny-rm', decision: 'deny', kind: 'any', pattern: 'rm *' },
      ],
    });
    expect(await host.handlers['rules.list']({ workspaceId: ws.id })).toHaveLength(2);
    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('ask npm test\nask rm -rf build\nask git push\nsay done'),
      permissionProfile: 'ask',
      bringChanges: false,
    });
    // The third request matches no rule, so the user is asked.
    await waitFor(() => host.repos.sessions.require(session.id).state === 'waiting-on-user');
    const decided = host.repos.events.list(session.id).flatMap((e) => (e.type === 'permission.decided' ? [e] : []));
    expect(decided.map((d) => [d.decidedBy, d.decision.outcome === 'selected' ? d.decision.optionId : null])).toEqual([
      ['rule:allow-tests', 'allow-once'],
      ['rule:deny-rm', 'reject-once'],
    ]);
    expect(decided[1]!.note).toBe('Workspace rule: deny "rm *"');
    const audit = host.repos.audit.forSession(session.id, 'permission.decided');
    expect(audit.map((a) => a.actor)).toEqual(['rule:allow-tests', 'rule:deny-rm']);
    expect(audit[1]!.detail.rule).toMatchObject({ pattern: 'rm *' });
    expect(host.repos.audit.list(ws.id).some((a) => a.action === 'rules.saved')).toBe(true);
  });

  it('AP-09: a wildcard allow rule does not answer a chained command', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['rules.save']({ workspaceId: ws.id, rules: [{ id: 'tests', decision: 'allow', kind: 'execute', pattern: 'npm test*' }] });
    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('ask npm test --watch\nask npm test && rm -rf build\nsay done'),
      permissionProfile: 'ask',
      bringChanges: false,
    });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'waiting-on-user');
    const events = host.repos.events.list(session.id);
    const decided = events.flatMap((e) => (e.type === 'permission.decided' ? [e] : []));
    expect(decided.map((d) => d.decidedBy)).toEqual(['rule:tests']);
    const pending = events.flatMap((e) => (e.type === 'permission.requested' ? [e] : [])).at(-1)!;
    expect(pending.detail).toBe('npm test && rm -rf build');
    await host.handlers['sessions.answerPermission']({ sessionId: session.id, requestId: pending.requestId, optionId: 'reject-once' });
    await ready(session.id);
  });
});

describe('CN-08 run in place', () => {
  it('is off by default', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await expect(
      host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('say hi'), permissionProfile: 'ask', inPlace: true }),
    ).rejects.toMatchObject({ code: 'in_place_off' });
  });

  it('works in the checkout, one session at a time, and Discard restores the snapshot', async () => {
    host.repos.settings.set('sessions.runInPlace', true);
    const ws = await host.handlers['workspace.open']({ path: repo });
    // The user's own uncommitted work must survive the session.
    writeFileSync(join(repo, 'notes.txt'), 'mine\n');
    writeFileSync(join(repo, 'crlf.txt'), 'one\r\ntwo\r\n');
    writeFileSync(join(repo, 'README.md'), '# Demo\n\nMy edit.\n');
    const session = await host.sessions.create({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('edit README.md # Agent\nedit added.txt new\nsay done'),
      permissionProfile: 'ask',
      inPlace: true,
    });
    expect(session).toMatchObject({ inPlace: true, worktreePath: ws.rootPath, branch: 'main' });
    await expect(
      host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('say hi'), permissionProfile: 'ask', inPlace: true }),
    ).rejects.toMatchObject({ code: 'in_place_busy' });
    await ready(session.id);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Agent');
    // Review shows only what the agent changed, not the user's earlier work.
    const changes = await host.review.changes(session.id, null);
    expect(changes.map((c) => c.path).sort()).toEqual(['README.md', 'added.txt']);

    const patch = await host.review.discard(session.id);
    expect(patch && existsSync(patch)).toBe(true);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Demo\n\nMy edit.\n');
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n');
    // Byte for byte, whatever the user's line-ending settings are.
    expect(readFileSync(join(repo, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(existsSync(join(repo, 'added.txt'))).toBe(false);
    expect(existsSync(join(repo, '.git'))).toBe(true);
    // Nothing was staged in the user's index, and the snapshot ref is gone.
    expect((await git(['diff', '--cached', '--name-only'], { cwd: repo })).trim()).toBe('');
    expect((await git(['for-each-ref', 'refs/ade/'], { cwd: repo })).trim()).toBe('');
  }, 40_000);

  it('keeps the selected files and puts the others back; committing is left to the user', async () => {
    host.repos.settings.set('sessions.runInPlace', true);
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.sessions.create({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('edit README.md # Agent\nedit added.txt new\nsay done'),
      permissionProfile: 'ask',
      inPlace: true,
    });
    await ready(session.id);
    await expect(host.review.land(session.id, 'commit', ['added.txt'], 'msg')).rejects.toMatchObject({ code: 'in_place' });
    await host.review.land(session.id, 'apply', ['added.txt']);
    expect(readFileSync(join(repo, 'added.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Demo\n');
    expect(host.repos.sessions.require(session.id).state).toBe('landed');
    expect(host.repos.audit.forSession(session.id, 'session.land.keep')[0]!.detail).toMatchObject({ reverted: ['README.md'] });
    // A new in-place session may start once the first has ended.
    const next = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('say hi'), permissionProfile: 'ask', inPlace: true });
    await ready(next.id);
  }, 40_000);
});

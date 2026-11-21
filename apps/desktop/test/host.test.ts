import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeedsYouItem, SessionEvent, SessionState } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { projectSession } from '@ade/session-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

function makeHost() {
  return createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-host-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = makeHost();
});

afterEach(async () => {
  await host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
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

const state = (id: string): SessionState => host.repos.sessions.require(id).state;
const text = (t: string) => [{ type: 'text' as const, text: t }];

async function openAndStart(prompt: string, profile: 'ask' | 'read-only' | 'auto-edit' = 'ask') {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: profile, bringChanges: false });
  return { ws, session };
}

describe('host with the fake agent', () => {
  it('rejects a folder that is not a Git repository', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(host.handlers['workspace.open']({ path: plain })).rejects.toMatchObject({ code: 'not_a_repo' });
  });

  it('M2 gate: tool call, approval, message, follow-up, history intact after restart', async () => {
    const events: SessionEvent[] = [];
    host.bus.on('session.event', (e) => events.push(e));
    let inbox: NeedsYouItem[] = [];
    host.bus.on('inbox.changed', (i) => (inbox = i));

    const { ws, session } = await openAndStart('read README.md\nask npm test\nsay All done.');
    expect(session.worktreePath).not.toContain(repo);
    await waitFor(() => state(session.id) === 'waiting-on-user');
    expect(inbox).toHaveLength(1);
    const req = events.find((e) => e.type === 'permission.requested');
    expect(req?.type === 'permission.requested' && req.detail).toBe('npm test');
    const allow = req?.type === 'permission.requested' ? req.options.find((o) => o.kind === 'allow_once')! : null;
    await host.handlers['sessions.answerPermission']({ sessionId: session.id, requestId: req?.type === 'permission.requested' ? req.requestId : '', optionId: allow!.optionId });
    await waitFor(() => state(session.id) === 'ready');
    expect(inbox).toHaveLength(0);

    await host.handlers['sessions.prompt']({ sessionId: session.id, content: text('say Follow-up done.') });
    await waitFor(() => host.repos.turns.list(session.id).length === 2 && state(session.id) === 'ready', 40_000);

    const before = projectSession(host.repos.events.list(session.id));
    await host.dispose();
    host = makeHost();
    const detail = await host.handlers['sessions.get']({ sessionId: session.id });
    const after = projectSession(detail.events);
    expect(after.items).toEqual(before.items);
    expect(after.items.filter((i) => i.kind === 'tool-call')).toHaveLength(2);
    expect(after.items.filter((i) => i.kind === 'agent-message').map((i) => (i.kind === 'agent-message' ? i.text : ''))).toEqual(['All done.', 'Follow-up done.']);
    expect(detail.session.state).toBe('ready');
    const audit = await host.handlers['audit.list']({ workspaceId: ws.id });
    expect(audit.some((a) => a.action === 'permission.decided' && a.actor === 'user')).toBe(true);
  });

  it('M3 gate: two turns edit two files, per-turn diff, undo turn 2, land one file, discard keeps a patch', async () => {
    const { session } = await openAndStart('edit one.txt first');
    await waitFor(() => state(session.id) === 'ready');
    await host.handlers['sessions.prompt']({ sessionId: session.id, content: text('edit two.txt second') });
    await waitFor(() => host.repos.turns.list(session.id).length === 2 && state(session.id) === 'ready');

    const turn1 = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: 0 });
    const turn2 = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: 1 });
    expect(turn1.map((c) => c.path)).toEqual(['one.txt']);
    expect(turn2.map((c) => c.path)).toEqual(['two.txt']);
    const diff = await host.handlers['sessions.diff']({ sessionId: session.id, path: 'two.txt', turnIndex: 1 });
    expect(diff).toMatchObject({ oldText: '', newText: 'second', binary: false });

    await host.handlers['sessions.undoTurn']({ sessionId: session.id, turnIndex: 1 });
    const all = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: null });
    expect(all.map((c) => c.path)).toEqual(['one.txt']);
    expect(existsSync(join(session.worktreePath!, 'two.txt'))).toBe(false);

    // Land one file into the checkout, as uncommitted changes. Never automatic.
    expect(existsSync(join(repo, 'one.txt'))).toBe(false);
    await host.handlers['sessions.land']({ sessionId: session.id, mode: 'apply', files: ['one.txt'] });
    expect(readFileSync(join(repo, 'one.txt'), 'utf8')).toBe('first');
    expect(state(session.id)).toBe('landed');

    // A second session is discarded and keeps its final patch.
    const { session: s2 } = await openAndStart('edit three.txt third');
    await waitFor(() => state(s2.id) === 'ready');
    const { patchPath } = await host.handlers['sessions.discard']({ sessionId: s2.id });
    expect(patchPath && readFileSync(patchPath, 'utf8')).toContain('three.txt');
    expect(existsSync(s2.worktreePath!)).toBe(false);
    expect(state(s2.id)).toBe('discarded');
  });

  it('queues a message typed while working and sends it when the turn ends (SR-02)', async () => {
    const { session } = await openAndStart('sleep 400\nsay first');
    await waitFor(() => state(session.id) === 'working');
    await host.handlers['sessions.queue']({ sessionId: session.id, content: text('say second') });
    expect(host.sessions.queued(session.id)).toHaveLength(1);
    await waitFor(() => host.repos.turns.list(session.id).length === 2 && state(session.id) === 'ready');
    expect(host.sessions.queued(session.id)).toHaveLength(0);
  });

  it('interrupt cancels the turn, answers pending requests as cancelled and sends the new prompt (SR-03)', async () => {
    const { session } = await openAndStart('ask rm -rf build');
    await waitFor(() => state(session.id) === 'waiting-on-user');
    await host.handlers['sessions.interrupt']({ sessionId: session.id, content: text('say redirected') });
    await waitFor(() => host.repos.turns.list(session.id).length === 2 && state(session.id) === 'ready');
    const turns = host.repos.turns.list(session.id);
    expect(turns[0]?.stopReason).toBe('cancelled');
    expect(turns[0]?.endCheckpoint).toBeTruthy();
    const decided = host.repos.events.list(session.id).find((e) => e.type === 'permission.decided');
    expect(decided?.type === 'permission.decided' && decided.decision.outcome).toBe('cancelled');
  }, 45_000);

  it('stores agent commands in the timeline and stops one on request (TM-04)', async () => {
    // The script lives in the worktree: on Linux the session is sandboxed and has its own /tmp.
    const live: SessionEvent[] = [];
    host.bus.on('session.event', (e) => live.push(e));
    const { session } = await openAndStart(`edit forever.mjs console.log('serving on 5173'); setInterval(() => {}, 1000);\nrun "${process.execPath}" forever.mjs\nsay after`, 'auto-edit');
    const started = await waitFor(() => host.repos.events.list(session.id).find((e) => e.type === 'command.started'));
    await waitFor(() => live.some((e) => e.type === 'command.output' && e.chunk.includes('serving')));
    const terminalId = started.type === 'command.started' ? started.terminalId : '';
    await expect(host.handlers['sessions.killCommand']({ sessionId: session.id, terminalId })).resolves.toEqual({ killed: true });
    const exited = await waitFor(() => host.repos.events.list(session.id).find((e) => e.type === 'command.exited'));
    expect(exited).toMatchObject({ killed: true, output: expect.stringContaining('serving on 5173') });
    await waitFor(() => state(session.id) === 'ready');
    // Live chunks are not stored; the exit event carries the output.
    expect(host.repos.events.list(session.id).some((e) => e.type === 'command.output')).toBe(false);
    const item = projectSession(host.repos.events.list(session.id)).items.find((i) => i.kind === 'command');
    expect(item).toMatchObject({ running: false, killed: true });
    expect(host.repos.audit.forSession(session.id, 'command.killed')).toHaveLength(1);
  }, 30_000);

  it('read-only profile rejects edits automatically and logs who decided (AP-01)', async () => {
    const { session } = await openAndStart('ask make deploy', 'read-only');
    await waitFor(() => state(session.id) === 'ready');
    const decided = host.repos.events.list(session.id).find((e) => e.type === 'permission.decided');
    expect(decided?.type === 'permission.decided' && decided.decidedBy).toBe('profile:read-only');
  });

  it('refuses Autonomous when the session is not sandboxed (AP-01, CN-05)', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await expect(
      host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text('hi'), permissionProfile: 'autonomous', bringChanges: false, hostSandbox: false }),
    ).rejects.toMatchObject({ code: 'autonomous_requires_sandbox' });
  });

  it('a session that was running when ADE closed becomes Interrupted and can continue', async () => {
    const { session } = await openAndStart('hang');
    await waitFor(() => state(session.id) === 'working');
    await host.dispose();
    host = makeHost();
    expect(state(session.id)).toBe('interrupted');
    expect((await host.handlers['inbox.list']({})).some((i) => i.sessionId === session.id)).toBe(true);
    await host.handlers['sessions.prompt']({ sessionId: session.id, content: text('say back again') });
    await waitFor(() => state(session.id) === 'ready');
  });

  it('runs the workspace setup script and blocks the first prompt when it fails (CN-02)', async () => {
    mkdirSync(join(repo, '.ade'));
    writeFileSync(join(repo, '.ade', 'workspace.yaml'), `setup:\n  - ["${process.execPath.replace(/\\/g, '/')}", "-e", "process.exit(3)"]\n`);
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'setup'], { cwd: repo, env: ID });
    const { session } = await openAndStart('say should not run');
    await waitFor(() => state(session.id) === 'interrupted');
    const inbox = await host.handlers['inbox.list']({});
    expect(inbox.find((i) => i.sessionId === session.id)?.kind).toBe('setup-failed');
    expect(host.repos.turns.list(session.id)).toHaveLength(0);
  });

  it('caps concurrent sessions and starts queued ones when a slot frees (PL-02)', async () => {
    await host.handlers['settings.set']({ key: 'concurrencyCap', value: 1 });
    const { ws, session: a } = await openAndStart('sleep 300\nsay a');
    const b = await host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text('say b'), permissionProfile: 'ask', bringChanges: false });
    expect(b.state).toBe('queued');
    await waitFor(() => state(a.id) === 'ready');
    await waitFor(() => state(b.id) === 'ready');
  });

  it('attributes edits made while the agent is idle to the user (RV-06)', async () => {
    const { session } = await openAndStart('edit a.txt agent');
    await waitFor(() => state(session.id) === 'ready');
    const file = join(session.worktreePath!, 'b.txt');
    await host.handlers['files.write']({ path: file, content: 'mine', expectedMtimeMs: null, sessionId: session.id });
    const changes = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: null });
    expect(changes.find((c) => c.path === 'b.txt')?.editedByUser).toBe(true);
    expect(changes.find((c) => c.path === 'a.txt')?.editedByUser).toBe(false);
  });

  it('detects an external change when saving (ED-01)', async () => {
    await host.handlers['workspace.open']({ path: repo });
    const file = join(repo, 'README.md');
    const read = await host.handlers['files.read']({ path: file });
    writeFileSync(file, 'changed outside\n');
    const fs = await import('node:fs');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const res = await host.handlers['files.write']({ path: file, content: 'mine', expectedMtimeMs: read.mtimeMs });
    expect(res).toEqual({ ok: false, conflict: true });
    await expect(host.handlers['files.read']({ path: join(root, 'outside.txt') })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeedsYouItem, SessionEvent, SessionEventOf } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-loops-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
  });
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
const times = (line: string, n: number) => Array.from({ length: n }, () => line).join('\n');

async function start(prompt: string, profile: 'ask' | 'auto-edit' = 'ask') {
  const ws = await host.handlers['workspace.open']({ path: repo });
  return host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: profile, bringChanges: false });
}

const events = (id: string) => host.repos.events.list(id);
const loops = (id: string) => events(id).filter((e): e is SessionEventOf<'loop.detected'> => e.type === 'loop.detected');
const turnEnded = (id: string) => events(id).find((e): e is SessionEventOf<'turn.ended'> => e.type === 'turn.ended');

describe('WA-10 loop watch with the fake agent', () => {
  it('warns once on repeated reads: event, inbox item and one notification, all cleared when the turn ends', async () => {
    const notes: { title: string; body: string }[] = [];
    host.bus.on('notify', (n) => notes.push(n));
    let inbox: NeedsYouItem[] = [];
    host.bus.on('inbox.changed', (i) => (inbox = i));
    const session = await start(`${times('read README.md', 4)}\nsleep 3000\nsay done`);

    const [found] = await waitFor(() => (loops(session.id).length ? loops(session.id) : null));
    expect(found).toMatchObject({ pattern: 'repeated-action', subject: 'Read README.md', count: 4, level: 'warning', detail: null });
    const turnStarted = events(session.id).find((e) => e.type === 'turn.started');
    expect(turnStarted?.type === 'turn.started' && found!.turnId).toBe(turnStarted?.type === 'turn.started' ? turnStarted.turnId : null);
    // The warning comes straight after the read that reached the limit.
    const all = events(session.id);
    const at = all.findIndex((e) => e.type === 'loop.detected');
    expect(all[at - 1]?.type).toBe('tool.call');

    const items = await host.handlers['inbox.list']({});
    expect(items).toContainEqual(expect.objectContaining({ id: `loop:${session.id}`, kind: 'loop', title: 'Repeated the same step 4 times: Read README.md' }));
    expect(inbox.some((i) => i.kind === 'loop')).toBe(true);
    expect(notes.filter((n) => n.title === 'An agent may be going round in circles')).toEqual([
      { sessionId: session.id, title: 'An agent may be going round in circles', body: expect.stringContaining('Repeated the same step 4 times: Read README.md') },
    ]);

    await waitFor(() => turnEnded(session.id));
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    expect((await host.handlers['inbox.list']({})).some((i) => i.kind === 'loop')).toBe(false);
    expect(inbox.some((i) => i.kind === 'loop')).toBe(false);
  });

  it('"Not a loop" records a dismissal, clears the inbox item and mutes the rest of the turn', async () => {
    const session = await start(`${times('read README.md', 4)}\nsleep 1500\n${times('read README.md', 6)}\nsay done`);
    await waitFor(() => loops(session.id).length > 0);
    await host.handlers['sessions.dismissLoop']({ sessionId: session.id });
    expect(events(session.id).some((e) => e.type === 'loop.dismissed')).toBe(true);
    expect((await host.handlers['inbox.list']({})).some((i) => i.kind === 'loop')).toBe(false);
    await waitFor(() => turnEnded(session.id));
    // Eight or more reads would have been severe; nothing more is recorded after the dismissal.
    expect(loops(session.id)).toHaveLength(1);
  });

  it('stops the turn at the severe level only when the user switched that on', async () => {
    const session = await start(`${times('read README.md', 8)}\nhang`);
    await waitFor(() => loops(session.id).length === 2);
    await new Promise((r) => setTimeout(r, 500));
    expect(loops(session.id).map((l) => l.level)).toEqual(['warning', 'severe']);
    expect(host.repos.sessions.require(session.id).state).toBe('working');
    expect(host.repos.audit.forSession(session.id, 'loop.turn_stopped')).toHaveLength(0);
    await host.handlers['sessions.cancel']({ sessionId: session.id });
    await waitFor(() => turnEnded(session.id));

    await host.handlers['settings.set']({ key: 'loops', value: { enabled: true, stopTurn: true } });
    const notes: string[] = [];
    host.bus.on('notify', (n) => notes.push(n.title));
    const stopped = await start(`${times('read README.md', 8)}\nhang`);
    const ended = await waitFor(() => turnEnded(stopped.id));
    expect(ended.stopReason).toBe('cancelled');
    const notice = events(stopped.id).find((e): e is SessionEventOf<'notice'> => e.type === 'notice' && e.text.startsWith('ADE stopped this turn'));
    expect(notice?.text).toBe(
      'ADE stopped this turn: Repeated the same step 8 times: Read README.md. Nothing was undone; the changes so far are still in the worktree.',
    );
    expect(host.repos.audit.forSession(stopped.id, 'loop.turn_stopped')).toEqual([
      expect.objectContaining({ actor: 'system', detail: { pattern: 'repeated-action', subject: 'Read README.md', count: 8 } }),
    ]);
    expect(notes).toContain('ADE stopped a looping turn');
  });

  it('records nothing when warnings are switched off', async () => {
    await host.handlers['settings.set']({ key: 'loops', value: { enabled: false } });
    const session = await start(`${times('read README.md', 5)}\nsay done`);
    await waitFor(() => turnEnded(session.id));
    expect(loops(session.id)).toEqual([]);
  });

  it('notices a file switched back and forth between versions', async () => {
    const session = await start('edit a.txt one\nedit a.txt two\nedit a.txt one\nedit a.txt two\nsay done', 'auto-edit');
    await waitFor(() => turnEnded(session.id));
    expect(loops(session.id)).toEqual([expect.objectContaining({ pattern: 'edit-ping-pong', subject: 'a.txt', count: 2, level: 'warning' })]);
  });

  it('notices the same command failing, with its exit code, and notifies once for the turn', async () => {
    const notes: string[] = [];
    host.bus.on('notify', (n) => notes.push(n.title));
    const session = await start(`edit fail.mjs process.exit(1)\n${times(`run "${process.execPath}" fail.mjs`, 5)}\nsay done`, 'auto-edit');
    await waitFor(() => turnEnded(session.id), 40_000);
    const found = loops(session.id);
    expect(found.find((l) => l.pattern === 'failing-command')).toMatchObject({ count: 5, detail: 'exit 1', level: 'warning' });
    expect(found.find((l) => l.pattern === 'failing-command')?.subject).toContain('fail.mjs');
    // The fourth identical run is also a repeated step.
    expect(found.find((l) => l.pattern === 'repeated-action')).toMatchObject({ count: 4 });
    expect(notes.filter((t) => t === 'An agent may be going round in circles')).toHaveLength(1);
  }, 60_000);

  it('does not warn about test, edit, test when every edit is new', async () => {
    const rounds = Array.from({ length: 6 }, (_, i) => `edit a.txt v${i}\nread README.md`).join('\n');
    const session = await start(`${rounds}\nsay done`, 'auto-edit');
    await waitFor(() => turnEnded(session.id));
    const all: SessionEvent[] = events(session.id);
    expect(all.filter((e) => e.type === 'loop.detected')).toEqual([]);
  });
});

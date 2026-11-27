import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEventOf } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { LESSONS_START, STANDING_NOTES_HEADING } from '@ade/session-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-lessons-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
  host.repos.settings.set('sandbox.byDefault', false);
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
const open = () => host.handlers['workspace.open']({ path: repo });
const events = (sessionId: string) => host.repos.events.list(sessionId);
const pending = (sessionId: string) => {
  const list = events(sessionId);
  const decided = new Set(list.flatMap((e) => (e.type === 'permission.decided' ? [e.requestId] : [])));
  return list.find((e): e is SessionEventOf<'permission.requested'> => e.type === 'permission.requested' && !decided.has(e.requestId)) ?? null;
};
const idle = (sessionId: string) => waitFor(() => host.repos.sessions.require(sessionId).state === 'ready' && !host.sessions.hasActiveTurn(sessionId) && host.sessions.queued(sessionId).length === 0);
const users = (sessionId: string) => events(sessionId).filter((e): e is SessionEventOf<'user.message'> => e.type === 'user.message');

async function start(workspaceId: string, prompt: string, extra: { lessonIds?: string[] } = {}) {
  return host.handlers['sessions.create']({ workspaceId, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask', bringChanges: false, ...extra });
}

/** One session that asks to run `npm install`, rejected with the note. */
async function rejectWithNote(workspaceId: string, note: string) {
  const s = await start(workspaceId, 'ask npm install\nsay done');
  const req = await waitFor(() => pending(s.id));
  await host.handlers['sessions.answerPermission']({ sessionId: s.id, requestId: req.requestId, optionId: 'reject-once', note });
  await waitFor(() => users(s.id).length === 2);
  await idle(s.id);
  return s.id;
}

describe('ED-05 lessons in the host', () => {
  it('suggests a reject note said in two sessions, listing both occasions; one occasion suggests nothing', async () => {
    const ws = await open();
    const first = await rejectWithNote(ws.id, 'Use pnpm, not npm');
    // The note is sent on as a message marked as a reject note, so it is not counted twice.
    expect(users(first).map((e) => e.origin)).toEqual(['composer', 'reject-note']);
    expect((await host.handlers['lessons.advice']({ workspaceId: ws.id })).suggestions).toEqual([]);
    const second = await rejectWithNote(ws.id, 'Use pnpm, not npm.');
    const { suggestions } = await host.handlers['lessons.advice']({ workspaceId: ws.id });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ text: 'Use pnpm, not npm.', count: 2, sessions: 2, agents: ['fake'] });
    expect(suggestions[0]!.occasions.map((o) => [o.sessionId, o.origin])).toEqual([
      [second, 'reject-note'],
      [first, 'reject-note'],
    ]);
    expect(suggestions[0]!.anchors.map((a) => a.itemKey.startsWith('perm:'))).toEqual([true, true]);

    // Switched off in Settings: no suggestions.
    host.repos.settings.set('lessonAdvice', { enabled: false });
    expect((await host.handlers['lessons.advice']({ workspaceId: ws.id })).suggestions).toEqual([]);
    host.repos.settings.set('lessonAdvice', { enabled: true });

    // Not now hides it; adopting keeps the occasions and the suggestion does not come back.
    await host.handlers['lessons.dismiss']({ workspaceId: ws.id, key: suggestions[0]!.key, forever: false });
    expect((await host.handlers['lessons.advice']({ workspaceId: ws.id })).suggestions).toEqual([]);
    const lesson = await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: suggestions[0]!.key, lesson: { text: 'Use pnpm, not npm', route: 'first-prompt', pattern: 'npm *' } });
    expect(lesson).toMatchObject({ text: 'Use pnpm, not npm', pattern: 'npm *', enabled: true, sent: 0 });
    expect(lesson.occasions).toHaveLength(2);
    expect(await host.handlers['lessons.rehearse']({ workspaceId: ws.id, pattern: 'npm *' })).toMatchObject({ considered: 2, matched: 2 });
    const audit = host.repos.audit.list(ws.id).map((a) => a.action);
    expect(audit).toContain('lessons.adopted');
  }, 90_000);

  it('records interrupts with their origin', async () => {
    const ws = await open();
    const s = await start(ws.id, 'hang');
    await waitFor(() => host.sessions.hasActiveTurn(s.id));
    await host.handlers['sessions.interrupt']({ sessionId: s.id, content: text('say ok') });
    await waitFor(() => users(s.id).length === 2);
    expect(users(s.id).map((e) => e.origin)).toEqual(['composer', 'interrupt']);
    await idle(s.id);
    await host.handlers['sessions.prompt']({ sessionId: s.id, content: text('say comment'), origin: 'review-comment' });
    await waitFor(() => users(s.id).length === 3);
    expect(users(s.id)[2]!.origin).toBe('review-comment');
  }, 60_000);

  it('appends the standing notes to the first prompt after the user\'s words, only for the chosen lessons', async () => {
    const ws = await open();
    const a = await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Use pnpm, not npm', route: 'first-prompt', pattern: null } });
    const b = await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Keep  functions\nsmall', route: 'first-prompt', pattern: null } });
    await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Shared one', route: 'instruction-files', pattern: null } });

    const all = await start(ws.id, 'say hello');
    await waitFor(() => users(all.id).length === 1);
    const content = users(all.id)[0]!.content;
    expect(content[0]).toEqual({ type: 'text', text: 'say hello' });
    expect(content.at(-1)).toEqual({ type: 'text', text: `\n\n${STANDING_NOTES_HEADING}\n- Use pnpm, not npm\n- Keep functions small` });

    const some = await start(ws.id, 'say hello', { lessonIds: [b.id] });
    await waitFor(() => users(some.id).length === 1);
    expect(users(some.id)[0]!.content.at(-1)).toEqual({ type: 'text', text: `\n\n${STANDING_NOTES_HEADING}\n- Keep functions small` });

    const none = await start(ws.id, 'say hello', { lessonIds: [] });
    await waitFor(() => users(none.id).length === 1);
    expect(users(none.id)[0]!.content).toEqual(text('say hello'));

    const list = await host.handlers['lessons.list']({ workspaceId: ws.id });
    expect(list.find((l) => l.id === a.id)).toMatchObject({ sent: 1 });
    expect(list.find((l) => l.id === b.id)).toMatchObject({ sent: 2 });
    expect(list.find((l) => l.id === b.id)!.lastSentAt).not.toBeNull();
    for (const id of [all.id, some.id, none.id]) await idle(id);
  }, 60_000);

  it('adds exactly one "Lesson not followed" notice per turn, counts it, and blocks nothing', async () => {
    const ws = await open();
    await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Use pnpm, not npm', route: 'first-prompt', pattern: 'npm *' } });
    const s = await start(ws.id, 'run npm --version\nrun npm --version\nsay done');
    await idle(s.id);
    const notices = () => events(s.id).filter((e) => e.type === 'notice' && e.text === 'Lesson not followed: Use pnpm, not npm');
    expect(notices()).toHaveLength(1);
    expect(events(s.id).filter((e) => e.type === 'command.started')).toHaveLength(2);
    expect(events(s.id).some((e) => e.type === 'agent.message' && e.text.includes('done'))).toBe(true);

    await host.handlers['sessions.prompt']({ sessionId: s.id, content: text('run npm install\nsay again') });
    await waitFor(() => users(s.id).length === 2);
    await idle(s.id);
    expect(notices()).toHaveLength(2);
    expect((await host.handlers['lessons.list']({ workspaceId: ws.id }))[0]).toMatchObject({ notFollowed: 2 });
  }, 60_000);

  it('writes the instruction-file lessons into AGENTS.md only, says who reads it, and offers CLAUDE.md', async () => {
    const ws = await open();
    writeFileSync(join(repo, 'AGENTS.md'), '# Agents\r\n\r\nRun tests.\r\n');
    writeFileSync(join(repo, 'CLAUDE.md'), '# Claude\n');
    await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Use pnpm, not npm', route: 'instruction-files', pattern: null } });
    const res = await host.handlers['lessons.writeFiles']({ workspaceId: ws.id, alsoClaude: false });
    expect(res).toMatchObject({ changed: ['AGENTS.md'], claudeSeparate: true, lessons: 1 });
    expect(res.readers.sort()).toEqual(['codex', 'opencode']);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\r\n\r\nRun tests.\r\n')).toBe(true);
    expect(agents).toContain(`${LESSONS_START}\r\n`);
    expect(agents).toContain('- Use pnpm, not npm\r\n');
    // Idempotent.
    expect((await host.handlers['lessons.writeFiles']({ workspaceId: ws.id, alsoClaude: false })).changed).toEqual([]);
    const both = await host.handlers['lessons.writeFiles']({ workspaceId: ws.id, alsoClaude: true });
    expect(both).toMatchObject({ changed: ['CLAUDE.md'], claudeSeparate: false });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain('- Use pnpm, not npm\n');
    // Nothing is committed.
    expect((await git(['status', '--porcelain'], { cwd: repo })).trim().split('\n').sort()).toEqual(['?? AGENTS.md', '?? CLAUDE.md']);
  }, 60_000);

  it('redacts secrets in lesson text and refuses the lessons settings through settings.set', async () => {
    const ws = await open();
    const l = await host.handlers['lessons.adopt']({ workspaceId: ws.id, key: 'manual', lesson: { text: 'Never print token=abcdefghijkl1234', route: 'first-prompt', pattern: null } });
    expect(l.text).toBe('Never print token=[redacted]');
    await host.handlers['lessons.save']({ workspaceId: ws.id, lessons: [{ ...l, text: 'Use key sk-ant-abcdefghijklmnopqrstuvwxyz', enabled: false }] });
    expect(await host.handlers['lessons.list']({ workspaceId: ws.id })).toMatchObject([{ text: 'Use key [redacted]', enabled: false }]);
    expect(() => host.handlers['settings.set']({ key: `lessons.${ws.id}`, value: [] })).toThrow();
  }, 30_000);
});

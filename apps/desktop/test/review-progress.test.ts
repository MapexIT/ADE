import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostApi } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { migrate, openDatabase } from '../src/host/db.ts';
import { Repositories } from '../src/host/repositories.ts';
import { classifyReview, reviewedBlob, unreviewedAmong } from '../src/host/review-progress.ts';
import { removeTemp } from './cleanup.ts';

/** A fingerprint whose new side is the digit `n` repeated. */
const fp = (n: string) => `100644 100644 ${'a'.repeat(40)} ${n.repeat(40)}`;

describe('RV-15 classification', () => {
  const current = new Map([
    ['a.ts', fp('1')],
    ['b.ts', fp('2')],
    ['c.ts', fp('3')],
  ]);

  it('classifies files by comparing marks with the current fingerprints, in change-set order', () => {
    const progress = classifyReview(current, [
      { path: 'b.ts', fingerprint: fp('9'), markedAt: 't1' },
      { path: 'a.ts', fingerprint: fp('1'), markedAt: 't2' },
      { path: 'gone.ts', fingerprint: fp('4'), markedAt: 't3' },
    ]);
    expect(progress.files).toEqual([
      { path: 'a.ts', fingerprint: fp('1'), state: 'reviewed', markedAt: 't2' },
      { path: 'b.ts', fingerprint: fp('2'), state: 'changed', markedAt: 't1' },
      { path: 'c.ts', fingerprint: fp('3'), state: 'unreviewed', markedAt: null },
    ]);
    expect(progress).toMatchObject({ reviewed: 1, total: 3 });
  });

  it('handles an empty change set', () => {
    expect(classifyReview(new Map(), [{ path: 'a.ts', fingerprint: fp('1'), markedAt: 't' }])).toEqual({ files: [], reviewed: 0, total: 0 });
  });

  it('reads the reviewed blob and lists unreviewed files among a selection', () => {
    expect(reviewedBlob(fp('7'))).toBe('7'.repeat(40));
    const progress = classifyReview(current, [{ path: 'a.ts', fingerprint: fp('1'), markedAt: 't' }]);
    expect(unreviewedAmong(progress, ['a.ts', 'c.ts', 'unknown.ts'])).toEqual(['c.ts', 'unknown.ts']);
    expect(unreviewedAmong(progress, ['a.ts'])).toEqual([]);
  });
});

describe('RV-15 review marks table', () => {
  it('stores, replaces and removes marks per session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-marks-'));
    const db = openDatabase(join(dir, 'ade.db'));
    try {
      migrate(db);
      const repos = new Repositories(db);
      const ws = repos.workspaces.upsert(dir, 'demo');
      db.run(
        "INSERT INTO sessions (id, workspace_id, agent_id, title, state, base_commit, permission_profile, sandbox_state, created_at) VALUES ('s1', ?, 'fake', 't', 'ready', 'x', 'ask', 'none', 'now')",
        ws.id,
      );
      repos.reviewMarks.set('s1', 'b.ts', fp('1'));
      repos.reviewMarks.set('s1', 'a.ts', fp('2'));
      repos.reviewMarks.set('s1', 'a.ts', fp('3'));
      expect(repos.reviewMarks.list('s1').map((m) => [m.path, m.fingerprint])).toEqual([
        ['a.ts', fp('3')],
        ['b.ts', fp('1')],
      ]);
      expect(repos.reviewMarks.remove('s1', 'a.ts')).toBe(true);
      expect(repos.reviewMarks.remove('s1', 'a.ts')).toBe(false);
      expect(repos.reviewMarks.list('s1').map((m) => m.path)).toEqual(['b.ts']);
      expect(repos.reviewMarks.list('other')).toEqual([]);
    } finally {
      db.close();
      removeTemp(dir);
    }
  });
});

let root: string;
let repo: string;
let host: Host;

const makeHost = () =>
  createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-rp-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  host = makeHost();
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
const ready = (id: string, turns = 1) =>
  waitFor(() => host.repos.sessions.require(id).state === 'ready' && host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns);
const start = async (prompt: string) => {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask' });
  await ready(session.id);
  return session;
};
type Progress = { files: { path: string; fingerprint: string; state: string }[] };
const states = (p: Progress) => Object.fromEntries(p.files.map((f) => [f.path, f.state]));
const entry = (p: Progress, path: string) => ({ path, fingerprint: p.files.find((x) => x.path === path)!.fingerprint });

describe('RV-15 review progress', () => {
  it('follows the reviewed content through later turns, undo and unmarking', async () => {
    const { id } = await start('edit a.txt one');
    const first = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    expect(first).toMatchObject({ reviewed: 0, total: 1, files: [{ path: 'a.txt', state: 'unreviewed', markedAt: null }] });

    const marked = await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(first, 'a.txt')] });
    expect(marked).toMatchObject({ reviewed: 1, total: 1 });
    expect(marked.files[0]!.markedAt).not.toBeNull();

    // A later turn changes the file: changed since review, with a diff of only that change.
    await host.sessions.prompt(id, text('edit a.txt two'));
    await ready(id, 2);
    expect(states(await host.handlers['sessions.reviewProgress']({ sessionId: id }))).toEqual({ 'a.txt': 'changed' });
    expect(await host.handlers['sessions.diffSinceReviewed']({ sessionId: id, path: 'a.txt' })).toEqual({ path: 'a.txt', oldText: 'one', newText: 'two', binary: false });

    // Undoing the turn brings back exactly the reviewed content.
    await host.handlers['sessions.undoTurn']({ sessionId: id, turnIndex: 1 });
    expect(states(await host.handlers['sessions.reviewProgress']({ sessionId: id }))).toEqual({ 'a.txt': 'reviewed' });

    // Unmarking, and marking a path outside the change set, which stores nothing.
    expect(states(await host.handlers['sessions.unmarkReviewed']({ sessionId: id, paths: ['a.txt'] }))).toEqual({ 'a.txt': 'unreviewed' });
    await host.handlers['sessions.markReviewed']({ sessionId: id, files: [{ path: 'nope.txt', fingerprint: first.files[0]!.fingerprint }] });
    expect(host.repos.reviewMarks.list(id)).toEqual([]);
    await expect(host.handlers['sessions.diffSinceReviewed']({ sessionId: id, path: 'a.txt' })).rejects.toMatchObject({ code: 'not_reviewed' });
  }, 40_000);

  it('records the content the user was shown, not the content at click time (AC5)', async () => {
    const { id } = await start('edit a.txt one');
    const shown = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    // The agent changes the file after the list loaded and before the click.
    await host.sessions.prompt(id, text('edit a.txt two'));
    await ready(id, 2);
    const after = await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(shown, 'a.txt')] });
    expect(states(after)).toEqual({ 'a.txt': 'changed' });
  }, 40_000);

  it('handles deletions, and says when the reviewed content is gone', async () => {
    const { id } = await start('delete README.md\nedit b.txt new');
    const p = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    expect(p.files.map((f) => f.path).sort()).toEqual(['README.md', 'b.txt']);
    await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(p, 'README.md')] });
    expect(states(await host.handlers['sessions.reviewProgress']({ sessionId: id }))).toEqual({ 'README.md': 'reviewed', 'b.txt': 'unreviewed' });
    // A deleted file's reviewed content is empty, not missing.
    expect(await host.handlers['sessions.diffSinceReviewed']({ sessionId: id, path: 'README.md' })).toMatchObject({ oldText: '', newText: '' });
    // A mark whose blob Git does not have.
    host.repos.reviewMarks.set(id, 'b.txt', `000000 100644 ${'0'.repeat(40)} ${'e'.repeat(40)}`);
    await expect(host.handlers['sessions.diffSinceReviewed']({ sessionId: id, path: 'b.txt' })).rejects.toMatchObject({ code: 'not_available' });
  }, 40_000);

  it('keeps marks across a restart', async () => {
    const { id } = await start('edit a.txt one');
    const p = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(p, 'a.txt')] });
    await host.dispose();
    host = makeHost();
    expect(states(await host.handlers['sessions.reviewProgress']({ sessionId: id }))).toEqual({ 'a.txt': 'reviewed' });
  }, 40_000);

  it('records the landed files that were not reviewed, and ends the review controls with the session (AC8, AC10)', async () => {
    const { id } = await start('edit a.txt one\nedit b.txt two');
    const p = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(p, 'a.txt')] });
    await host.handlers['sessions.land']({ sessionId: id, mode: 'apply', files: ['a.txt', 'b.txt'] });
    expect(host.repos.audit.forSession(id, 'session.land.apply')[0]!.detail).toMatchObject({ files: ['a.txt', 'b.txt'], unreviewed: ['b.txt'] });
    await expect(host.handlers['sessions.reviewProgress']({ sessionId: id })).rejects.toMatchObject({ code: 'session_ended' });
    await expect(host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(p, 'b.txt')] })).rejects.toMatchObject({ code: 'session_ended' });
    await expect(host.handlers['sessions.unmarkReviewed']({ sessionId: id, paths: ['a.txt'] })).rejects.toMatchObject({ code: 'session_ended' });
  }, 40_000);

  it('records unreviewed files when committing', async () => {
    const { id } = await start('edit a.txt one\nedit b.txt two');
    const p = await host.handlers['sessions.reviewProgress']({ sessionId: id });
    await host.handlers['sessions.markReviewed']({ sessionId: id, files: [entry(p, 'a.txt'), entry(p, 'b.txt')] });
    await host.handlers['sessions.land']({ sessionId: id, mode: 'commit', files: ['a.txt', 'b.txt'], message: 'Land' });
    expect(host.repos.audit.forSession(id, 'session.land.commit')[0]!.detail).toMatchObject({ unreviewed: [] });
  }, 40_000);

  it('works for a session in the checkout (CN-08)', async () => {
    host.repos.settings.set('sessions.runInPlace', true);
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('edit README.md # Agent\nedit added.txt new'), permissionProfile: 'ask', inPlace: true });
    await ready(session.id);
    const p = await host.handlers['sessions.reviewProgress']({ sessionId: session.id });
    expect(p.files.map((f) => f.path).sort()).toEqual(['README.md', 'added.txt']);
    await host.handlers['sessions.markReviewed']({ sessionId: session.id, files: [entry(p, 'README.md')] });
    expect(states(await host.handlers['sessions.reviewProgress']({ sessionId: session.id }))).toEqual({ 'README.md': 'reviewed', 'added.txt': 'unreviewed' });
    await host.handlers['sessions.land']({ sessionId: session.id, mode: 'apply', files: ['README.md', 'added.txt'] });
    expect(host.repos.audit.forSession(session.id, 'session.land.keep')[0]!.detail).toMatchObject({ unreviewed: ['added.txt'] });
  }, 40_000);

  it('rejects malformed input', () => {
    const input = hostApi['sessions.markReviewed'].input;
    expect(input.safeParse({ sessionId: 's', files: [] }).success).toBe(false);
    expect(input.safeParse({ sessionId: 's', files: [{ path: 'a', fingerprint: 'not a fingerprint' }] }).success).toBe(false);
    expect(input.safeParse({ sessionId: 's', files: [{ path: '', fingerprint: fp('1') }] }).success).toBe(false);
    expect(input.safeParse({ sessionId: 's', files: [{ path: 'a', fingerprint: fp('1') }] }).success).toBe(true);
    expect(hostApi['sessions.unmarkReviewed'].input.safeParse({ sessionId: 's', paths: [] }).success).toBe(false);
  });
});

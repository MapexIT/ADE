import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrateTrial, Session } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;
let workspaceId: string;

const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag && i === 0 ? tag : ''}`).join('\n') + '\n';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-int-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'shared.txt'), lines(12));
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
  workspaceId = (await host.handlers['workspace.open']({ path: repo })).id;
});

afterEach(async () => {
  await host.dispose();
  removeTemp(root);
});

function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      const v = await check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(() => void tick(), 20);
    };
    void tick();
  });
}

const text = (t: string) => [{ type: 'text' as const, text: t }];
const ready = (id: string, turns = 1) =>
  waitFor(() => host.repos.sessions.require(id).state === 'ready' && host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns);

/** A ready session whose worktree then gets `files` (path to content), like edits made between turns. */
async function session(title: string, files: Record<string, string>): Promise<Session & { worktreePath: string }> {
  const s = await host.sessions.create({ workspaceId, agentId: 'fake', prompt: text('say ready'), permissionProfile: 'ask', title });
  await ready(s.id);
  const live = host.repos.sessions.require(s.id) as Session & { worktreePath: string };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(live.worktreePath, path), content);
  return live;
}

const status = async (cwd: string) => git(['status', '--porcelain', '--untracked-files=all'], { cwd });
const refs = async (prefix: string) => (await git(['for-each-ref', '--format=%(refname)', prefix], { cwd: repo })).split('\n').filter(Boolean);
const settled = (trialId: string) => waitFor(async () => {
  const t = await host.handlers['integrate.get']({ trialId });
  return t.status !== 'running' && t.status !== 'checking' ? t : null;
}, 60_000);

describe('PL-06 fit matrix', () => {
  it('reads Conflicts, Same files and Fits without changing any worktree or the checkout', async () => {
    const a = await session('A', { 'shared.txt': lines(12, ' from A') });
    const b = await session('B', { 'other.txt': 'other\n' });
    const c = await session('C', { 'shared.txt': lines(12, ' from C') });
    const d = await session('D', { 'shared.txt': lines(12).replace('line 12', 'line 12 from D') });
    const before = await Promise.all([repo, a.worktreePath, b.worktreePath, c.worktreePath, d.worktreePath].map(status));
    const refsBefore = await refs('refs/');

    const o = await host.handlers['integrate.overview']({ workspaceId });
    expect(o.candidates.map((x) => x.title).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(o.candidates.every((x) => x.ready && x.checkout.fit === 'fits')).toBe(true);
    const cell = (x: Session, y: Session) => o.pairs.find((p) => (p.a === x.id && p.b === y.id) || (p.a === y.id && p.b === x.id))!;
    expect(cell(a, c)).toMatchObject({ fit: 'conflicts', files: ['shared.txt'] });
    expect(cell(a, b)).toMatchObject({ fit: 'fits', files: [] });
    expect(cell(a, d)).toMatchObject({ fit: 'same-files', files: ['shared.txt'] });
    expect(o.pairs).toHaveLength(6);

    const after = await Promise.all([repo, a.worktreePath, b.worktreePath, c.worktreePath, d.worktreePath].map(status));
    expect(after).toEqual(before);
    expect(await refs('refs/')).toEqual(refsBefore);
  }, 60_000);

  it('compares sessions on different base commits, and each with the moved checkout', async () => {
    const a = await session('A', { 'shared.txt': lines(12, ' from A') });
    // The checkout moves on: one commit touching another part of shared.txt.
    writeFileSync(join(repo, 'shared.txt'), lines(12).replace('line 6', 'line 6 on main'));
    await git(['commit', '-q', '-am', 'main moves'], { cwd: repo });
    const b = await session('B', { 'b.txt': 'b from B\n' });
    expect(b.baseCommit).not.toBe(a.baseCommit);

    const o = await host.handlers['integrate.overview']({ workspaceId });
    expect(o.pairs).toEqual([expect.objectContaining({ fit: 'fits' })]);
    const byTitle = Object.fromEntries(o.candidates.map((x) => [x.title, x]));
    expect(byTitle.A!.checkout).toEqual({ fit: 'same-files', files: ['shared.txt'], behind: 1 });
    expect(byTitle.B!.checkout).toEqual({ fit: 'fits', files: [], behind: 0 });

    // Now the checkout changes the very line A changed.
    writeFileSync(join(repo, 'shared.txt'), lines(12, ' on main'));
    await git(['commit', '-q', '-am', 'main clashes'], { cwd: repo });
    const o2 = await host.handlers['integrate.overview']({ workspaceId });
    expect(o2.candidates.find((x) => x.title === 'A')!.checkout).toEqual({ fit: 'conflicts', files: ['shared.txt'], behind: 2 });
  }, 60_000);
});

describe('PL-06 trial, resolve and land', () => {
  it('merges in order, stops at the first conflict, keeps refs and removes them with the trial', async () => {
    const a = await session('A', { 'shared.txt': lines(12, ' from A') });
    const b = await session('B', { 'other.txt': 'other\n' });
    const c = await session('C', { 'shared.txt': lines(12, ' from C') });
    const before = await Promise.all([repo, a.worktreePath, b.worktreePath, c.worktreePath].map(status));

    const started = await host.handlers['integrate.trial']({ workspaceId, order: [a.id, c.id, b.id], runChecks: false });
    const t = await settled(started.id);
    expect(t.status).toBe('conflicts');
    expect(t.steps.map((s) => s.status)).toEqual(['fits', 'conflicts', 'skipped']);
    expect(t.steps[1]!.conflicts).toEqual(['shared.txt']);
    expect(t.outOfDate).toBeNull();
    expect(await refs(`refs/ade/integrate/${t.id}/`)).toEqual([`refs/ade/integrate/${t.id}/1`]);
    const merged = await git(['show', `${t.steps[0]!.commit}:shared.txt`], { cwd: repo });
    expect(merged).toContain('line 1 from A');
    expect(await Promise.all([repo, a.worktreePath, b.worktreePath, c.worktreePath].map(status))).toEqual(before);
    expect(host.repos.audit.list(workspaceId).some((e) => e.action === 'integration.trial')).toBe(true);

    // The briefing names the conflict and what A changed; resolving moves C onto A's trial commit.
    const { prompt, onto } = await host.handlers['integrate.resolvePrompt']({ trialId: t.id, sessionId: c.id });
    expect(onto).toBe(t.steps[0]!.commit);
    expect(prompt).toContain('shared.txt');
    expect(prompt).toContain('"A" changed shared.txt');
    await host.handlers['integrate.resolve']({ trialId: t.id, sessionId: c.id, prompt: `${prompt}\nsay adapting` });
    expect(host.repos.sessions.require(c.id).baseCommit).toBe(onto);
    expect(readFileSync(join(c.worktreePath, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    await ready(c.id, 2);
    expect((await host.handlers['integrate.get']({ trialId: t.id })).outOfDate).toMatch(/"C" changed since the trial/);
    expect(host.repos.audit.list(workspaceId).some((e) => e.action === 'integration.resolve')).toBe(true);

    await host.handlers['integrate.cancel']({ trialId: t.id });
    expect(await refs('refs/ade/integrate/')).toEqual([]);
    expect(await host.handlers['integrate.current']({ workspaceId })).toBeNull();
  }, 90_000);

  it('labels a check that passes alone and fails together', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'a'], { cwd: repo });
    const config = host.repos.runs.saveUser({
      workspaceId,
      name: 'both',
      command: ['node', '-e', "const f=require('fs');process.exit(f.readFileSync('a.txt','utf8').includes('A')&&f.readFileSync('b.txt','utf8').includes('B')?1:0)"],
      cwd: '.',
    });
    await host.handlers['checks.saveSettings']({ workspaceId, settings: { configIds: [config.id], afterTurn: false } });
    const a = await session('A', { 'a.txt': 'A\n' });
    const b = await session('B', { 'b.txt': 'B\n' });
    expect((await host.handlers['checks.run']({ sessionId: a.id }))[0]!.exitCode).toBe(0);
    expect((await host.handlers['checks.run']({ sessionId: b.id }))[0]!.exitCode).toBe(0);

    const started = await host.handlers['integrate.trial']({ workspaceId, order: [a.id, b.id], runChecks: true });
    const t = await settled(started.id);
    expect(t.error).toBeNull();
    expect(t.status).toBe('failed');
    expect(t.checks).toEqual([expect.objectContaining({ name: 'both', exitCode: 1, verdict: 'passed-alone-fails-together' })]);
    expect(t.checks[0]!.alone.map((x) => x.result)).toEqual(['passed', 'passed']);
    // The temporary worktree is gone.
    expect((await git(['worktree', 'list', '--porcelain'], { cwd: repo })).match(/^worktree /gm)).toHaveLength(3);

    // Without B's own run, B is "Not run alone" and the verdict is a plain failure.
    const c = await session('C', { 'b.txt': 'B again\n' });
    const t2 = await settled((await host.handlers['integrate.trial']({ workspaceId, order: [a.id, c.id], runChecks: true })).id);
    expect(t2.checks[0]).toMatchObject({ verdict: 'fails', alone: [{ sessionId: a.id, result: 'passed' }, { sessionId: c.id, result: 'not-run' }] });
  }, 120_000);

  it('lands in order after the confirmation, stops at the first failure and audits each session', async () => {
    const a = await session('A', { 'new-a.txt': 'from A\n' });
    const b = await session('B', { 'b.txt': 'b from B\n' });
    const t = await settled((await host.handlers['integrate.trial']({ workspaceId, order: [a.id, b.id], runChecks: false })).id);
    expect(t.status).toBe('fits');

    const preview = await host.handlers['integrate.landPreview']({ trialId: t.id });
    expect(preview.map((p) => [p.title, p.files, p.unreviewed])).toEqual([
      ['A', ['new-a.txt'], ['new-a.txt']],
      ['B', ['b.txt'], ['b.txt']],
    ]);

    // An uncommitted edit in the checkout makes B's apply fail.
    writeFileSync(join(repo, 'b.txt'), 'edited in the checkout\n');
    const res = await host.handlers['integrate.land']({ trialId: t.id, acknowledged: true });
    expect(res.landed).toEqual([a.id]);
    expect(res.failed?.sessionId).toBe(b.id);
    expect(res.notLanded).toEqual([b.id]);
    expect(readFileSync(join(repo, 'new-a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('from A\n');
    expect(host.repos.sessions.require(a.id).state).toBe('landed');
    expect(host.repos.sessions.require(b.id).state).toBe('ready');
    const audit = host.repos.audit.list(workspaceId).filter((e) => e.action === 'integration.landed');
    expect(audit.map((e) => e.sessionId).sort()).toEqual([a.id, b.id].sort());
  }, 90_000);

  it('refuses to land an out-of-date trial (new checkpoint, edited files or a moved checkout)', async () => {
    const a = await session('A', { 'new-a.txt': 'from A\n' });
    const b = await session('B', { 'new-b.txt': 'from B\n' });
    const run = async (): Promise<IntegrateTrial> => settled((await host.handlers['integrate.trial']({ workspaceId, order: [a.id, b.id], runChecks: false })).id);

    let t = await run();
    writeFileSync(join(a.worktreePath, 'new-a.txt'), 'edited after the trial\n');
    await expect(host.handlers['integrate.land']({ trialId: t.id, acknowledged: true })).rejects.toMatchObject({ code: 'out_of_date' });

    t = await run();
    await host.sessions.prompt(b.id, text('say another turn'));
    await ready(b.id, 2);
    expect((await host.handlers['integrate.get']({ trialId: t.id })).outOfDate).toMatch(/"B" changed/);
    await expect(host.handlers['integrate.land']({ trialId: t.id, acknowledged: true })).rejects.toMatchObject({ code: 'out_of_date' });

    t = await run();
    writeFileSync(join(repo, 'later.txt'), 'x\n');
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'later'], { cwd: repo });
    expect((await host.handlers['integrate.get']({ trialId: t.id })).outOfDate).toBe('Your checkout moved to another commit.');
    await expect(host.handlers['integrate.land']({ trialId: t.id, acknowledged: true })).rejects.toMatchObject({ code: 'out_of_date' });
    expect(existsSync(join(repo, 'new-a.txt'))).toBe(false);
  }, 120_000);

  it('removes a trial\'s refs when one of its sessions ends', async () => {
    const a = await session('A', { 'new-a.txt': 'from A\n' });
    const b = await session('B', { 'new-b.txt': 'from B\n' });
    const t = await settled((await host.handlers['integrate.trial']({ workspaceId, order: [a.id, b.id], runChecks: false })).id);
    expect(await refs(`refs/ade/integrate/${t.id}/`)).toHaveLength(2);
    await host.handlers['sessions.discard']({ sessionId: b.id });
    await waitFor(async () => (await refs('refs/ade/integrate/')).length === 0);
    expect((await host.handlers['integrate.get']({ trialId: t.id })).outOfDate).toBe('"B" has ended.');
  }, 60_000);
});

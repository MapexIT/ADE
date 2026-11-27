import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostApi, type Problem } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, draftedCommand, type Host } from '../src/host/app.ts';
import { MIGRATIONS, migrate, openDatabase } from '../src/host/db.ts';
import { Repositories } from '../src/host/repositories.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-term-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
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

describe('SM-11 command history', () => {
  it('searches terminal commands, runs and the commands agents ran', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['history.record']({ workspaceId: ws.id, sessionId: null, command: 'pnpm test --run', cwd: repo, exitCode: 1 });
    await host.handlers['history.record']({ workspaceId: ws.id, sessionId: null, command: 'git status', cwd: repo, exitCode: 0 });
    host.repos.runs.record({ runConfigId: null, sessionId: null, worktreePath: repo, command: ['pnpm', 'test'], startedAt: new Date().toISOString(), endedAt: null, exitCode: 0, output: '' }, ws.id);
    const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: [{ type: 'text', text: 'ask pnpm test:unit' }], permissionProfile: 'ask' });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'waiting-on-user');
    const found = await host.handlers['history.search']({ workspaceId: ws.id, query: 'pnpm test' });
    expect(found.map((e) => [e.source, e.command]).sort()).toEqual([
      ['agent', 'pnpm test:unit'],
      ['run', 'pnpm test'],
      ['terminal', 'pnpm test --run'],
    ]);
    expect(await host.handlers['history.search']({ workspaceId: ws.id, query: '100%' })).toEqual([]);
  }, 30_000);
});

describe('SM-10 drafting a command', () => {
  it('asks an agent read-only and returns the command it proposed', async () => {
    // The folder must be inside an open workspace or worktree.
    await expect(Promise.resolve().then(() => host.handlers['terminal.draftCommand']({ agentId: 'fake', question: 'say echo hello', cwd: repo, shell: 'bash' }))).rejects.toMatchObject({ code: 'forbidden' });
    await host.handlers['workspace.open']({ path: repo });
    const res = await host.handlers['terminal.draftCommand']({ agentId: 'fake', question: 'say echo hello', cwd: repo, shell: 'bash' });
    expect(res).toEqual({ command: 'echo hello', reply: 'echo hello' });
    expect(draftedCommand('Use this:\n```powershell\nPS> Get-Date\n```')).toBe('Get-Date');
  }, 30_000);
});

describe('SM-12 images and SM-13 layouts', () => {
  it('reads images inside a workspace only, and keeps a layout per workspace', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    writeFileSync(join(repo, 'dot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    expect((await host.handlers['files.readImage']({ path: join(repo, 'dot.png') })).dataUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
    await expect(host.handlers['files.readImage']({ path: join(root, 'elsewhere.png') })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(host.handlers['files.readImage']({ path: join(repo, 'README.md') })).rejects.toMatchObject({ code: 'not_image' });

    expect(await host.handlers['layout.get']({ workspaceId: ws.id })).toBeNull();
    const layout = { terminals: [{ kind: 'smart' as const, shell: 'bash', cwd: repo, sessionId: null, title: 'Smart · bash', scrollback: '$ ls\r\nREADME.md\r\n' }], activeIndex: 0, savedAt: new Date().toISOString() };
    await host.handlers['layout.save']({ workspaceId: ws.id, layout });
    expect(await host.handlers['layout.get']({ workspaceId: ws.id })).toEqual(layout);
  });
});

describe('SM-18 problem snapshots', () => {
  const problem = (code: string, line = 1): Problem => ({ tool: 'tsc', severity: 'error', path: 'src/a.ts', inside: true, line, column: 1, code, message: 'm', fingerprint: `tsc|src/a.ts|${code}` });
  const input = (workspaceId: string, over: Partial<Parameters<Host['handlers']['problems.record']>[0]> = {}) => ({
    workspaceId,
    sessionId: null,
    commandKey: 'pnpm typecheck',
    exitCode: 2,
    turnCount: null,
    cut: false,
    problems: [problem('TS1')],
    ...over,
  });

  it('42-45. returns the previous run before storing, and stores nothing for a command that never had a problem', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    expect(await host.handlers['problems.record'](input(ws.id))).toEqual({ previous: null, checkout: null });
    expect(host.repos.problems.count(ws.id, null, 'pnpm typecheck')).toBe(1);
    const second = await host.handlers['problems.record'](input(ws.id, { problems: [problem('TS2', 4)], turnCount: 3 }));
    expect(second.previous).toMatchObject({ commandKey: 'pnpm typecheck', sessionId: null, exitCode: 2, cut: false, problems: [problem('TS1')] });
    expect(second.checkout).toBeNull();
    // `ls`: no problems, no history, nothing stored.
    expect(await host.handlers['problems.record'](input(ws.id, { commandKey: 'ls', problems: [], exitCode: 0 }))).toEqual({ previous: null, checkout: null });
    expect(host.repos.problems.count(ws.id, null, 'ls')).toBe(0);
    // A clean run after one with problems is stored (empty), so the next run compares with it.
    const clean = await host.handlers['problems.record'](input(ws.id, { problems: [], exitCode: 0 }));
    expect(clean.previous?.problems.map((p) => p.code)).toEqual(['TS2']);
    expect(clean.previous?.turnCount).toBe(3);
    expect(host.repos.problems.latest(ws.id, null, 'pnpm typecheck')?.problems).toEqual([]);
  });

  it('46-47. keeps 3 per command and scope; a session sees the checkout of its own workspace only; discard removes its rows', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    for (let i = 0; i < 5; i++) await host.handlers['problems.record'](input(ws.id, { problems: [problem(`TS${i}`)] }));
    expect(host.repos.problems.count(ws.id, null, 'pnpm typecheck')).toBe(3);
    await host.handlers['problems.record'](input('other-workspace', { problems: [problem('TS99')] }));
    const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: [{ type: 'text', text: 'say hi' }], permissionProfile: 'ask' });
    const first = await host.handlers['problems.record'](input(ws.id, { sessionId: session.id }));
    expect(first.previous).toBeNull();
    expect(first.checkout?.problems.map((p) => p.code)).toEqual(['TS4']);
    expect(first.checkout?.sessionId).toBeNull();
    const again = await host.handlers['problems.record'](input(ws.id, { sessionId: session.id }));
    expect(again.previous?.sessionId).toBe(session.id);
    expect(host.repos.problems.count(ws.id, session.id, 'pnpm typecheck')).toBe(2);
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    await host.handlers['sessions.discard']({ sessionId: session.id });
    expect(host.repos.problems.count(ws.id, session.id, 'pnpm typecheck')).toBe(0);
    expect(host.repos.problems.count(ws.id, null, 'pnpm typecheck')).toBe(3);
  }, 30_000);

  it('48. rejects payloads over the limits', () => {
    const schema = hostApi['problems.record'].input;
    const ok = input('w');
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, problems: Array.from({ length: 501 }, () => problem('TS1')) }).success).toBe(false);
    expect(schema.safeParse({ ...ok, commandKey: 'x'.repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ ...ok, commandKey: '  ' }).success).toBe(false);
    expect(schema.safeParse({ ...ok, problems: [{ ...problem('TS1'), message: 'm'.repeat(501) }] }).success).toBe(false);
    expect(schema.safeParse({ ...ok, problems: [{ ...problem('TS1'), tool: 'gradle' }] }).success).toBe(false);
  });

  it('49. the migration runs on a database made by the previous schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-mig-'));
    const db = openDatabase(join(dir, 'ade.db'));
    try {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      MIGRATIONS.slice(0, -1).forEach((sql, i) => {
        db.exec(sql);
        db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', i + 1, 'then');
      });
      db.run("INSERT INTO command_history (id, workspace_id, session_id, command, cwd, exit_code, created_at) VALUES ('h1', NULL, NULL, 'ls', NULL, 0, 'then')");
      expect(migrate(db)).toBe(MIGRATIONS.length);
      const repos = new Repositories(db);
      repos.problems.record({ workspaceId: 'w', sessionId: null, commandKey: 'k', exitCode: 1, turnCount: null, cut: true, problems: [problem('TS1')] });
      expect(repos.problems.latest('w', null, 'k')).toMatchObject({ cut: true, problems: [problem('TS1')] });
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM command_history')?.n).toBe(1);
    } finally {
      db.close();
      removeTemp(dir);
    }
  });
});

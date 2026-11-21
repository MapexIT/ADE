import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, draftedCommand, type Host } from '../src/host/app.ts';

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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { interpreter } from '../src/host/scratch.ts';

const RUNNER = fileURLToPath(new URL('../src/runner-mcp/main.ts', import.meta.url));

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-cr-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY, runnerMcpEntry: RUNNER });
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

describe('CR-07 scratchpad', () => {
  it('writes the snippet to a fresh folder and says whether it is sandboxed', async () => {
    const res = await host.handlers['scratch.prepare']({ language: 'javascript', code: 'console.log(1)' });
    expect(readFileSync(res.file, 'utf8')).toBe('console.log(1)');
    expect(res.file.endsWith('snippet.mjs')).toBe(true);
    if (res.sandboxed) expect(res.command[0]).toBe('bwrap');
    else expect(res.note).toBeTruthy();
    expect(res.command).toContain(res.file);
    const other = await Promise.resolve().then(() => host.handlers['scratch.prepare']({ language: 'python', code: 'print(1)' })).catch((e: { code?: string }) => e);
    if ('code' in other && other.code) expect(other.code).toBe('no_interpreter');
    expect(interpreter('csharp', 'a.cs', { command: 'node', args: [] }, {}, 'linux', () => null)).toBeNull();
    expect(interpreter('typescript', 'a.ts', { command: '/electron', args: [] }, { ELECTRON_RUN_AS_NODE: '1' }, 'linux', () => null)).toEqual({ command: ['/electron', 'a.ts'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const sel = await host.handlers['scratch.write']({ extension: 'py', content: 'print(2)' });
    expect(readFileSync(sel.path, 'utf8')).toBe('print(2)');
  });
});

describe('CR-11 environment sets', () => {
  it('stores names and plain values, never secret values', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['envSets.save']({ workspaceId: ws.id, sets: [{ id: 'local', name: 'Local', vars: [{ name: 'PORT', value: '3000', secret: false }, { name: 'API_KEY', value: 'leaked-if-stored', secret: true }] }] });
    const [set] = await host.handlers['envSets.list']({ workspaceId: ws.id });
    expect(set!.vars).toEqual([
      { name: 'PORT', value: '3000', secret: false },
      { name: 'API_KEY', value: '', secret: true },
    ]);
  });
});

describe('CR-08 runner for agents', () => {
  it('lists and runs configurations over MCP with a structured result, and logs the run', async () => {
    const log = join(root, 'runner.jsonl');
    const configs = [
      { name: 'ok', command: ['node', '-e', "console.log('fine')"], cwd: '.' },
      { name: 'bad', command: ['node', '-e', "console.error('broken'); process.exit(2)"], cwd: '.' },
    ];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [RUNNER],
      env: { ...(process.env as Record<string, string>), ADE_RUNNER_CONFIG: JSON.stringify(configs), ADE_RUNNER_ROOT: repo, ADE_RUNNER_LOG: log },
    });
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(transport);
    try {
      const listed = await client.callTool({ name: 'list_configurations', arguments: {} });
      expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toEqual([
        { name: 'ok', command: "node -e console.log('fine')" },
        { name: 'bad', command: "node -e console.error('broken'); process.exit(2)" },
      ]);
      const bad = await client.callTool({ name: 'run_configuration', arguments: { name: 'bad' } });
      expect(bad.structuredContent).toMatchObject({ name: 'bad', passed: false, exitCode: 2, timedOut: false });
      expect((bad.structuredContent as { output: string }).output).toContain('broken');
      const unknown = await client.callTool({ name: 'run_configuration', arguments: { name: 'nope' } });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
    }
    const logged = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string; exitCode: number });
    expect(logged.map((l) => [l.name, l.exitCode])).toEqual([['bad', 2]]);
  }, 30_000);

  it('gives sessions the runner when the workspace has configurations, and adds its runs to the history', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    host.repos.runs.saveUser({ workspaceId: ws.id, name: 'hello', command: ['node', '-e', '1'], cwd: '.' });
    const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: [{ type: 'text', text: 'mcp' }], permissionProfile: 'ask' });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    const said = host.repos.events.list(session.id).flatMap((e) => (e.type === 'agent.message' ? [e.text] : [])).join(' ');
    expect(said).toContain('ade-runner');
    // Pretend the agent ran a configuration through the tool during its turn; the next turn end ingests it.
    const log = join(root, 'userData', 'runner', `${session.id}.jsonl`);
    writeFileSync(log, `${JSON.stringify({ name: 'hello', command: ['node', '-e', '1'], cwd: '.', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0, output: 'ok' })}\n`);
    await host.sessions.prompt(session.id, [{ type: 'text', text: 'say done' }]);
    await waitFor(() => host.repos.runs.history(ws.id).some((r) => r.sessionId === session.id));
    expect(existsSync(log)).toBe(false);
  }, 30_000);
});

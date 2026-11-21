import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { exportAudit, snippet } from '../src/host/history-search.ts';
import { resolveInstructions } from '../src/host/instruction-files.ts';
import { hoverText, LspService } from '../src/host/lsp.ts';
import { PreviewMcp } from '../src/host/preview-mcp.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FAKE_LSP = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-ed-'));
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

describe('ED-04 instruction files', () => {
  const base = { userFiles: [] as string[], home: '/home/me', codexHome: '/home/me/.codex' };
  it('lists what each agent reads and flags divergence', () => {
    const texts: Record<string, string> = { 'CLAUDE.md': '# Rules\nUse tabs.\n', 'AGENTS.md': '# Rules\nUse spaces.\n' };
    const status = resolveInstructions({ ...base, files: ['CLAUDE.md', 'AGENTS.md', 'packages/a/AGENTS.md'], read: (p) => texts[p] ?? null });
    const files = (id: string) => status.agents.find((a) => a.agentId === id)!.files.map((f) => `${f.scope}:${f.path}`);
    expect(files('claude-code')).toEqual(['project:CLAUDE.md']);
    expect(files('codex')).toEqual(['project:AGENTS.md', 'nested:packages/a/AGENTS.md']);
    expect(files('opencode')).toEqual(['project:AGENTS.md', 'nested:packages/a/AGENTS.md']);
    expect(status.problems[0]).toContain('CLAUDE.md and AGENTS.md differ');
  });

  it('knows the fallbacks: AGENTS.md for Claude Code, CLAUDE.md for OpenCode, and the override for Codex', () => {
    const onlyAgents = resolveInstructions({ ...base, files: ['AGENTS.md', 'AGENTS.override.md'], read: () => 'x' });
    expect(onlyAgents.agents[0]!.files[0]).toMatchObject({ path: 'AGENTS.md', note: 'read because there is no CLAUDE.md' });
    expect(onlyAgents.agents[1]!.files[0]).toMatchObject({ path: 'AGENTS.override.md', note: 'replaces AGENTS.md' });
    expect(onlyAgents.problems.some((p) => p.includes('AGENTS.override.md'))).toBe(true);
    const claudeHome = join('/home/me', '.claude', 'CLAUDE.md');
    const onlyClaude = resolveInstructions({ ...base, files: ['CLAUDE.md'], userFiles: [claudeHome], read: () => '@AGENTS.md' });
    expect(onlyClaude.agents[2]!.files.map((f) => f.path)).toEqual([claudeHome, 'CLAUDE.md']);
    expect(onlyClaude.problems).toContain('Codex reads no project instructions: there is no AGENTS.md (it does not read CLAUDE.md).');
    expect(resolveInstructions({ ...base, files: [], read: () => null }).problems).toEqual(['No agent reads project instructions: there is no CLAUDE.md or AGENTS.md.']);
  });

  it('reads a real repository', async () => {
    writeFileSync(join(repo, 'CLAUDE.md'), 'A');
    writeFileSync(join(repo, 'AGENTS.md'), 'A');
    const ws = await host.handlers['workspace.open']({ path: repo });
    const status = await host.handlers['instructions.status']({ workspaceId: ws.id });
    expect(status.problems.filter((p) => p.includes('differ'))).toEqual([]);
    expect(status.agents.find((a) => a.agentId === 'codex')!.files.some((f) => f.path === 'AGENTS.md')).toBe(true);
  });
});

describe('HI-06 search and HI-07 export', () => {
  it('finds sessions by what was said, with snippets', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: [{ type: 'text', text: 'say The flux capacitor is calibrated.' }], permissionProfile: 'ask' });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    const found = await host.handlers['history.sessions']({ workspaceId: ws.id, query: 'flux capacitor' });
    expect(found).toHaveLength(1);
    expect(found[0]!.matches.map((m) => m.kind).sort()).toEqual(['agent', 'you']);
    expect(found[0]!.matches.find((m) => m.kind === 'agent')!.snippet).toBe('The flux capacitor is calibrated.');
    expect(await host.handlers['history.sessions']({ workspaceId: ws.id, query: 'nowhere to be found' })).toEqual([]);
    expect(snippet('a'.repeat(300) + ' needle ' + 'b'.repeat(300), 'needle', 40)).toMatch(/^…a+ needle b+…$/);
  }, 30_000);

  it('redacts local paths and secrets in the export', () => {
    const json = exportAudit(
      [{ id: '1', ts: 't', workspaceId: 'w', sessionId: null, actor: 'user', action: 'x', detail: { path: 'C:\\Users\\me\\repo\\src\\a.ts', wt: '/data/worktrees/s1/file', note: `token ghp_${'a'.repeat(36)}`, home: 'C:\\Users\\me\\notes.txt' } }],
      { workspace: 'C:\\Users\\me\\repo', userData: '/data', worktrees: ['/data/worktrees/s1'], home: 'C:\\Users\\me' },
    );
    const detail = (JSON.parse(json) as { entries: { detail: Record<string, string> }[] }).entries[0]!.detail;
    expect(detail).toEqual({ path: '<repository>\\src\\a.ts', wt: '<worktree>/file', note: 'token [redacted]', home: '<home>\\notes.txt' });
  });

  it('exports the workspace audit log through the API', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    host.repos.audit.append({ workspaceId: ws.id, sessionId: null, actor: 'user', action: 'test', detail: { where: join(ws.rootPath, 'x.txt') } });
    const out = await host.handlers['audit.export']({ workspaceId: ws.id });
    expect(out.fileName).toMatch(/^ade-audit-repo-\d{4}-\d{2}-\d{2}\.json$/);
    expect(out.content).toContain('<repository>');
    // JSON escapes backslashes, so look for the escaped form.
    expect(out.content).not.toContain(JSON.stringify(ws.rootPath).slice(1, -1));
  });
});

describe('ED-03 language servers', () => {
  it('opens a file, reports diagnostics, hover and definition through a language server', async () => {
    const file = join(repo, 'a.ts');
    writeFileSync(file, 'const bad = 1;\n');
    const lsp = new LspService(() => repo, (name) => (name === 'typescript-language-server' ? FAKE_LSP : null), process.execPath);
    try {
      expect(await lsp.open(join(repo, 'b.unknown'), '')).toEqual({ server: null, reason: 'No language server is known for this kind of file.' });
      expect(await lsp.open(file, 'const bad = 1;\n')).toEqual({ server: 'typescript-language-server', reason: null });
      await waitFor(() => lsp.diagnostics(file).length > 0);
      expect(lsp.diagnostics(file)[0]).toEqual({ line: 0, character: 6, endLine: 0, endCharacter: 9, severity: 'error', message: 'Unknown name "bad".', source: 'fake' });
      lsp.change(file, 'const good = 1;\n');
      await waitFor(() => lsp.diagnostics(file).length === 0);
      expect(await lsp.hover(file, 0, 7)).toEqual({ contents: '**const** answer: number' });
      expect((await lsp.definition(file, 0, 7))[0]).toMatchObject({ line: 2, character: 4 });
    } finally {
      await lsp.dispose();
    }
    const missing = new LspService(() => repo, () => null);
    expect((await missing.open(file, '')).reason).toBe('Install typescript-language-server to get diagnostics, hover and go to definition.');
    expect(hoverText([{ language: 'ts', value: 'x: 1' }, 'doc'])).toBe('```ts\nx: 1\n```\n\ndoc');
  }, 30_000);
});

describe('HI-08 preview tools for agents', () => {
  it('drives the preview over MCP with a per-session token and records screenshots', async () => {
    const calls: string[] = [];
    const shots: [string, string, string][] = [];
    const preview = new PreviewMcp(
      () => ({
        open: async (url) => void calls.push(`open ${url}`),
        screenshot: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
        click: async (s) => void calls.push(`click ${s}`),
        type: async (s, t) => void calls.push(`type ${s} ${t}`),
        text: async () => 'Hello page',
      }),
      join(root, 'shots'),
      (sessionId, url, file) => shots.push([sessionId, url, file]),
    );
    try {
      const spec = await preview.specFor('session-1');
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } }));
      const refused = await client.callTool({ name: 'preview_open', arguments: { url: 'https://example.com' } });
      expect(refused.isError).toBe(true);
      await client.callTool({ name: 'preview_open', arguments: { url: 'http://localhost:5173/' } });
      await client.callTool({ name: 'preview_click', arguments: { selector: '#go' } });
      expect(((await client.callTool({ name: 'preview_text', arguments: {} })).content as { text: string }[])[0]!.text).toBe('Hello page');
      const shot = await client.callTool({ name: 'preview_screenshot', arguments: {} });
      expect((shot.content as { type: string }[])[0]!.type).toBe('image');
      await client.close();
      expect(calls).toEqual(['open http://localhost:5173/', 'click #go']);
      expect(shots[0]!.slice(0, 2)).toEqual(['session-1', 'http://localhost:5173/']);
      // Without the token, nothing.
      const res = await fetch(spec.url, { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    } finally {
      await preview.dispose();
    }
  }, 30_000);
});

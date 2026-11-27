import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { configFrom, draftFrom, statusOf } from '../src/renderer/src/lib/mcp.ts';
import { removeTemp } from './cleanup.ts';

const ECHO = join(__dirname, 'fixtures', 'echo-mcp.mjs');
let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-mcp-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.ade'), { recursive: true });
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(
    join(repo, '.ade', 'workspace.yaml'),
    'mcpServers:\n  - name: repo-docs\n    url: https://mcp.example.com/mcp\n    headers:\n      Authorization: Bearer $ADE_TEST_MISSING_TOKEN\n  - name: repo-echo\n    command: ["node", "echo.mjs"]\n',
  );
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
});

afterEach(async () => {
  await host.dispose();
  removeTemp(root);
});

describe('CO-13 MCP manager', () => {
  it('lists personal, repository and built-in servers with what each is missing, never the values', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['mcp.save']({ original: null, server: { name: 'notes', command: ['node', 'notes.js'], env: { NOTES_KEY: 'literal-secret' } } });
    const { servers, workspaceFile } = await host.handlers['mcp.list']({ workspaceId: ws.id });
    expect(servers.map((s) => [s.source, s.name, s.enabled])).toEqual([
      ['personal', 'notes', true],
      ['workspace', 'repo-docs', true],
      ['workspace', 'repo-echo', true],
      ['built-in', 'ade-runner', true],
      ['built-in', 'ade-preview', true],
      ['built-in', 'shortcut', false],
    ]);
    expect(servers.find((s) => s.name === 'repo-docs')).toMatchObject({ kind: 'http', missing: ['$ADE_TEST_MISSING_TOKEN'], keys: ['Authorization'], editable: false, config: null });
    expect(servers.find((s) => s.name === 'shortcut')?.missing).toEqual(['a Shortcut token']);
    expect(workspaceFile).toMatchObject({ exists: true, error: null });
    // Only personal servers carry their definition (for editing); repository values never leave the host.
    expect(JSON.stringify(servers.filter((s) => s.source !== 'personal'))).not.toContain('Bearer');
  });

  it('adds, edits, switches off and removes personal servers; duplicates are refused', async () => {
    await host.handlers['mcp.save']({ original: null, server: { name: 'a', url: 'https://a.example/mcp', headers: {} } });
    await expect(host.handlers['mcp.save']({ original: null, server: { name: 'a', command: 'x', env: {} } })).rejects.toMatchObject({ code: 'duplicate' });
    await host.handlers['mcp.setEnabled']({ workspaceId: null, source: 'personal', name: 'a', enabled: false });
    await host.handlers['mcp.save']({ original: 'a', server: { name: 'b', url: 'https://b.example/mcp', headers: {} } });
    let { servers } = await host.handlers['mcp.list']({ workspaceId: null });
    // Renaming keeps the switch.
    expect(servers.filter((s) => s.source === 'personal').map((s) => [s.name, s.enabled])).toEqual([['b', false]]);
    await host.handlers['mcp.remove']({ name: 'b' });
    ({ servers } = await host.handlers['mcp.list']({ workspaceId: null }));
    expect(servers.filter((s) => s.source === 'personal')).toEqual([]);
    await expect(host.handlers['mcp.remove']({ name: 'b' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('moves servers from the older YAML setting, and the YAML view keeps switches by name', async () => {
    host.repos.settings.set('mcp.personal', '- name: legacy\n  command: ["node", "legacy.js"]\n');
    expect((await host.handlers['mcp.list']({ workspaceId: null })).servers.find((s) => s.name === 'legacy')).toMatchObject({ source: 'personal', enabled: true });
    await host.handlers['mcp.setEnabled']({ workspaceId: null, source: 'personal', name: 'legacy', enabled: false });
    expect((await host.handlers['mcp.personal']({})).yaml).toContain('legacy');
    await host.handlers['mcp.savePersonal']({ yaml: '- name: legacy\n  command: ["node", "legacy.js"]\n- name: fresh\n  url: https://f.example/mcp\n' });
    const personal = (await host.handlers['mcp.list']({ workspaceId: null })).servers.filter((s) => s.source === 'personal');
    expect(personal.map((s) => [s.name, s.enabled])).toEqual([
      ['legacy', false],
      ['fresh', true],
    ]);
  });

  it('switching servers off keeps them from new sessions; built-in switches are the existing settings', async () => {
    // Only servers that resolve, so no notice is recorded against the made-up session id.
    writeFileSync(join(repo, '.ade', 'workspace.yaml'), 'mcpServers:\n  - name: repo-echo\n    command: ["node", "echo.mjs"]\n');
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['mcp.save']({ original: null, server: { name: 'notes', command: ['node', 'notes.js'], env: {} } });
    await host.handlers['mcp.setEnabled']({ workspaceId: ws.id, source: 'workspace', name: 'repo-echo', enabled: false });
    await host.handlers['mcp.setEnabled']({ workspaceId: ws.id, source: 'built-in', name: 'shortcut', enabled: true });
    expect(host.repos.settings.get('connectors.shareWithAgents', false)).toBe(true);
    let names = (await host.sessions.mcpServersFor(ws.id, 'none')).map((s) => s.name);
    expect(names).toContain('notes');
    expect(names).not.toContain('repo-echo');
    await host.handlers['mcp.setEnabled']({ workspaceId: ws.id, source: 'personal', name: 'notes', enabled: false });
    names = (await host.sessions.mcpServersFor(ws.id, 'none')).map((s) => s.name);
    expect(names).not.toContain('notes');
  });

  it('checks a server by connecting and listing its tools, and reports why one fails', async () => {
    await host.handlers['mcp.save']({ original: null, server: { name: 'echo', command: [process.execPath, ECHO], env: {} } });
    const ok = await host.handlers['mcp.check']({ workspaceId: null, source: 'personal', name: 'echo' });
    expect(ok).toMatchObject({ ok: true, error: null, tools: [{ name: 'echo', description: 'Repeats what it is given.' }] });

    await host.handlers['mcp.save']({ original: null, server: { name: 'broken', command: [process.execPath, ECHO], env: { ECHO_FAIL: '1' } } });
    const bad = await host.handlers['mcp.check']({ workspaceId: null, source: 'personal', name: 'broken' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('refusing to start');

    const ws = await host.handlers['workspace.open']({ path: repo });
    expect(await host.handlers['mcp.check']({ workspaceId: ws.id, source: 'workspace', name: 'repo-docs' })).toMatchObject({ ok: false, error: 'Not set: $ADE_TEST_MISSING_TOKEN.' });
    await expect(host.handlers['mcp.check']({ workspaceId: null, source: 'built-in', name: 'ade-runner' })).rejects.toMatchObject({ code: 'not_supported' });
  }, 40_000);
});

describe('CO-13 MCP form helpers', () => {
  it('turns the form into a server and back', () => {
    const d = draftFrom({ name: 'fs', command: ['npx', '-y', 'server fs'], env: { KEY: '$K' } });
    expect(d).toMatchObject({ kind: 'stdio', command: "npx -y 'server fs'", pairs: [{ key: 'KEY', value: '$K' }] });
    expect(configFrom({ ...d, pairs: [...d.pairs, { key: '', value: '' }] })).toEqual({ ok: true, config: { name: 'fs', command: "npx -y 'server fs'", env: { KEY: '$K' } } });
    expect(configFrom({ ...d, name: 'bad name' })).toEqual({ ok: false, error: 'Use letters, digits, dashes and underscores in the name.' });
    expect(configFrom({ ...draftFrom(null), name: 'x', kind: 'http', url: 'ftp://x' })).toEqual({ ok: false, error: 'Enter an http or https URL.' });
    expect(configFrom({ ...d, pairs: [{ key: 'bad key', value: '1' }] })).toEqual({ ok: false, error: '"bad key" is not a valid variable name.' });
  });

  it('describes status: off, missing, checked, or on', () => {
    const base = { source: 'personal' as const, name: 'a', kind: 'stdio' as const, target: 'x', enabled: true, editable: true, checkable: true, missing: [], keys: [], note: null, config: null };
    expect(statusOf({ ...base, enabled: false }, null).label).toBe('Off');
    expect(statusOf({ ...base, missing: ['$X'] }, null)).toEqual({ label: 'Needs $X', tone: 'attention' });
    expect(statusOf(base, { ok: true, tools: [{ name: 't', description: null }], error: null, ms: 1, checkedAt: '' })).toEqual({ label: 'Connected · 1 tool', tone: 'ok' });
    expect(statusOf(base, null).label).toBe('On · not checked');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { describe, expect, it } from 'vitest';
import { AcpAgentSession, claudeSandbox, codexSandbox, createRuntimes, pickModeForProfile, type AdapterLocator } from '../src/index.ts';

const PROFILES = ['ask', 'read-only', 'auto-edit', 'autonomous'] as const;

describe('agent sandbox pass-through (CN-04, CN-05)', () => {
  it('never picks a Codex preset that switches its sandbox off', () => {
    for (const p of PROFILES) expect(codexSandbox(p, 'linux').env?.INITIAL_AGENT_MODE).not.toBe('agent-full-access');
    expect(codexSandbox('ask', 'linux').env).toEqual({ INITIAL_AGENT_MODE: 'read-only' });
    expect(codexSandbox('auto-edit', 'linux').env).toEqual({ INITIAL_AGENT_MODE: 'workspace-write' });
    expect(codexSandbox('autonomous', 'linux').env).toEqual({ INITIAL_AGENT_MODE: 'agent' });
    const codexModes = ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map((id) => ({ id, name: id, description: null }));
    expect(pickModeForProfile('autonomous', codexModes)).toBe('agent');
  });

  it('claims a sandbox only where it was verified', () => {
    for (const p of PROFILES) {
      expect(codexSandbox(p, 'linux').state).toBe('commands-sandboxed');
      expect(codexSandbox(p, 'win32').state).toBe('not-sandboxed');
      expect(codexSandbox(p, 'darwin').state).toBe('not-sandboxed');
      expect(claudeSandbox(p, 'linux').state).toBe('commands-sandboxed');
      expect(claudeSandbox(p, 'win32')).toEqual({ state: 'not-sandboxed' });
    }
  });

  it('asks Claude Code to fail closed and to ignore the unsandboxed escape', () => {
    expect(claudeSandbox('ask', 'linux').sessionMeta).toEqual({
      claudeCode: { options: { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } } },
    });
  });

  it('reports the badge from the runtime: fake and OpenCode are not sandboxed', () => {
    const runtimes = createRuntimes({ adapterEntry: () => null, nodeCommand: () => ({ command: process.execPath, args: [] }), nodeEnv: () => ({}) } satisfies AdapterLocator, { fakeAgentEntry: FAKE_AGENT_ENTRY });
    expect(runtimes.get('codex')!.sandboxFor('auto-edit', 'linux')).toBe('commands-sandboxed');
    expect(runtimes.get('claude-code')!.sandboxFor('auto-edit', 'win32')).toBe('not-sandboxed');
    expect(runtimes.get('opencode')!.sandboxFor('auto-edit', 'linux')).toBe('not-sandboxed');
    expect(runtimes.get('fake')!.sandboxFor('autonomous', 'linux')).toBe('not-sandboxed');
  });

  it('sends the session _meta on session/new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-meta-'));
    const meta = claudeSandbox('ask', 'linux').sessionMeta!;
    const session = await AcpAgentSession.start({ command: process.execPath, args: [FAKE_AGENT_ENTRY] }, { ...process.env } as Record<string, string>, { cwd: dir, permissionProfile: 'ask', sessionMeta: meta });
    let said = '';
    session.onEvent((e) => {
      if (e.type === 'agent.message.chunk') said += e.text;
    });
    try {
      await session.prompt([{ type: 'text', text: 'meta' }]);
      expect(JSON.parse(said.replace(/^Meta: /, ''))).toEqual(meta);
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

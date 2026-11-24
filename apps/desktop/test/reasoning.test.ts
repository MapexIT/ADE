import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { DEFAULT_SETTINGS } from '@ade/reasoning';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { promptText, reasonedContent, reasoningContext } from '../src/host/reasoning-service.ts';

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-reason-'));
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

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
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
const ended = (id: string, turns: number) => waitFor(() => host.repos.sessions.require(id).state === 'ready' && host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns);
const start = async () => {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('say hi'), permissionProfile: 'ask' });
  await ended(session.id, 1);
  return session;
};
const events = (id: string) => host.repos.events.list(id);
const finished = (id: string) => waitFor(() => events(id).find((e) => e.type === 'reasoning.finished'));
const sent = (id: string) => events(id).flatMap((e) => (e.type === 'user.message' ? [promptText(e.content)] : []));

describe('GN-01 prompt content helpers', () => {
  it('reasons over the words and attached files, and keeps attachments in the turn', () => {
    const content = [
      { type: 'text' as const, text: 'Fix it' },
      { type: 'resource' as const, uri: 'file:///a.ts', name: 'a.ts', text: 'const a = 1;', mimeType: null },
    ];
    expect(promptText(content)).toBe('Fix it');
    expect(reasoningContext(content)).toBe('Fix it\n\nAttached file a.ts:\nconst a = 1;');
    expect(reasonedContent(content, 'new')).toEqual([{ type: 'text', text: 'new' }, content[1]]);
  });
});

describe('GN-01 reasoning methods', () => {
  it('IO sends the prompt exactly as written', async () => {
    const s = await start();
    expect(await host.handlers['sessions.promptReasoned']({ sessionId: s.id, content: text('say plain'), settings: DEFAULT_SETTINGS })).toEqual({ reasoning: false });
    await ended(s.id, 2);
    expect(sent(s.id).at(-1)).toBe('say plain');
    expect(events(s.id).some((e) => e.type === 'reasoning.started')).toBe(false);
  });

  it('CoT adds the step-by-step instruction without extra calls', async () => {
    const s = await start();
    expect(await host.handlers['sessions.promptReasoned']({ sessionId: s.id, content: text('say cot'), settings: { ...DEFAULT_SETTINGS, method: 'cot' } })).toEqual({ reasoning: false });
    await ended(s.id, 2);
    expect(sent(s.id).at(-1)).toMatch(/^say cot\n\nBefore you change anything, think step by step/);
  });

  it('CoT-SC reasons read-only in a throwaway worktree, records each step, then sends the chosen approach', async () => {
    const s = await start();
    const settings = { ...DEFAULT_SETTINGS, method: 'cot-sc' as const, samples: 2 };
    expect(await host.handlers['sessions.promptReasoned']({ sessionId: s.id, content: text('say FINAL APPROACH: patch the parser'), settings })).toEqual({ reasoning: true });
    const done = await finished(s.id);
    expect(done).toMatchObject({ outcome: 'sent', approach: 'patch the parser', calls: 2 });
    await ended(s.id, 2);
    const last = sent(s.id).at(-1)!;
    expect(last.startsWith('say FINAL APPROACH: patch the parser')).toBe(true);
    expect(last).toContain('CoT self-consistency');
    const steps = events(s.id).filter((e) => e.type === 'reasoning.step');
    expect(steps.filter((e) => e.status === 'done').map((e) => e.phase)).toEqual(['sample', 'sample', 'select']);
    // The temporary worktree is gone and the session's own worktree is untouched by reasoning.
    const tmp = join(root, 'userData', 'reasoning-tmp');
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
    expect((await git(['worktree', 'list'], { cwd: repo })).split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('cancelling stops the reasoning agents and sends nothing', async () => {
    const s = await start();
    await host.handlers['sessions.promptReasoned']({ sessionId: s.id, content: text('hang'), settings: { ...DEFAULT_SETTINGS, method: 'got' } });
    await waitFor(() => events(s.id).some((e) => e.type === 'reasoning.step' && e.status === 'running'));
    await expect(host.handlers['sessions.promptReasoned']({ sessionId: s.id, content: text('again'), settings: { ...DEFAULT_SETTINGS, method: 'got' } })).rejects.toMatchObject({ code: 'busy' });
    await host.handlers['sessions.cancel']({ sessionId: s.id });
    expect(await finished(s.id)).toMatchObject({ outcome: 'cancelled' });
    expect(events(s.id).some((e) => e.type === 'notice' && e.text === 'Reasoning was cancelled. Nothing was sent.')).toBe(true);
    expect(sent(s.id)).toEqual(['say hi']);
  });
});

describe('GN-02 composer state and the shared prompt board', () => {
  it('keeps mode and method per session; anything invalid reads as nothing', async () => {
    const s = await start();
    expect(await host.handlers['composer.get']({ sessionId: s.id })).toBeNull();
    const state = { mode: 'board' as const, reasoning: { ...DEFAULT_SETTINGS, method: 'foa' as const, agents: 4 } };
    await host.handlers['composer.save']({ sessionId: s.id, state });
    expect(await host.handlers['composer.get']({ sessionId: s.id })).toEqual(state);
    host.repos.settings.set(`composer.${s.id}`, { mode: 'nope' });
    expect(await host.handlers['composer.get']({ sessionId: s.id })).toBeNull();
  });

  it('keeps one board per workspace, seeded from a session board saved before boards were shared', async () => {
    const s = await start();
    const box = { id: 'b1', title: 'Goal', text: 'Fix the parser', x: 16, y: 16, w: 280, h: 168, selected: true };
    expect(await host.handlers['promptBoard.get']({ workspaceId: s.workspaceId })).toEqual([]);
    // An older per-session composer state that still carries boxes.
    host.repos.settings.set(`composer.${s.id}`, { mode: 'board', reasoning: DEFAULT_SETTINGS, boxes: [box] });
    expect(await host.handlers['promptBoard.get']({ workspaceId: s.workspaceId })).toEqual([box]);
    const moved = { ...box, x: 64, selected: false };
    await host.handlers['promptBoard.save']({ workspaceId: s.workspaceId, boxes: [moved] });
    expect(await host.handlers['promptBoard.get']({ workspaceId: s.workspaceId })).toEqual([moved]);
    await expect((async () => host.handlers['promptBoard.get']({ workspaceId: '00000000-0000-4000-8000-000000000000' }))()).rejects.toThrow('Unknown workspace');
  });
});

describe('GN-01 starting a session with a reasoning method', () => {
  it('reasons about the first prompt once the worktree is ready, then sends it; the composer keeps the method', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const settings = { ...DEFAULT_SETTINGS, method: 'cot-sc' as const, samples: 2 };
    const s = await host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text('say FINAL APPROACH: start reasoned'), permissionProfile: 'ask', reasoning: settings });
    expect(await finished(s.id)).toMatchObject({ outcome: 'sent', approach: 'start reasoned', calls: 2 });
    await ended(s.id, 1);
    const first = sent(s.id)[0]!;
    expect(first.startsWith('say FINAL APPROACH: start reasoned')).toBe(true);
    expect(first).toContain('CoT self-consistency');
    expect(sent(s.id)).toHaveLength(1);
    expect(await host.handlers['composer.get']({ sessionId: s.id })).toEqual({ mode: 'chat', reasoning: settings });
  });

  it('CoT at the start adds the instruction; IO starts as before', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const cot = await host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text('say cot start'), permissionProfile: 'ask', reasoning: { ...DEFAULT_SETTINGS, method: 'cot' } });
    await ended(cot.id, 1);
    expect(sent(cot.id)[0]).toMatch(/^say cot start\n\nBefore you change anything/);
    const io = await host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text('say io start'), permissionProfile: 'ask' });
    await ended(io.id, 1);
    expect(sent(io.id)).toEqual(['say io start']);
  });
});

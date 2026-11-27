import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-cli-'));
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

/** A conversation the fake agent's "CLI" kept for the repository folder, as its transcript file. */
function cliConversation(id: string, cwd: string, title: string) {
  const dir = join(root, 'userData', 'fake-agent');
  mkdirSync(dir, { recursive: true });
  const history = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: title } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer from the CLI' } },
  ];
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ cwd, modeId: 'build', history, title, updatedAt: '2026-11-27T10:00:00Z' }));
}

describe('SR-10 continue a conversation from the agent CLI', () => {
  it('lists the repository’s CLI conversations and continues one in a new worktree with its history', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    cliConversation('cli-1', ws.rootPath, 'Fix the parser');
    cliConversation('elsewhere', join(root, 'other'), 'Not this repository');

    const { sessions: listed } = await host.handlers['sessions.cliList']({ workspaceId: ws.id });
    expect(listed.filter((s) => s.agentId === 'fake').map((s) => [s.sessionId, s.title])).toEqual([['cli-1', 'Fix the parser']]);

    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      title: 'Fix the parser',
      prompt: [{ type: 'text', text: 'say carrying on' }],
      permissionProfile: 'ask',
      bringChanges: false,
      continueFrom: 'cli-1',
    });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready' && host.repos.turns.list(session.id).some((t) => t.endedAt));
    const s = host.repos.sessions.require(session.id);
    expect(s.agentSessionId).toBe('cli-1');
    expect(s.worktreePath).not.toBe(ws.rootPath);
    const events = host.repos.events.list(session.id);
    expect(events.some((e) => e.type === 'agent.message' && e.text === 'Earlier answer from the CLI')).toBe(true);
    expect(events.some((e) => e.type === 'notice' && e.text.startsWith('Continued the conversation from the agent’s CLI.'))).toBe(true);
    expect(events.some((e) => e.type === 'agent.message' && e.text.includes('carrying on'))).toBe(true);

    // Once continued, it is no longer offered.
    const again = await host.handlers['sessions.cliList']({ workspaceId: ws.id });
    expect(again.sessions.some((x) => x.sessionId === 'cli-1')).toBe(false);
  });
});

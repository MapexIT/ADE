import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { expandVars, resolveMcpServers, WorkspaceConfig } from '../src/host/workspace-config.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-par-'));
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

const text = (t: string) => [{ type: 'text' as const, text: t }];
const ready = (id: string, turns = 1) =>
  waitFor(() => host.repos.sessions.require(id).state === 'ready' && host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns);
const messages = (id: string) => host.repos.events.list(id).flatMap((e) => (e.type === 'agent.message' ? [e.text] : []));
const notices = (id: string) => host.repos.events.list(id).flatMap((e) => (e.type === 'notice' ? [e.text] : []));
const start = async (prompt: string) => {
  const ws = await host.handlers['workspace.open']({ path: repo });
  const session = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask' });
  return { ws, session };
};

describe('PL-03 compare and PL-04 overlap', () => {
  it('refuses a compare run with fewer than two different agents', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await expect(host.sessions.compare({ workspaceId: ws.id, agentIds: ['fake', 'fake'], prompt: text('say hi'), permissionProfile: 'ask' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('flags two live sessions that changed the same file, once', async () => {
    const { ws, session: a } = await start('edit shared.txt from a');
    await ready(a.id);
    const b = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('edit shared.txt from b\nedit only-b.txt b'), permissionProfile: 'ask' });
    await ready(b.id);
    await waitFor(() => notices(b.id).some((n) => n.startsWith('Overlap:')));
    expect(notices(a.id).filter((n) => n.startsWith('Overlap:'))).toEqual([`Overlap: "${b.title}" also changed shared.txt. Landing both may conflict.`]);
    const overlaps = await host.handlers['sessions.overlaps']({ workspaceId: ws.id });
    expect(overlaps.map((o) => ({ pair: [o.sessionId, o.otherSessionId].sort(), files: o.files }))).toEqual([{ pair: [a.id, b.id].sort(), files: ['shared.txt'] }]);
    // Another turn on the same file does not repeat the warning.
    await host.sessions.prompt(b.id, text('edit shared.txt again'));
    await ready(b.id, 2);
    expect(notices(b.id).filter((n) => n.startsWith('Overlap:'))).toHaveLength(1);
  }, 40_000);
});

describe('SR-06 fork, SR-07 hand-off, SR-08 detach', () => {
  it('forks a new session from an earlier turn checkpoint', async () => {
    const { ws, session } = await start('edit one.txt first');
    await ready(session.id);
    await host.sessions.prompt(session.id, text('edit two.txt second'));
    await ready(session.id, 2);
    const turn1 = host.repos.turns.byIndex(session.id, 0)!;
    const fork = await host.sessions.create({ workspaceId: ws.id, agentId: 'fake', prompt: text('say forked'), permissionProfile: 'ask', baseRef: turn1.endCheckpoint! });
    await ready(fork.id);
    expect(existsSync(join(fork.worktreePath!, 'one.txt'))).toBe(true);
    expect(existsSync(join(fork.worktreePath!, 'two.txt'))).toBe(false);
  }, 40_000);

  it('hands the worktree to another agent with the last message and the diff', async () => {
    const { session } = await start('edit work.txt half done\nsay I wrote the first half.');
    await ready(session.id);
    // Pretend the first agent was Codex; the fake agent stands in for the receiving agent.
    host.repos.sessions.update(session.id, { agentId: 'codex' });
    await expect(host.sessions.handOff(session.id, 'codex')).rejects.toMatchObject({ code: 'invalid' });
    const after = await host.sessions.handOff(session.id, 'fake', 'Finish the second half.');
    expect(after.agentId).toBe('fake');
    expect(after.worktreePath).toBe(session.worktreePath);
    await ready(session.id, 2);
    const handed = host.repos.events.list(session.id).flatMap((e) => (e.type === 'user.message' ? [e.content.map((b) => ('text' in b ? b.text : '')).join('')] : []))[1]!;
    expect(handed).toContain('continuing work that Codex started');
    expect(handed).toContain('The user says: Finish the second half.');
    expect(handed).toContain('I wrote the first half.');
    expect(handed).toContain('+half done');
    expect(notices(session.id)).toContain('Handed off from Codex to Fake agent.');
    expect(host.repos.audit.forSession(session.id, 'session.handed_off')[0]!.detail).toEqual({ from: 'codex', to: 'fake' });
  }, 40_000);

  it('detaches the agent and reconnects on the next message', async () => {
    const { session } = await start('say first');
    await ready(session.id);
    const { agentSessionId } = await host.handlers['sessions.detach']({ sessionId: session.id });
    expect(agentSessionId).toBeTruthy();
    expect(host.sessions.isLive(session.id)).toBe(false);
    await host.sessions.prompt(session.id, text('say second'));
    await ready(session.id, 2);
    expect(messages(session.id).join(' ')).toContain('second');
    expect(notices(session.id)).toContain('Reconnected to the agent session.');
  }, 40_000);
});

describe('ST-05 shared MCP servers', () => {
  it('expands variables and skips servers whose variables are not set', () => {
    expect(expandVars('Bearer ${TOKEN}-$X', { TOKEN: 't', X: 'x' })).toEqual({ value: 'Bearer t-x', missing: [] });
    const config = WorkspaceConfig.parse({
      mcpServers: [
        { name: 'docs', command: 'node server.js --port 1', env: { KEY: '$ADE_K' } },
        { name: 'remote', url: 'https://mcp.example.invalid/mcp', headers: { Authorization: 'Bearer $NOPE' } },
      ],
    });
    expect(resolveMcpServers(config.mcpServers, { ADE_K: 'v' })).toEqual({
      servers: [{ name: 'docs', command: 'node', args: ['server.js', '--port', '1'], env: { KEY: 'v' } }],
      skipped: [{ name: 'remote', missing: ['NOPE'] }],
    });
  });

  it('gives every session the servers from .ade/workspace.yaml', async () => {
    mkdirSync(join(repo, '.ade'));
    writeFileSync(
      join(repo, '.ade', 'workspace.yaml'),
      'mcpServers:\n  - name: docs\n    command: ["node", "docs-server.js"]\n  - name: remote\n    url: https://mcp.example.invalid/mcp\n    headers:\n      Authorization: Bearer $ADE_TEST_UNSET_VARIABLE\n',
    );
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'mcp'], { cwd: repo });
    const { session } = await start('mcp');
    await ready(session.id);
    expect(messages(session.id).join(' ')).toContain('MCP servers: docs.');
    expect(notices(session.id)).toContain('MCP server "remote" was not passed to the agent: ADE_TEST_UNSET_VARIABLE is not set.');
    expect(readFileSync(join(repo, '.ade', 'workspace.yaml'), 'utf8')).not.toContain('secret');
  }, 40_000);
});

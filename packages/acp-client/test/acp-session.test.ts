import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAgentEnv, createRuntimes, redactSecrets, type AdapterLocator, type AgentEvent, type AgentSession } from '../src/index.ts';

const locator: AdapterLocator = {
  adapterEntry: () => null,
  nodeCommand: () => ({ command: process.execPath, args: [] }),
  nodeEnv: () => ({}),
};

const runtimes = createRuntimes(locator, { fakeAgentEntry: FAKE_AGENT_ENTRY });
const fake = runtimes.get('fake')!;

let dir: string;
let session: AgentSession | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ade-acp-'));
});
afterEach(async () => {
  await session?.close();
  session = null;
  // Windows can hold the folder for a moment after the agent process exits.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const text = (t: string) => [{ type: 'text' as const, text: t }];

async function start(extra: Partial<Parameters<typeof fake.start>[0]> = {}) {
  session = await fake.start({ cwd: dir, permissionProfile: 'ask', baseEnv: { ...process.env, ADE_FAKE_STATE_DIR: join(dir, '.state') }, ...extra });
  const events: AgentEvent[] = [];
  session.onEvent((e) => events.push(e));
  return { session, events };
}

describe('AcpAgentSession with the fake agent', () => {
  it('reads capabilities from initialize and modes from session/new', async () => {
    const { session } = await start();
    expect(session.capabilities.agentName).toBe('ade-fake-agent');
    expect(session.capabilities.loadSession).toBe(true);
    expect(session.modes.map((m) => m.id)).toEqual(['build', 'plan']);
  });

  it('streams a message and ends the turn', async () => {
    const { session, events } = await start();
    await expect(session.prompt(text('scenario message'))).resolves.toBe('end_turn');
    const message = events.filter((e) => e.type === 'agent.message.chunk').map((e) => (e.type === 'agent.message.chunk' ? e.text : '')).join('');
    expect(message).toBe('Hello from the fake agent.');
  });

  it('routes permission requests through the handler', async () => {
    const { session, events } = await start();
    const seen: string[] = [];
    session.onPermissionRequest(async (req) => {
      seen.push(req.detail ?? '');
      return { outcome: 'selected', optionId: req.options.find((o) => o.kind === 'reject_once')!.optionId };
    });
    await session.prompt(text('ask npm test'));
    expect(seen).toEqual(['npm test']);
    expect(events.some((e) => e.type === 'tool.update' && e.status === 'failed')).toBe(true);
  });

  it('cancels a hanging turn and answers pending permissions as cancelled', async () => {
    const { session } = await start();
    let aborted = false;
    session.onPermissionRequest((_req, signal) => new Promise((done) => signal.addEventListener('abort', () => {
      aborted = true;
      done({ outcome: 'cancelled' });
    })));
    const turn = session.prompt(text('ask rm -rf build'));
    await new Promise((r) => setTimeout(r, 200));
    await session.cancel();
    await expect(turn).resolves.toBe('cancelled');
    expect(aborted).toBe(true);
  });

  it('writes files inside the worktree and maps the diff', async () => {
    const { session, events } = await start();
    await session.prompt(text('edit src/a.txt hello'));
    expect(readFileSync(join(dir, 'src', 'a.txt'), 'utf8')).toBe('hello');
    const update = events.find((e) => e.type === 'tool.update' && e.content?.[0]?.type === 'diff');
    expect(update).toBeDefined();
  });

  it('maps a failing prompt to a rejection', async () => {
    const { session } = await start();
    await expect(session.prompt(text('fail boom'))).rejects.toThrow('boom');
  });

  it('switches mode and reports it', async () => {
    const { session, events } = await start();
    await session.setMode('plan');
    expect(session.currentModeId).toBe('plan');
    expect(events.some((e) => e.type === 'mode.changed' && e.modeId === 'plan')).toBe(true);
  });

  it('picks the read-only mode for the read-only profile', async () => {
    const { session } = await start({ permissionProfile: 'read-only' });
    expect(session.currentModeId).toBe('plan');
  });

  it('reloads a session with session/load', async () => {
    const first = await start();
    await first.session.prompt(text('say remembered'));
    const id = first.session.agentSessionId;
    await first.session.close();
    const second = await start({ resumeSessionId: id });
    expect(second.session.agentSessionId).toBe(id);
    // The replay arrives before start() resolves; the host already stores those events, so it ignores them.
    await expect(second.session.prompt(text('say again'))).resolves.toBe('end_turn');
  });

  it('does not pass arbitrary user variables to the agent (CN-06)', async () => {
    const { session, events } = await start({ baseEnv: { ...process.env, ADE_TEST_SECRET_VAR: 'x' } });
    await session.prompt(text('env ADE_TEST_SECRET_VAR'));
    const said = events.map((e) => (e.type === 'agent.message.chunk' ? e.text : '')).join('');
    expect(said).toBe('ADE_TEST_SECRET_VAR is absent.');
  });

  it('reports commands the agent runs through terminal/create as live command events (TM-04)', async () => {
    const script = join(dir, 'count.mjs');
    writeFileSync(script, "for (const n of [1, 2, 3]) console.log('line ' + n);\nconsole.log('ghp_' + 'a'.repeat(36));\nprocess.exit(3);\n");
    const { session, events } = await start();
    await expect(session.prompt(text(`run "${process.execPath}" "${script}"`))).resolves.toBe('end_turn');
    const started = events.find((e) => e.type === 'command.started');
    expect(started?.type === 'command.started' && started.command).toContain('count.mjs');
    const live = events.map((e) => (e.type === 'command.output' ? e.chunk : '')).join('');
    expect(live).toContain('line 3');
    const exited = events.find((e) => e.type === 'command.exited');
    expect(exited).toMatchObject({ type: 'command.exited', exitCode: 3, killed: false });
    expect(exited?.type === 'command.exited' && exited.output).toContain('line 1');
    // Secrets never reach the timeline.
    expect(exited?.type === 'command.exited' && exited.output).not.toContain('ghp_aaaa');
    const tool = events.find((e) => e.type === 'tool.update' && e.content?.some((c) => c.type === 'terminal'));
    expect(tool).toBeTruthy();
  });

  it('stops a running agent command with its process tree (TM-04)', async () => {
    const script = join(dir, 'forever.mjs');
    writeFileSync(script, "console.log('started');\nsetInterval(() => {}, 1000);\n");
    const { session, events } = await start();
    const turn = session.prompt(text(`run "${process.execPath}" "${script}"`));
    const started = await vi.waitFor(
      () => {
        const s = events.find((e) => e.type === 'command.started');
        if (!s || s.type !== 'command.started') throw new Error('not started');
        return s;
      },
      { timeout: 10_000 },
    );
    await expect(session.killCommand(started.terminalId)).resolves.toBe(true);
    await turn;
    const exited = events.find((e) => e.type === 'command.exited');
    expect(exited).toMatchObject({ type: 'command.exited', killed: true });
    await expect(session.killCommand(started.terminalId)).resolves.toBe(false);
  });
});

describe('environment and redaction', () => {
  it('keeps only allow-listed variables', () => {
    const env = buildAgentEnv({ PATH: '/bin', MY_PRIVATE: '1', LC_ALL: 'C', CODEX_HOME: '/x' }, { prefixes: ['CODEX_'] });
    expect(env).toEqual({ PATH: '/bin', LC_ALL: 'C', CODEX_HOME: '/x' });
  });

  it('redacts secrets in env arrays and headers', () => {
    const out = redactSecrets(JSON.stringify({ env: [{ name: 'GITHUB_TOKEN', value: 'abc' }], headers: { Authorization: 'Bearer x' } }));
    expect(out).not.toContain('abc');
    expect(out).not.toContain('Bearer x');
  });
});

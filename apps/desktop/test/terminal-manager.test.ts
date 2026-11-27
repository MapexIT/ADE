import { ptyApi, WatchRule, type CommandBlock, type TerminalInfo, type WatchFired } from '@ade/contracts';
import { describe, expect, it, vi } from 'vitest';
import { TerminalManager, type PtyLike } from '../src/pty/terminal-manager.ts';

class FakePty implements PtyLike {
  static last: FakePty;
  readonly pid = 4242;
  written: string[] = [];
  private dataListeners: ((d: string) => void)[] = [];
  private exitListeners: ((e: { exitCode: number }) => void)[] = [];
  constructor(
    readonly file: string,
    readonly args: string[],
  ) {
    FakePty.last = this;
  }
  onData(l: (d: string) => void) {
    this.dataListeners.push(l);
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exitListeners.push(l);
  }
  emit(d: string) {
    for (const l of this.dataListeners) l(d);
  }
  exit(code: number) {
    for (const l of this.exitListeners) l({ exitCode: code });
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {}
}

const OSC = (b: string) => `\x1b]${b}\x07`;

function setup() {
  const blocks: CommandBlock[] = [];
  const changed: TerminalInfo[] = [];
  const runs: { runId: string; exitCode: number | null; output: string }[] = [];
  const fired: WatchFired[] = [];
  const manager = new TerminalManager((file, args) => new FakePty(file, args), {
    data: () => undefined,
    block: (_id, b) => blocks.push(b),
    exit: () => undefined,
    changed: (i) => changed.push(i),
    runFinished: (runId, exitCode, output) => runs.push({ runId, exitCode, output }),
    watchFired: (f) => fired.push(f),
  });
  return { manager, blocks, changed, runs, fired };
}

const smart = (manager: TerminalManager) => manager.create({ kind: 'smart', shell: 'bash', cwd: '/repo', cols: 80, rows: 24, sessionId: 's1' });
const PROMPT = `${OSC('133;A')}$ ${OSC('133;B')}`;

describe('TerminalManager: watch (SM-19)', () => {
  it('publishes one watchFired when a watched command ends, and clears the watch', () => {
    const { manager, fired, changed } = setup();
    const info = smart(manager);
    FakePty.last.emit(PROMPT);
    manager.watch(info.id, WatchRule.parse({ end: 'fail', match: 'ready' }));
    expect(changed.at(-1)?.watch).toMatchObject({ end: 'fail', match: 'ready' });
    FakePty.last.emit(`${OSC('633;E;node watch.mjs')}${OSC('133;C')}ready on 3000\r\n`);
    FakePty.last.emit(`bye\r\n${OSC('133;D;1')}${PROMPT}`);
    expect(fired.map((f) => [f.reason, f.command, f.exitCode, f.line])).toEqual([
      ['matched', 'node watch.mjs', null, 'ready on 3000'],
      ['failed', 'node watch.mjs', 1, null],
    ]);
    expect(fired[0]?.id).toBe(info.id);
    expect(changed.at(-1)?.watch).toBeNull();
  });

  it('fires quiet from its timer while the command runs', () => {
    vi.useFakeTimers();
    try {
      const { manager, fired } = setup();
      const info = smart(manager);
      FakePty.last.emit(`${PROMPT}${OSC('633;E;npm login')}${OSC('133;C')}Username: `);
      manager.watch(info.id, WatchRule.parse({ end: 'none', quietSeconds: 5 }));
      vi.advanceTimersByTime(4900);
      expect(fired).toHaveLength(0);
      vi.advanceTimersByTime(200);
      expect(fired.map((f) => f.reason)).toEqual(['quiet']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes nothing when the terminal is killed (its pty exits mid-command)', () => {
    vi.useFakeTimers();
    try {
      const { manager, fired } = setup();
      const info = smart(manager);
      FakePty.last.emit(`${PROMPT}${OSC('633;E;sleep 100')}${OSC('133;C')}`);
      manager.watch(info.id, WatchRule.parse({ quietSeconds: 5 }));
      // The real kill() ends the process tree; the fake pty only reports the exit, which is what the manager sees.
      FakePty.last.exit(1);
      vi.advanceTimersByTime(10_000);
      expect(fired).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a plain terminal', () => {
    const { manager } = setup();
    const info = manager.create({ kind: 'plain', shell: 'bash', cwd: '/repo', cols: 80, rows: 24, sessionId: null });
    expect(() => manager.watch(info.id, WatchRule.parse({}))).toThrow(/smart terminal/);
  });
});

describe('TerminalManager: runWhenReady (SM-21)', () => {
  it('writes nothing before the prompt, then the command once when the prompt arrives', async () => {
    const { manager } = setup();
    const info = smart(manager);
    const result = manager.runWhenReady(info.id, 'pnpm test');
    expect(FakePty.last.written).toEqual([]);
    FakePty.last.emit(PROMPT);
    await expect(result).resolves.toEqual({ started: true });
    FakePty.last.emit(PROMPT);
    expect(FakePty.last.written).toEqual(['pnpm test\r']);
  });

  it('writes at once when the shell is idle at its prompt', async () => {
    const { manager } = setup();
    const info = smart(manager);
    FakePty.last.emit(PROMPT);
    await expect(manager.runWhenReady(info.id, 'ls')).resolves.toEqual({ started: true });
    expect(FakePty.last.written).toEqual(['ls\r']);
  });

  it('waits while a command runs', async () => {
    const { manager } = setup();
    const info = smart(manager);
    FakePty.last.emit(`${PROMPT}${OSC('633;E;sleep 5')}${OSC('133;C')}`);
    const result = manager.runWhenReady(info.id, 'ls');
    expect(FakePty.last.written).toEqual([]);
    FakePty.last.emit(`${OSC('133;D;0')}${PROMPT}`);
    await expect(result).resolves.toEqual({ started: true });
    expect(FakePty.last.written).toEqual(['ls\r']);
  });

  it('answers not-smart after the integration grace period and timeout without a prompt', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup();
      const a = smart(manager);
      const fellBack = manager.runWhenReady(a.id, 'ls');
      vi.advanceTimersByTime(6000);
      await expect(fellBack).resolves.toEqual({ started: false, reason: 'not-smart' });

      const b = smart(manager);
      FakePty.last.emit(`${PROMPT}${OSC('633;E;sleep 100')}${OSC('133;C')}`);
      const late = manager.runWhenReady(b.id, 'ls');
      vi.advanceTimersByTime(15_001);
      await expect(late).resolves.toEqual({ started: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers gone after the terminal exits, or when it does not exist', async () => {
    const { manager } = setup();
    const info = smart(manager);
    const result = manager.runWhenReady(info.id, 'ls');
    FakePty.last.exit(0);
    await expect(result).resolves.toEqual({ started: false, reason: 'gone' });
    await expect(manager.runWhenReady('nope', 'ls')).resolves.toEqual({ started: false, reason: 'gone' });
  });

  it('the contract refuses a command with a newline or over 4,000 characters', () => {
    const input = ptyApi['pty.runWhenReady'].input;
    expect(input.safeParse({ id: 't', command: 'a\nb' }).success).toBe(false);
    expect(input.safeParse({ id: 't', command: 'a\rb' }).success).toBe(false);
    expect(input.safeParse({ id: 't', command: 'x'.repeat(4001) }).success).toBe(false);
    expect(input.safeParse({ id: 't', command: 'pnpm test' }).success).toBe(true);
  });
});

describe('TerminalManager', () => {
  it('turns shell-integration output into a failed block (M4 gate)', () => {
    const { manager, blocks } = setup();
    const info = manager.create({ kind: 'smart', shell: 'bash', cwd: '/repo', cols: 80, rows: 24, sessionId: 's1' });
    FakePty.last.emit(`${OSC('133;A')}$ ${OSC('133;B')}${OSC('633;E;npm test')}${OSC('133;C')}1 failing\r\n${OSC('133;D;1')}`);
    const done = blocks.filter((b) => b.endedAt !== null);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ command: 'npm test', exitCode: 1 });
    expect(manager.blocks(info.id)).toHaveLength(1);
  });

  it('marks an agent terminal as waiting on a notification and finished on exit (SM-04)', () => {
    const { manager, changed } = setup();
    manager.create({ kind: 'agent-ui', cwd: '/repo', cols: 80, rows: 24, sessionId: 's1', command: ['node', 'agent.js'] });
    FakePty.last.emit(`thinking...${OSC('9;Claude needs your permission')}`);
    expect(changed.at(-1)?.agentState).toBe('waiting');
    FakePty.last.emit('more output');
    expect(changed.at(-1)?.agentState).toBe('working');
    FakePty.last.exit(0);
    expect(changed.at(-1)?.agentState).toBe('finished');
  });

  it('reports a run with its exit code and plain output (CR-03)', () => {
    const { manager, runs } = setup();
    manager.run({ command: ['node', '-e', 'x'], cwd: '/repo', sessionId: null, runId: 'r1' });
    expect(FakePty.last.args).toEqual(['-e', 'x']);
    FakePty.last.emit('\x1b[32mok\x1b[0m\r\n');
    FakePty.last.exit(2);
    expect(runs).toEqual([{ runId: 'r1', exitCode: 2, output: 'ok\r\n' }]);
  });

  it('falls back to plain when the shell never reports integration (SM-02)', () => {
    vi.useFakeTimers();
    try {
      const { manager, changed } = setup();
      manager.create({ kind: 'smart', shell: 'bash', cwd: '/repo', cols: 80, rows: 24, sessionId: null });
      FakePty.last.emit('$ ');
      vi.advanceTimersByTime(6000);
      expect(changed.at(-1)?.smart).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

import type { CommandBlock, TerminalInfo } from '@ade/contracts';
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
  const manager = new TerminalManager((file, args) => new FakePty(file, args), {
    data: () => undefined,
    block: (_id, b) => blocks.push(b),
    exit: () => undefined,
    changed: (i) => changed.push(i),
    runFinished: (runId, exitCode, output) => runs.push({ runId, exitCode, output }),
  });
  return { manager, blocks, changed, runs };
}

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

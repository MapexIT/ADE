import type { CommandBlock, TerminalInfo } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { AUTO_WATCH_MS, autoWatchTargets } from '../src/renderer/src/lib/auto-watch.ts';

const term = (id: string, patch: Partial<TerminalInfo & { exited: boolean }> = {}): TerminalInfo & { exited: boolean } => ({
  id,
  kind: 'smart',
  shell: 'bash',
  cwd: '/repo',
  sessionId: null,
  title: id,
  pid: 1,
  smart: true,
  agentState: 'none',
  watch: null,
  exited: false,
  ...patch,
});
const running = (id: string, startedAt: number, command = 'pnpm test'): CommandBlock => ({ id, command, cwd: null, startedAt, endedAt: null, exitCode: null, output: '', truncated: false });

describe('autoWatchTargets (SM-19)', () => {
  const now = 100_000;
  const opts = { active: 'a', focused: true, now, done: new Set<string>() };

  it('watches a command that has run 30 seconds in a terminal that is not on screen', () => {
    const terminals = { a: term('a'), b: term('b') };
    const blocks = { a: [running('a1', 0)], b: [running('b1', now - AUTO_WATCH_MS)] };
    expect(autoWatchTargets(terminals, blocks, opts)).toEqual([{ terminalId: 'b', blockId: 'b1' }]);
  });

  it('also watches the active terminal while the window is not focused', () => {
    expect(autoWatchTargets({ a: term('a') }, { a: [running('a1', 0)] }, { ...opts, focused: false })).toHaveLength(1);
  });

  it('skips young commands, watched, plain, agent and exited terminals, and blocks already handled', () => {
    const terminals = {
      young: term('young'),
      watched: term('watched', { watch: { end: 'fail', quietSeconds: null, match: null, auto: false } }),
      plain: term('plain', { kind: 'plain', smart: false }),
      agent: term('agent', { kind: 'agent-ui' }),
      gone: term('gone', { exited: true }),
      done: term('done'),
    };
    const blocks = {
      young: [running('y1', now - AUTO_WATCH_MS + 1)],
      watched: [running('w1', 0)],
      plain: [running('p1', 0)],
      agent: [running('g1', 0)],
      gone: [running('x1', 0)],
      done: [running('d1', 0)],
    };
    expect(autoWatchTargets(terminals, blocks, { ...opts, done: new Set(['d1']) })).toEqual([]);
  });
});

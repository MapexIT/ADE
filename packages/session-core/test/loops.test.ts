import type { NewSessionEvent, SessionEvent, ToolContent, ToolKind, ToolStatus } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyLoop,
  contentHash,
  emptyLoopState,
  LOOP_LIMITS,
  loopBody,
  loopRedirect,
  loopTitle,
  type LoopFinding,
  type LoopState,
} from '../src/loops.ts';

let seq = 0;
const ev = (e: DistributiveNew): SessionEvent =>
  ({ ...e, sessionId: 's1', seq: seq++, ts: new Date(Date.parse('2026-11-24T10:00:00Z') + seq * 1000).toISOString() }) as SessionEvent;
type DistributiveNew = NewSessionEvent extends infer T ? (T extends unknown ? Omit<T, 'sessionId'> : never) : never;

let ids = 0;
const call = (kind: ToolKind, title: string, locations: string[] = [], status: ToolStatus = 'pending', content: ToolContent[] = [], id = `c${ids++}`) =>
  ev({ type: 'tool.call', toolCallId: id, title, kind, status, content, locations });
const update = (id: string, status: ToolStatus | null, content: ToolContent[] | null = null) =>
  ev({ type: 'tool.update', toolCallId: id, title: null, status, content });
const read = (path: string) => call('read', `Read ${path}`, [path]);
/** An edit the way the fake agent reports it: a call, then a completed update with the diff. */
const edit = (path: string, oldText: string | null, newText: string): SessionEvent[] => {
  const id = `e${ids++}`;
  return [
    call('edit', `Edit ${path}`, [path], 'in_progress', [], id),
    update(id, 'completed', [{ type: 'diff', path, oldText, newText }]),
  ];
};
const started = (turnId = 't1') => ev({ type: 'turn.started', turnId, index: 0 });
const ended = (turnId = 't1') => ev({ type: 'turn.ended', turnId, stopReason: 'end_turn', usage: null });
const cmdStart = (terminalId: string, command: string) => ev({ type: 'command.started', terminalId, command, cwd: '/w' });
const cmdExit = (terminalId: string, exitCode: number | null, killed = false) =>
  ev({ type: 'command.exited', terminalId, exitCode, signal: null, output: '', truncated: false, killed });

/** Folds the events and returns the final state and every finding with the index of the event that raised it. */
function run(events: SessionEvent[], from: LoopState = emptyLoopState()) {
  let state = from;
  const found: (LoopFinding & { at: number })[] = [];
  events.forEach((e, at) => {
    const r = applyLoop(state, e);
    state = r.state;
    found.push(...r.findings.map((f) => ({ ...f, at })));
  });
  return { state, found };
}

describe('applyLoop: repeated action', () => {
  it('warns on the fourth identical read, stays quiet until the eighth, then reports severe', () => {
    const events = [started(), ...Array.from({ length: 8 }, () => read('README.md'))];
    const { found } = run(events);
    expect(found).toEqual([
      { pattern: 'repeated-action', subject: 'Read README.md', count: 4, level: 'warning', detail: null, at: 4 },
      { pattern: 'repeated-action', subject: 'Read README.md', count: 8, level: 'severe', detail: null, at: 8 },
    ]);
  });

  it('catches a cycle that is not consecutive (A, B, A, B, ...)', () => {
    const events = [started(), read('a'), read('b'), read('a'), read('b'), read('a'), read('b'), read('a')];
    const { found } = run(events);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ subject: 'Read a', count: 4, at: 7 });
    // b has reached 3 so far; its fourth read reports it too.
    const again = run([...events, read('b')]);
    expect(again.found.map((f) => f.subject)).toEqual(['Read a', 'Read b']);
  });

  it('never fires for test, edit, test, edit when every edit makes new content', () => {
    const events = [started()];
    for (let i = 0; i < 6; i++) events.push(call('execute', 'Run npm test'), ...edit('a.ts', i === 0 ? null : `v${i - 1}`, `v${i}`));
    expect(run(events).found).toEqual([]);
  });

  it('forgets actions that fell out of the 30-action window', () => {
    const events = [started()];
    for (let round = 0; round < 4; round++) {
      events.push(read('README.md'));
      for (let i = 0; i < LOOP_LIMITS.window; i++) events.push(read(`other-${round}-${i}`));
    }
    expect(run(events).found).toEqual([]);
  });

  it('counts an edit that changes nothing as a repeated step', () => {
    const events = [started(), ...edit('a.ts', 'x', 'y')];
    for (let i = 0; i < 4; i++) events.push(...edit('a.ts', 'y', 'y'));
    const { found } = run(events);
    expect(found).toEqual([expect.objectContaining({ pattern: 'repeated-action', subject: 'Edit a.ts', count: 4 })]);
  });

  it('treats edits without diffs by title and locations: a first edit is progress, repeats count', () => {
    const noDiff = () => {
      const id = `n${ids++}`;
      return [call('edit', 'Edit b.ts', ['b.ts'], 'in_progress', [], id), update(id, 'completed')];
    };
    // Reads interleaved with a first-time edit: the edit clears the window.
    const first = run([started(), read('x'), read('x'), read('x'), ...noDiff(), read('x'), read('x'), read('x')]);
    expect(first.found).toEqual([]);
    const repeated = run([started(), ...noDiff(), ...noDiff(), ...noDiff(), ...noDiff()]);
    expect(repeated.found).toEqual([expect.objectContaining({ subject: 'Edit b.ts', count: 4, level: 'warning' })]);
  });

  it('ignores think and switch_mode calls', () => {
    const events = [started()];
    for (let i = 0; i < 10; i++) events.push(call('think', 'Thinking'), call('switch_mode', 'Plan'));
    expect(run(events).found).toEqual([]);
    expect(run(events).state.recent).toEqual([]);
  });
});

describe('applyLoop: edit ping-pong', () => {
  it('reports a file going back to an earlier version twice, without clearing the window', () => {
    const events = [
      started(),
      read('README.md'),
      ...edit('a.txt', null, 'one'),
      read('README.md'),
      ...edit('a.txt', 'one', 'two'),
      read('README.md'),
      ...edit('a.txt', 'two', 'one'),
      read('README.md'),
      ...edit('a.txt', 'one', 'two'),
    ];
    const { found, state } = run(events);
    expect(found).toEqual([
      { pattern: 'edit-ping-pong', subject: 'a.txt', count: 2, level: 'warning', detail: null, at: events.length - 1 },
    ]);
    // The two returning edits did not count as progress: the reads after the second novel edit are still counted.
    expect(state.recent.filter((r) => r.startsWith('read|'))).toHaveLength(2);
    expect(state.files['a.txt']?.returns).toBe(2);
  });

  it('reports severe at four returns', () => {
    const events = [started(), ...edit('a', 'one', 'two')];
    for (let i = 0; i < 4; i++) events.push(...edit('a', i % 2 ? 'one' : 'two', i % 2 ? 'two' : 'one'));
    expect(run(events).found.map((f) => [f.count, f.level])).toEqual([
      [2, 'warning'],
      [4, 'severe'],
    ]);
  });

  it('treats a delete without a diff as the file becoming absent', () => {
    const del = (path: string) => call('delete', `Delete ${path}`, [path], 'completed');
    const events = [started(), ...edit('c.txt', null, 'x'), del('c.txt'), ...edit('c.txt', null, 'x'), del('c.txt')];
    expect(run(events).found).toEqual([expect.objectContaining({ pattern: 'edit-ping-pong', subject: 'c.txt', count: 2 })]);
  });
});

describe('applyLoop: failing command', () => {
  it('reports the fifth failure of the same command, with the last exit code', () => {
    const events = [started()];
    for (let i = 0; i < 5; i++) events.push(cmdStart(`t${i}`, 'npm   test'), cmdExit(`t${i}`, 1));
    expect(run(events).found).toEqual([
      { pattern: 'failing-command', subject: 'npm test', count: 5, level: 'warning', detail: 'exit 1', at: events.length - 1 },
    ]);
  });

  it('resets on a success and does not count commands the user killed', () => {
    const events = [started()];
    for (let i = 0; i < 4; i++) events.push(cmdStart(`a${i}`, 'npm test'), cmdExit(`a${i}`, 1));
    events.push(cmdStart('ok', 'npm test'), cmdExit('ok', 0));
    for (let i = 0; i < 4; i++) events.push(cmdStart(`b${i}`, 'npm test'), cmdExit(`b${i}`, 2));
    events.push(cmdStart('k', 'npm test'), cmdExit('k', null, true));
    const { found, state } = run(events);
    expect(found).toEqual([]);
    expect(state.failures['npm test']).toEqual({ count: 4, last: 'exit 2' });
  });

  it('keeps counting failures across edits that make progress', () => {
    const events = [started()];
    for (let i = 0; i < 5; i++) events.push(cmdStart(`t${i}`, 'make'), cmdExit(`t${i}`, 2), ...edit('m.c', i ? `v${i - 1}` : null, `v${i}`));
    expect(run(events).found).toEqual([expect.objectContaining({ pattern: 'failing-command', subject: 'make', count: 5, detail: 'exit 2' })]);
  });

  it('counts a failed execute call without a terminal, and leaves calls with one to command.exited', () => {
    const plain = [started()];
    for (let i = 0; i < 5; i++) {
      const id = `x${ids++}`;
      plain.push(call('execute', 'Run cargo build', [], 'in_progress', [], id), update(id, 'failed'));
    }
    const p = run(plain);
    expect(p.found.filter((f) => f.pattern === 'failing-command')).toEqual([
      expect.objectContaining({ subject: 'Run cargo build', count: 5, detail: 'failed' }),
    ]);

    // The fake agent's `run`: call, command.started, terminal content, command.exited, then a failed update.
    const viaTerminal = [started()];
    for (let i = 0; i < 5; i++) {
      const id = `y${ids++}`;
      viaTerminal.push(
        call('execute', 'Run node fail.mjs', [], 'in_progress', [], id),
        cmdStart(`term${i}`, 'node fail.mjs'),
        update(id, null, [{ type: 'terminal', terminalId: `term${i}` }]),
        cmdExit(`term${i}`, 1),
        update(id, 'failed'),
      );
    }
    const t = run(viaTerminal);
    expect(t.found.filter((f) => f.pattern === 'failing-command')).toEqual([
      expect.objectContaining({ subject: 'node fail.mjs', count: 5, detail: 'exit 1' }),
    ]);
    expect(t.state.failures['Run node fail.mjs']).toBeUndefined();
    // The fourth identical run also counts as a repeated step.
    expect(t.found.filter((f) => f.pattern === 'repeated-action')).toEqual([expect.objectContaining({ count: 4 })]);
  });

  it('treats a call that arrives already finished in the same step', () => {
    const events = [started()];
    for (let i = 0; i < 5; i++) events.push(call('execute', 'Run lint', [], 'failed'));
    expect(run(events).found.some((f) => f.pattern === 'failing-command' && f.count === 5)).toBe(true);
  });
});

describe('applyLoop: turns and dismissal', () => {
  it('mutes the rest of the turn after loop.dismissed; the next turn starts fresh', () => {
    const events = [started('t1'), read('a'), read('a'), ev({ type: 'loop.dismissed', turnId: 't1' })];
    for (let i = 0; i < 6; i++) events.push(read('a'));
    expect(run(events).found).toEqual([]);
    const next = run([...events, ended('t1'), started('t2'), read('a'), read('a'), read('a'), read('a')]);
    expect(next.found).toEqual([expect.objectContaining({ count: 4, level: 'warning' })]);
  });

  it('ignores a dismissal for another turn', () => {
    const events = [started('t1'), ev({ type: 'loop.dismissed', turnId: 'old' }), read('a'), read('a'), read('a'), read('a')];
    expect(run(events).found).toHaveLength(1);
  });

  it('ignores events outside a turn and clears everything when the turn ends', () => {
    const outside = [read('a'), read('a'), read('a'), read('a'), read('a')];
    const r = run(outside);
    expect(r.found).toEqual([]);
    expect(r.state).toEqual(emptyLoopState());
    const ended1 = run([started(), read('a'), read('a'), cmdStart('t', 'x'), cmdExit('t', 1), ended()]);
    expect(ended1.state).toEqual(emptyLoopState());
  });
});

describe('applyLoop: purity and bounds', () => {
  it('does not change its input', () => {
    const { state } = run([started(), read('a'), ...edit('f', null, 'x')]);
    const snapshot = structuredClone(state);
    applyLoop(state, read('a'));
    applyLoop(state, ev({ type: 'loop.dismissed', turnId: 't1' }));
    expect(state).toEqual(snapshot);
  });

  it('keeps every map within its cap', () => {
    const events = [started()];
    for (let i = 0; i < 260; i++) {
      events.push(...edit(`f${i}`, null, 'x'), cmdStart(`t${i}`, `cmd ${i}`), cmdExit(`t${i}`, 1));
      events.push(call('execute', `Run ${i}`));
    }
    const { state } = run(events);
    expect(Object.keys(state.tools).length).toBeLessThanOrEqual(200);
    expect(Object.keys(state.files).length).toBeLessThanOrEqual(200);
    expect(Object.keys(state.failures).length).toBeLessThanOrEqual(100);
    expect(Object.keys(state.commands).length).toBeLessThanOrEqual(100);
    expect(state.recent.length).toBeLessThanOrEqual(LOOP_LIMITS.window);
    expect(Object.keys(state.titles).length).toBeLessThanOrEqual(LOOP_LIMITS.window * 2);
  });

  it('caps the hashes kept per file at 32', () => {
    const events = [started()];
    for (let i = 0; i < 50; i++) events.push(...edit('a', i ? `v${i - 1}` : null, `v${i}`));
    expect(run(events).state.files['a']?.seen).toHaveLength(32);
  });

  it('cuts long titles at 300 characters', () => {
    const long = `Read ${'x'.repeat(400)}`;
    const events = [started(), ...Array.from({ length: 4 }, () => call('read', long))];
    expect(run(events).found[0]?.subject).toHaveLength(300);
  });
});

describe('loop copy', () => {
  it('says what was counted, in the agreed words', () => {
    const repeated = { pattern: 'repeated-action', subject: 'Read README.md', count: 4, detail: null } as const;
    const failing = { pattern: 'failing-command', subject: 'npm test', count: 5, detail: 'exit 1' } as const;
    const pingPong = { pattern: 'edit-ping-pong', subject: 'a.txt', count: 2, detail: null } as const;
    expect(loopTitle(repeated)).toBe('Repeated the same step 4 times: Read README.md');
    expect(loopTitle(failing)).toBe('The same command has failed 5 times: npm test');
    expect(loopTitle(pingPong)).toBe('a.txt keeps going back to an earlier version');
    expect(loopBody(repeated)).toBe('The agent reported no new edit in between.');
    expect(loopBody(failing)).toBe('Last result: exit 1.');
    expect(loopBody({ ...failing, detail: null })).toBe('');
    expect(loopBody(pingPong)).toBe('Its content returned to a version from this turn 2 times.');
    expect(loopRedirect(repeated)).toBe(
      'You have repeated the same step 4 times without changing anything: Read README.md. Stop repeating it. Say what you learnt from it and what is blocking you, then try a different approach.',
    );
    expect(loopRedirect(failing)).toBe(
      '`npm test` has failed 5 times in this turn. Stop re-running it. Explain the root cause of the failure first, then make one fix before you run it again.',
    );
    expect(loopRedirect(pingPong)).toBe(
      'You keep switching a.txt between the same versions. Stop editing it. Say which version is right and why, then make that change once.',
    );
  });

  it('hashes content stably and tells different text apart', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}:0$/);
  });
});

import type { NewSessionEvent, SessionEvent } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { activityFrom, applyActivity, emptyActivity, phaseTotals, rateBuckets } from '../src/observe.ts';

const T0 = Date.parse('2026-11-22T10:00:00.000Z');
let seq = 0;
const ev = (secs: number, e: NewSessionEvent): SessionEvent =>
  ({ ...e, sessionId: 's1', seq: seq++, ts: new Date(T0 + secs * 1000).toISOString() }) as SessionEvent;

const turn = [
  ev(0, {
    sessionId: 's1',
    type: 'user.message',
    content: [{ type: 'text', text: 'Fix the failing test' }],
    queued: false,
  }),
  ev(1, { sessionId: 's1', type: 'turn.started', turnId: 't1', index: 0 }),
  ev(2, { sessionId: 's1', type: 'agent.thought.chunk', messageId: 'm0', text: 'Let me look' }),
  ev(3, {
    sessionId: 's1',
    type: 'tool.call',
    toolCallId: 'c1',
    title: 'Read app.ts',
    kind: 'read',
    status: 'in_progress',
    content: [],
    locations: ['src/app.ts'],
  }),
  ev(4, {
    sessionId: 's1',
    type: 'tool.update',
    toolCallId: 'c1',
    title: null,
    status: 'completed',
    content: null,
  }),
  ev(5, {
    sessionId: 's1',
    type: 'tool.call',
    toolCallId: 'c2',
    title: 'Edit app.ts',
    kind: 'edit',
    status: 'pending',
    content: [{ type: 'diff', path: 'src/app.ts', oldText: 'a', newText: 'b' }],
    locations: [],
  }),
  ev(6, {
    sessionId: 's1',
    type: 'permission.requested',
    requestId: 'r1',
    toolCallId: 'c2',
    title: 'Edit src/app.ts',
    kind: 'edit',
    detail: null,
    options: [],
  }),
  ev(16, {
    sessionId: 's1',
    type: 'permission.decided',
    requestId: 'r1',
    decision: { outcome: 'selected', optionId: 'allow' },
    decidedBy: 'user',
    note: null,
  }),
  ev(17, {
    sessionId: 's1',
    type: 'tool.update',
    toolCallId: 'c2',
    title: null,
    status: 'completed',
    content: null,
  }),
  ev(18, { sessionId: 's1', type: 'command.started', terminalId: 'x1', command: 'npm test', cwd: '/w' }),
  ev(19, { sessionId: 's1', type: 'command.output', terminalId: 'x1', chunk: 'FAIL' }),
  ev(20, {
    sessionId: 's1',
    type: 'command.exited',
    terminalId: 'x1',
    exitCode: 1,
    signal: null,
    output: 'FAIL',
    truncated: false,
    killed: false,
  }),
  ev(21, {
    sessionId: 's1',
    type: 'plan.updated',
    entries: [
      { content: 'a', priority: 'high', status: 'completed' },
      { content: 'b', priority: 'low', status: 'pending' },
    ],
  }),
  ev(22, { sessionId: 's1', type: 'agent.message.chunk', messageId: 'm1', text: 'Done' }),
  ev(23, { sessionId: 's1', type: 'agent.message', messageId: 'm1', text: 'Done. The test now passes.' }),
  ev(24, {
    sessionId: 's1',
    type: 'turn.ended',
    turnId: 't1',
    stopReason: 'end_turn',
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.02 },
  }),
];

describe('WA-07 activity', () => {
  it('follows what the agent is doing, phase by phase', () => {
    const phases: string[] = [];
    let a = emptyActivity();
    for (const e of turn) {
      a = applyActivity(a, e);
      phases.push(a.phase);
    }
    expect(phases).toEqual([
      'starting',
      'working',
      'thinking',
      'tool',
      'working',
      'tool',
      'waiting',
      'tool',
      'working',
      'command',
      'command',
      'working',
      'working',
      'writing',
      'writing',
      'idle',
    ]);
  });

  it('says what is happening now in plain words', () => {
    expect(activityFrom(turn.slice(0, 4)).now).toBe('Reading app.ts');
    expect(activityFrom(turn.slice(0, 7)).now).toBe('Waiting for you: Edit src/app.ts');
    expect(activityFrom(turn.slice(0, 10)).now).toBe('Running npm test');
    expect(activityFrom(turn).now).toBeNull();
  });

  it('counts tools, edits, commands, approvals and files', () => {
    const a = activityFrom(turn);
    expect(a.counts).toMatchObject({
      toolCalls: 2,
      reads: 1,
      edits: 1,
      commands: 1,
      commandsFailed: 1,
      approvals: 1,
      messages: 1,
    });
    expect(a.files['src/app.ts']).toEqual({ reads: 1, edits: 1 });
    expect(a.plan).toEqual({ done: 1, total: 2 });
  });

  it('counts a file once when the update repeats the diff of its tool call', () => {
    const a = activityFrom([
      ev(0, { sessionId: 's1', type: 'tool.call', toolCallId: 'e1', title: 'Edit x', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: 'x.ts', oldText: null, newText: 'a' }], locations: ['x.ts'] }),
      ev(1, { sessionId: 's1', type: 'tool.update', toolCallId: 'e1', title: null, status: 'completed', content: [{ type: 'diff', path: 'x.ts', oldText: null, newText: 'a' }] }),
      ev(2, { sessionId: 's1', type: 'tool.update', toolCallId: 'e9', title: null, status: 'completed', content: [{ type: 'diff', path: 'y.ts', oldText: null, newText: 'b' }] }),
    ]);
    expect(a.files['x.ts']).toEqual({ reads: 0, edits: 1 });
    // A diff that arrives only in an update still counts.
    expect(a.files['y.ts']).toEqual({ reads: 0, edits: 1 });
  });

  it('records the result of a turn', () => {
    const a = activityFrom(turn);
    expect(a.outcome).toEqual({ stopReason: 'end_turn', at: T0 + 24_000, durationMs: 23_000 });
    expect(a.usage).toEqual({ inputTokens: 1200, outputTokens: 300, costUsd: 0.02 });
    expect(a.lastMessage).toBe('Done. The test now passes.');
  });

  it('keeps a feed of meaningful steps, without stream chunks', () => {
    const kinds = activityFrom(turn).feed.map((f) => f.kind);
    expect(kinds).toEqual([
      'you',
      'turn',
      'tool',
      'tool',
      'approval',
      'approval',
      'command',
      'command-failed',
      'plan',
      'message',
      'turn',
    ]);
  });

  it('builds a phase timeline whose totals cover the turn from its start', () => {
    const a = activityFrom(turn);
    const totals = phaseTotals(a.segments, T0 + 24_000);
    expect(totals.waiting).toBe(10_000);
    expect(Object.values(totals).reduce((x, y) => x + y, 0)).toBe(23_000);
  });

  it('does not change the activity it is given', () => {
    const a = activityFrom(turn.slice(0, 3));
    const copy = structuredClone(a);
    applyActivity(a, turn[3]!);
    expect(a).toEqual(copy);
  });

  it('turns event times into a moving rate', () => {
    const times = [T0, T0 + 1000, T0 + 59_000, T0 + 119_000];
    const b = rateBuckets(times, T0 + 120_000, 4);
    // The event exactly two minutes old has aged out.
    expect(b).toEqual([1, 1, 0, 1]);
    // Two minutes later everything has aged out.
    expect(rateBuckets(times, T0 + 240_000, 4)).toEqual([0, 0, 0, 0]);
  });
});

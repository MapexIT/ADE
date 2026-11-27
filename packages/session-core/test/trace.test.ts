import type { DistributiveOmit, NewSessionEvent, SessionEvent } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkpointChain,
  deciderLabel,
  editReports,
  groupByPrompt,
  lineOrigins,
  matchLines,
  matchToolCall,
  resolveVia,
  toLines,
  traceDetail,
  traceFile,
  turnsOf,
  undoneTurns,
  type EditReport,
  type TraceTurn,
  type Transition,
} from '../src/trace.ts';

const t = (turnIndex: number): Transition => ({ kind: 'agent', turnIndex });
const you: Transition = { kind: 'user' };
const origins = (f: ReturnType<typeof traceFile>) => f.lines.map((l) => `${l.side}${l.line}:${l.origin.kind === 'agent' ? `t${l.origin.turnIndex}` : l.origin.kind}`);

describe('toLines and matchLines', () => {
  it('splits on line breaks and remembers a missing final one', () => {
    expect(toLines(null)).toEqual({ lines: [], noEol: false });
    expect(toLines('a\nb\n')).toEqual({ lines: ['a', 'b'], noEol: false });
    expect(toLines('a\r\nb')).toEqual({ lines: ['a\r', 'b'], noEol: true });
  });

  it('finds a minimal match', () => {
    const m = matchLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect([...m]).toEqual([0, -1, 2, 3, -1]);
    expect([...matchLines([], ['a'])]).toEqual([-1]);
    expect([...matchLines(['a'], [])]).toEqual([]);
    expect([...matchLines(['a', 'b'], ['c', 'd'])]).toEqual([-1, -1]);
  });

  it('counts like an LCS on random input', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 4;
    for (let run = 0; run < 50; run++) {
      const a = Array.from({ length: 30 }, () => String(rnd()));
      const b = Array.from({ length: 25 }, () => String(rnd()));
      // reference LCS length by dynamic programming
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      const m = matchLines(a, b);
      const pairs = [...m].map((i, j) => [i, j] as const).filter(([i]) => i >= 0);
      expect(pairs.length).toBe(dp[a.length]![b.length]);
      for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
      for (let k = 1; k < pairs.length; k++) expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
    }
  });
});

describe('traceFile carry-forward', () => {
  it('keeps the turn that added a line until a later turn rewrites it', () => {
    const f = traceFile([
      { text: 'base\n', via: t(0) },
      { text: 'base\nalpha\n', via: t(0) },
      { text: 'base\nalpha\nbeta\n', via: t(1) },
      { text: 'base\nALPHA\nbeta\n', via: t(3) },
    ]);
    expect(origins(f)).toEqual(['new2:t3', 'new3:t1']);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
  });

  it('attributes deleted base lines to the turn that removed them, on the old side', () => {
    const f = traceFile([
      { text: 'a\nb\nc\n', via: t(0) },
      { text: 'a\nc\n', via: t(0) },
      { text: 'c\n', via: t(2) },
    ]);
    expect(origins(f)).toEqual(['old1:t2', 'old2:t0']);
    expect(f.hunks).toHaveLength(1);
  });

  it('follows a line when text is inserted above it', () => {
    const f = traceFile([
      { text: null, via: t(0) },
      { text: 'x\n', via: t(0) },
      { text: 'top\nx\n', via: t(1) },
      { text: 'top\nmid\nx\n', via: you },
    ]);
    expect(origins(f)).toEqual(['new1:t1', 'new2:user', 'new3:t0']);
  });

  it('keeps the origin when only a final line break is added, but counts the line as Git does', () => {
    const f = traceFile([
      { text: null, via: t(0) },
      { text: 'alpha', via: t(0) },
      { text: 'alpha\nbeta', via: t(1) },
    ]);
    expect(origins(f)).toEqual(['new1:t0', 'new2:t1']);
    const g = traceFile([
      { text: 'x', via: t(0) },
      { text: 'x\ny', via: t(4) },
    ]);
    // Git shows -x +x +y; the rewritten x is the turn that added the line break.
    expect(origins(g)).toEqual(['old1:t4', 'new1:t4', 'new2:t4']);
    expect([g.additions, g.deletions]).toEqual([2, 1]);
  });

  it('treats a line-ending change as a change', () => {
    const f = traceFile([
      { text: 'a\nb\n', via: t(0) },
      { text: 'a\r\nb\n', via: t(2) },
    ]);
    expect(origins(f)).toEqual(['old1:t2', 'new1:t2']);
  });

  it('a line removed and then restored is unchanged and not traced', () => {
    const f = traceFile([
      { text: 'a\nb\n', via: t(0) },
      { text: 'a\n', via: t(0) },
      { text: 'a\nb\n', via: t(1) },
    ]);
    expect(f.lines).toEqual([]);
  });

  it('reports a line whose step is unknown as unknown', () => {
    const f = traceFile([
      { text: '', via: t(0) },
      { text: 'a\n', via: { kind: 'unknown' } },
    ]);
    expect(origins(f)).toEqual(['new1:unknown']);
  });

  it('traces a 5,000-line file in under a second', () => {
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const v1 = [...base];
    for (let i = 0; i < 5000; i += 10) v1[i] = `changed ${i}`;
    const v2 = [...v1];
    for (let i = 5; i < 5000; i += 50) v2.splice(i, 0, `inserted ${i}`);
    const v3 = v2.map((l, i) => (i % 97 === 0 ? `again ${i}` : l));
    const started = performance.now();
    const f = traceFile([
      { text: base.join('\n'), via: t(0) },
      { text: v1.join('\n'), via: t(0) },
      { text: v2.join('\n'), via: t(1) },
      { text: v3.join('\n'), via: t(2) },
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(f.additions).toBeGreaterThan(500);
  });
});

describe('checkpoint chain', () => {
  const turn = (index: number, s: string | null, e: string | null, ended = true): TraceTurn => ({
    index,
    startedAt: `2026-01-01T00:0${index}:00.000Z`,
    endedAt: ended ? `2026-01-01T00:0${index}:30.000Z` : null,
    startCheckpoint: s,
    endCheckpoint: e,
  });
  const vias = (c: ReturnType<typeof checkpointChain>) => c.map((p) => `${p.commit}:${p.via.kind === 'agent' ? `t${p.via.turnIndex}` : p.via.kind}`);

  it('walks base, each turn and the worktree now', () => {
    expect(vias(checkpointChain('B', [turn(0, 'S0', 'E0'), turn(1, 'S1', 'E1')], 'NOW'))).toEqual(['B:unknown', 'S0:gap', 'E0:t0', 'S1:gap', 'E1:t1', 'NOW:gap']);
  });

  it('gives the running turn what changed since its start', () => {
    expect(vias(checkpointChain('B', [turn(0, 'S0', null, false)], 'NOW'))).toEqual(['B:unknown', 'S0:gap', 'NOW:t0']);
  });

  it('marks steps over a missing checkpoint as unknown', () => {
    expect(vias(checkpointChain('B', [turn(0, 'S0', null), turn(1, 'S1', 'E1')], 'NOW'))).toEqual(['B:unknown', 'S0:gap', 'S1:unknown', 'E1:t1', 'NOW:gap']);
    expect(vias(checkpointChain('B', [turn(0, null, 'E0')], 'NOW'))).toEqual(['B:unknown', 'E0:unknown', 'NOW:gap']);
  });

  it('leaves out turns an undo threw away', () => {
    const turns = [turn(0, 'S0', 'E0'), turn(1, 'S1', 'E1'), turn(2, 'S2', 'E2')];
    const undone = undoneTurns(turns, [{ turnIndex: 1, ts: '2026-01-01T00:01:50.000Z' }]);
    expect([...undone]).toEqual([1]);
    expect(vias(checkpointChain('B', turns, 'NOW', undone))).toEqual(['B:unknown', 'S0:gap', 'E0:t0', 'S2:gap', 'E2:t2', 'NOW:gap']);
  });

  it('a gap is the user only when they edited the file in ADE', () => {
    expect(resolveVia({ kind: 'gap' }, true)).toEqual({ kind: 'user' });
    expect(resolveVia({ kind: 'gap' }, false)).toEqual({ kind: 'unknown' });
    expect(resolveVia({ kind: 'agent', turnIndex: 3 }, false)).toEqual(t(3));
  });
});

describe('matchToolCall', () => {
  const r = (toolCallId: string, seq: number, oldText: string | null, newText: string, path = 'src/a.ts'): EditReport => ({ toolCallId, path, oldText, newText, seq });

  it('picks the newest report whose new text adds the line', () => {
    const reports = [r('one', 1, null, 'a\nb\n'), r('two', 2, 'a\nb\n', 'a\nb\nc\n')];
    expect(matchToolCall('c', 'new', reports, 'src/a.ts')).toBe('two');
    expect(matchToolCall('a', 'new', reports, 'src/a.ts')).toBe('one');
    expect(matchToolCall('zzz', 'new', reports, 'src/a.ts')).toBeNull();
    expect(matchToolCall('c', 'new', reports, 'src/other.ts')).toBeNull();
  });

  it('counts repeated identical lines', () => {
    const reports = [r('frag', 3, 'return x;\n}', 'return x;\n}\n}')];
    expect(matchToolCall('}', 'new', reports, 'src/a.ts')).toBe('frag');
    expect(matchToolCall('return x;', 'new', reports, 'src/a.ts')).toBeNull();
  });

  it('falls back for lines without letters or digits', () => {
    const reports = [r('frag', 3, '}', '  }')];
    expect(matchToolCall('}', 'new', reports, 'src/a.ts')).toBe('frag');
  });

  it('matches CRLF text and fragments without indentation', () => {
    const reports = [r('crlf', 1, null, 'one\r\ntwo\r\n'), r('frag', 2, 'const a = 1;', 'const a = 2;')];
    expect(matchToolCall('two\r', 'new', reports, 'src/a.ts')).toBe('crlf');
    expect(matchToolCall('    const a = 2;', 'new', reports, 'src/a.ts')).toBe('frag');
    expect(matchToolCall('    const a = 1;', 'old', reports, 'src/a.ts')).toBe('frag');
  });

  it('editReports resolves absolute and relative paths against the worktree', () => {
    let seq = 0;
    const ev = (e: Record<string, unknown>) => ({ sessionId: 's', ts: 't', seq: seq++, ...e }) as SessionEvent;
    const events = [
      ev({ type: 'tool.call', toolCallId: 'abs', title: 'Edit', kind: 'edit', status: 'pending', content: [], locations: [] }),
      ev({ type: 'tool.update', toolCallId: 'abs', title: null, status: 'completed', content: [{ type: 'diff', path: 'C:\\Work\\Tree\\src\\a.ts', oldText: null, newText: 'x' }] }),
      ev({ type: 'tool.call', toolCallId: 'rel', title: 'Edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: './src/b.ts', oldText: null, newText: 'y' }], locations: [] }),
      ev({ type: 'tool.call', toolCallId: 'out', title: 'Edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/etc/hosts', oldText: null, newText: 'z' }], locations: [] }),
    ];
    const reports = editReports(events, ['c:/work/tree']);
    expect(reports.map((x) => [x.toolCallId, x.path])).toEqual([
      ['abs', 'src/a.ts'],
      ['rel', 'src/b.ts'],
    ]);
    expect(reports[0]!.seq).toBe(1);
  });
});

describe('lineOrigins and groupByPrompt', () => {
  it('labels agent, unreported, user and unknown lines and groups every hunk once', () => {
    const app = traceFile([
      { text: null, via: t(0) },
      { text: 'alpha', via: t(0) },
      { text: 'alpha\nbeta\nmine', via: t(1) },
      { text: 'alpha\nbeta\nmine\nyours', via: you },
    ]);
    const gen = traceFile([
      { text: null, via: t(0) },
      { text: null, via: t(0) },
      { text: 'generated\n', via: t(1) },
    ]);
    const reports = new Map<number, EditReport[]>([
      [0, [{ toolCallId: 'e1', path: 'app.txt', oldText: null, newText: 'alpha', seq: 1 }]],
      [1, [{ toolCallId: 'e2', path: 'app.txt', oldText: 'alpha', newText: 'alpha\nbeta', seq: 5 }]],
    ]);
    const appO = lineOrigins(app, 'app.txt', reports);
    expect(appO.map((o) => [o.line, o.kind, o.turnIndex, o.toolCallId])).toEqual([
      [1, 'agent', 0, 'e1'],
      [2, 'agent', 1, 'e2'],
      [3, 'unreported', 1, null],
      [4, 'user', null, null],
    ]);
    const genO = lineOrigins(gen, 'gen.txt', reports);
    expect(genO[0]!.kind).toBe('unreported');

    const groups = groupByPrompt(
      [
        { path: 'app.txt', file: app, origins: appO },
        { path: 'gen.txt', file: gen, origins: genO },
      ],
      new Map([
        [0, 'first'],
        [1, 'second'],
      ]),
    );
    expect(groups.map((g) => [g.kind, g.turnIndex, g.prompt, g.additions, g.hunks.length])).toEqual([
      ['turn', 0, 'first', 1, 1],
      ['turn', 1, 'second', 1, 1],
      ['unreported', null, null, 2, 2],
      ['user', null, null, 1, 1],
    ]);
    const total = groups.reduce((n, g) => n + g.additions + g.deletions, 0);
    expect(total).toBe(app.additions + app.deletions + gen.additions + gen.deletions);
    expect(groups[2]!.hunks.map((h) => [h.path, h.line, h.side])).toEqual([
      ['app.txt', 3, 'new'],
      ['gen.txt', 1, 'new'],
    ]);
  });

  it('places deletion-only pieces on the old side', () => {
    const f = traceFile([
      { text: 'a\nb\n', via: t(0) },
      { text: 'a\n', via: t(0) },
    ]);
    const o = lineOrigins(f, 'x', new Map([[0, [{ toolCallId: 'd', path: 'x', oldText: 'a\nb', newText: 'a', seq: 1 }]]]));
    expect(o[0]).toMatchObject({ side: 'old', kind: 'agent', toolCallId: 'd' });
    const [g] = groupByPrompt([{ path: 'x', file: f, origins: o }], new Map());
    expect(g!.hunks).toEqual([{ path: 'x', line: 2, side: 'old', additions: 0, deletions: 1 }]);
  });
});

describe('turnsOf and traceDetail', () => {
  let seq = 0;
  const ev = (e: DistributiveOmit<NewSessionEvent, 'sessionId'>): SessionEvent => ({ sessionId: 's', seq: seq++, ts: `ts${seq}`, ...e }) as SessionEvent;
  const events: SessionEvent[] = [
    ev({ type: 'user.message', content: [{ type: 'text', text: 'Write alpha' }], queued: false }),
    ev({ type: 'turn.started', turnId: 'A', index: 0 }),
    ev({ type: 'agent.message', messageId: 'm1', text: 'Writing alpha.' }),
    ev({ type: 'tool.call', toolCallId: 'e1', title: 'Edit app.txt', kind: 'edit', status: 'completed', content: [], locations: [] }),
    ev({ type: 'turn.ended', turnId: 'A', stopReason: 'end_turn', usage: null }),
    ev({ type: 'user.message', content: [{ type: 'text', text: 'Now beta' }], queued: false }),
    ev({ type: 'turn.started', turnId: 'B', index: 1 }),
    ev({ type: 'tool.call', toolCallId: 'x1', title: 'Run npm test', kind: 'execute', status: 'pending', content: [], locations: [] }),
    ev({
      type: 'permission.requested',
      requestId: 'r1',
      toolCallId: 'x1',
      title: 'Run npm test',
      kind: 'execute',
      detail: null,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    }),
    ev({ type: 'permission.decided', requestId: 'r1', decision: { outcome: 'selected', optionId: 'allow-once' }, decidedBy: 'user', note: null }),
    ev({ type: 'tool.update', toolCallId: 'x1', title: null, status: 'completed', content: null }),
    ev({ type: 'agent.thought', messageId: 'm2', text: 'Tests pass; add beta.' }),
    ev({ type: 'tool.call', toolCallId: 'e2', title: 'Edit app.txt', kind: 'edit', status: 'completed', content: [], locations: [] }),
    ev({ type: 'command.started', terminalId: 'T', command: 'git --version', cwd: '/w' }),
    ev({ type: 'turn.ended', turnId: 'B', stopReason: 'end_turn', usage: null }),
  ];

  it('cuts events into turns with their prompts', () => {
    const turns = turnsOf(events);
    expect(turns.map((x) => [x.index, x.prompt, x.events.length])).toEqual([
      [0, 'Write alpha', 2],
      [1, 'Now beta', 7],
    ]);
  });

  it('describes the tool call, the thought before it and the approval earlier in the turn', () => {
    const d = traceDetail(events, 1, 'e2');
    expect(d.prompt).toBe('Now beta');
    expect(d.toolCall).toMatchObject({ toolCallId: 'e2', title: 'Edit app.txt', status: 'completed' });
    expect(d.preceding).toEqual({ kind: 'thought', text: 'Tests pass; add beta.' });
    expect(d.permissions).toEqual([{ title: 'Run npm test', decision: 'Allow once', decidedBy: 'you', forToolCall: false }]);
    expect(d.commands).toEqual(['Run npm test (completed)', 'git --version']);
  });

  it("names a tool call's own approval", () => {
    const d = traceDetail(events, 1, 'x1');
    expect(d.permissions).toEqual([{ title: 'Run npm test', decision: 'Allow once', decidedBy: 'you', forToolCall: true }]);
    expect(d.preceding).toBeNull();
  });

  it('without a tool call, uses the last message of the turn; an unknown turn is empty', () => {
    expect(traceDetail(events, 0, null).preceding).toEqual({ kind: 'message', text: 'Writing alpha.' });
    expect(traceDetail(events, 9, null)).toMatchObject({ prompt: null, toolCall: null, commands: [] });
  });

  it('says who decided in words', () => {
    expect(deciderLabel('user')).toBe('you');
    expect(deciderLabel('profile:careful')).toBe('the careful profile');
    expect(deciderLabel('rule:abc')).toBe('a workspace rule');
    expect(deciderLabel('system')).toBe('ADE automatically');
  });
});

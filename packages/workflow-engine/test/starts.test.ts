import { describe, expect, it } from 'vitest';
import {
  backEdges,
  initialState,
  parseWorkflow,
  reduce,
  startNodes,
  TEMPLATES,
  validate,
  Workflow,
  type RunEvent,
  type RunState,
  type Workflow as WorkflowT,
} from '../src/index.ts';

/** A workflow from the YAML body after its name. */
const wf = (body: string): WorkflowT => parseWorkflow(`name: t\n${body}`);
const ids = (w: WorkflowT) => startNodes(w).map((n) => n.id);

/** Folds events through the reducer, keeping the effects of the last one. */
function play(w: WorkflowT, events: RunEvent[], from: RunState = initialState(w)) {
  let state = from;
  let effects: ReturnType<typeof reduce>['effects'] = [];
  for (const e of events) ({ state, effects } = reduce(w, state, e));
  return {
    state,
    effects,
    ran: effects.flatMap((x) => (x.type === 'run-node' ? [x.nodeId] : [])),
    gates: effects.flatMap((x) => (x.type === 'await-gate' ? [x.nodeId] : [])),
  };
}
const start: RunEvent = { type: 'start', workItem: { title: 'w' }, at: 0 };
const done = (nodeId: string, summary = nodeId, outcome: 'pass' | 'fail' = 'pass'): RunEvent => ({
  type: 'node.finished',
  nodeId,
  outcome,
  packet: { summary },
  at: 1,
});
const failed = (nodeId: string) => done(nodeId, nodeId, 'fail');

const twoIntoJoin = wf(`nodes:
  - { id: a, type: command, run: [a] }
  - { id: b, type: command, run: [b] }
  - { id: join, type: agent, agent: codex, prompt: join }
edges:
  - { from: a, to: join }
  - { from: b, to: join }
`);

/** `lint` starts on its own; `fix` is the first step of a retry cycle and starts too; both feed `join`. */
const cycleAndRoot = wf(`nodes:
  - { id: lint, type: command, run: [lint] }
  - { id: fix, type: agent, agent: codex, prompt: fix }
  - { id: check, type: command, run: [test] }
  - { id: join, type: gate }
edges:
  - { from: lint, to: join }
  - { from: fix, to: check }
  - { from: check, to: fix, when: fail, maxRounds: 2 }
  - { from: check, to: join, when: pass }
`);

describe('WF-18 which steps start a run', () => {
  it('an empty workflow has none, and validation says it cannot run', () => {
    const empty = Workflow.parse({ name: 'e' });
    expect(ids(empty)).toEqual([]);
    expect(validate(empty)[0]!.level).toBe('error');
  });

  it('a chain starts at its first step only', () => {
    expect(
      ids(wf(`nodes:\n  - { id: a, type: gate }\n  - { id: b, type: gate }\nedges:\n  - { from: a, to: b }`)),
    ).toEqual(['a']);
  });

  it('starts every step nothing leads into, in the order listed, wherever it is listed', () => {
    expect(ids(twoIntoJoin)).toEqual(['a', 'b']);
    const late = wf(`nodes:
  - { id: join, type: gate }
  - { id: b, type: gate }
  - { id: a, type: gate }
edges:
  - { from: a, to: join }
  - { from: b, to: join }
`);
    expect(ids(late)).toEqual(['b', 'a']);
  });

  it('an unconnected step is a start of its own', () => {
    expect(
      ids(
        wf(
          `nodes:\n  - { id: a, type: gate }\n  - { id: b, type: gate }\n  - { id: c, type: gate }\nedges:\n  - { from: a, to: b }`,
        ),
      ),
    ).toEqual(['a', 'c']);
  });

  it('a step whose only input closes a cycle still starts (the first step of a retry cycle)', () => {
    const retry = wf(`nodes:
  - { id: build, type: agent, agent: codex, prompt: b }
  - { id: test, type: command, run: [test] }
edges:
  - { from: build, to: test }
  - { from: test, to: build, when: fail }
`);
    expect(ids(retry)).toEqual(['build']);
    expect(ids(cycleAndRoot)).toEqual(['lint', 'fix']);
  });

  it('a cycle that a start leads into is entered there, even when a step further round it is listed first', () => {
    const w = wf(`nodes:
  - { id: check, type: command, run: [test] }
  - { id: fix, type: agent, agent: codex, prompt: fix }
  - { id: prep, type: command, run: [prep] }
edges:
  - { from: prep, to: fix }
  - { from: fix, to: check }
  - { from: check, to: fix, when: fail }
`);
    expect(ids(w)).toEqual(['prep']);
    expect([...backEdges(w)]).toEqual([2]);
  });

  it('a workflow made only of a cycle starts at the step listed first', () => {
    const ring = wf(`nodes:
  - { id: b, type: command, run: [b] }
  - { id: a, type: command, run: [a] }
edges:
  - { from: a, to: b }
  - { from: b, to: a, when: fail }
`);
    expect(ids(ring)).toEqual(['b']);
  });

  it('every template keeps a single start', () => {
    for (const yaml of Object.values(TEMPLATES)) expect(startNodes(parseWorkflow(yaml))).toHaveLength(1);
  });
});

describe('WF-18 validation from every start', () => {
  it('accepts several starts that meet at a join', () => {
    expect(validate(twoIntoJoin).filter((p) => p.level === 'error')).toEqual([]);
    expect(validate(cycleAndRoot).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('checks for a gate on the path from each start to a land step', () => {
    const body = (second: string) => `nodes:
  - { id: review, type: gate }
  - { id: agent, type: agent, agent: codex, prompt: x }
  - { id: land, type: land, mode: commit }
edges:
  - { from: review, to: land }
  - { from: agent, to: ${second} }
`;
    expect(() => wf(body('land'))).toThrow(/land can land code that no gate reviewed/);
    expect(validate(wf(body('review'))).filter((p) => p.level === 'error')).toEqual([]);
  });
});

describe('WF-18 starting a run', () => {
  it('starts every start at once with the same packet', () => {
    const { state, effects } = play(twoIntoJoin, [start]);
    expect(effects.map((e) => e.type)).toEqual(['run-node', 'run-node']);
    const packets = effects.map((e) => (e.type === 'run-node' ? e.packet : null));
    expect(packets[0]).toEqual(packets[1]);
    expect(packets[0]!.workItem).toEqual({ title: 'w' });
    expect(state.status).toBe('running');
    expect(state.active).toEqual(['a', 'b']);
    expect(state.current).toBe('a');
    expect(state.nodes.join!.status).toBe('pending');
  });

  it('a gate among the starts waits while the other start runs; only gates means the run waits for you', () => {
    const mixed = wf(`nodes:\n  - { id: g, type: gate }\n  - { id: c, type: command, run: [c] }\nedges: []`);
    const m = play(mixed, [start]);
    expect(m.gates).toEqual(['g']);
    expect(m.ran).toEqual(['c']);
    expect(m.state.status).toBe('running');
    const gates = wf(`nodes:\n  - { id: g, type: gate }\n  - { id: h, type: gate }\nedges: []`);
    const g = play(gates, [start]);
    expect(g.gates).toEqual(['g', 'h']);
    expect(g.state.status).toBe('waiting-gate');
    expect(
      play(gates, [
        start,
        { type: 'gate.decided', nodeId: 'g', approved: true, at: 1 },
        { type: 'gate.decided', nodeId: 'h', approved: true, at: 2 },
      ]).state.status,
    ).toBe('succeeded');
  });

  it('a start that is a loop step lets the run straight through to what follows', () => {
    const w = wf(
      `nodes:\n  - { id: loop, type: loop, max: 2 }\n  - { id: c, type: command, run: [c] }\n  - { id: d, type: command, run: [d] }\nedges:\n  - { from: loop, to: c }`,
    );
    const { ran, state } = play(w, [start]);
    expect(ran).toEqual(['c', 'd']);
    expect(state.nodes.loop!.status).toBe('passed');
  });

  it('unconnected starts each run to the end and the run then succeeds', () => {
    const w = wf(
      `nodes:\n  - { id: a, type: command, run: [a] }\n  - { id: b, type: command, run: [b] }\nedges: []`,
    );
    expect(play(w, [start, done('a')]).state.status).toBe('running');
    const end = play(w, [start, done('a'), done('b')]);
    expect(end.state.status).toBe('succeeded');
    expect(end.effects).toContainEqual({ type: 'finished', status: 'succeeded' });
  });

  it('a failing start with nowhere to go fails the run once the other start stops', () => {
    const w = wf(
      `nodes:\n  - { id: a, type: command, run: [a] }\n  - { id: b, type: command, run: [b] }\nedges: []`,
    );
    expect(play(w, [start, failed('a')]).state.status).toBe('running');
    expect(play(w, [start, failed('a'), done('b')]).state.status).toBe('failed');
  });
});

describe('WF-18 joins after several starts', () => {
  it('waits for every start, whichever finishes first, and merges inputs in input order', () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      const first = play(twoIntoJoin, [start, done(order[0]!)]);
      expect(first.effects).toEqual([]);
      expect(first.state.nodes.join!.status).toBe('pending');
      const both = play(twoIntoJoin, [start, done(order[0]!), done(order[1]!)]);
      expect(both.ran).toEqual(['join']);
      expect(both.effects[0]).toMatchObject({
        type: 'run-node',
        nodeId: 'join',
        packet: { summary: 'a\n\nb', workItem: { title: 'w' } },
      });
      expect(both.state.inbox).toEqual({});
    }
  });

  it('waits for three starts', () => {
    const three = wf(`nodes:
  - { id: a, type: command, run: [a] }
  - { id: b, type: command, run: [b] }
  - { id: c, type: command, run: [c] }
  - { id: join, type: gate }
edges:
  - { from: a, to: join }
  - { from: b, to: join }
  - { from: c, to: join }
`);
    expect(play(three, [start, done('a'), done('c')]).gates).toEqual([]);
    expect(play(three, [start, done('a'), done('c'), done('b')]).gates).toEqual(['join']);
  });

  it('a join after a chain from one start and a single step from another waits for the whole chain', () => {
    const w = wf(`nodes:
  - { id: a, type: command, run: [a] }
  - { id: a2, type: command, run: [a2] }
  - { id: b, type: command, run: [b] }
  - { id: join, type: gate }
edges:
  - { from: a, to: a2 }
  - { from: a2, to: join }
  - { from: b, to: join }
`);
    expect(play(w, [start, done('b'), done('a')]).ran).toEqual(['a2']);
    expect(play(w, [start, done('b'), done('a'), done('a2')]).gates).toEqual(['join']);
  });

  /** `b` passes to `c` or fails to `d`; `a` and `c` meet at `join`. */
  const ruledOut = wf(`nodes:
  - { id: a, type: command, run: [a] }
  - { id: b, type: command, run: [b] }
  - { id: c, type: agent, agent: codex, prompt: c }
  - { id: d, type: connector, connector: github, action: comment }
  - { id: join, type: agent, agent: codex, prompt: join }
edges:
  - { from: a, to: join }
  - { from: b, to: c, when: pass }
  - { from: b, to: d, when: fail }
  - { from: c, to: join }
`);

  it('a branch a start did not take still releases the join (after the other start)', () => {
    const early = play(ruledOut, [start, failed('b')]);
    expect(early.ran).toEqual(['d']);
    expect(early.state.nodes.c!.status).toBe('skipped');
    expect(early.state.nodes.join!.status).toBe('pending');
    const joined = play(ruledOut, [start, failed('b'), done('a')]);
    expect(joined.ran).toEqual(['join']);
    expect(joined.effects[0]).toMatchObject({ packet: { summary: 'a' } });
  });

  it('a branch a start did not take still releases the join (before the other start)', () => {
    const joined = play(ruledOut, [start, done('a'), failed('b')]);
    expect(joined.ran.sort()).toEqual(['d', 'join']);
    expect(joined.effects.find((e) => e.type === 'run-node' && e.nodeId === 'join')).toMatchObject({
      packet: { summary: 'a' },
    });
  });

  it('a join whose every input was ruled out is skipped, and so is what follows it', () => {
    const w = wf(`nodes:
  - { id: a, type: command, run: [a] }
  - { id: b, type: command, run: [b] }
  - { id: x, type: agent, agent: codex, prompt: x }
  - { id: y, type: agent, agent: codex, prompt: y }
  - { id: join, type: agent, agent: codex, prompt: join }
  - { id: after, type: command, run: [after] }
edges:
  - { from: a, to: x, when: fail }
  - { from: b, to: y, when: fail }
  - { from: x, to: join }
  - { from: y, to: join }
  - { from: join, to: after }
`);
    const { state, ran } = play(w, [start, done('a'), done('b')]);
    expect(ran).toEqual([]);
    for (const id of ['x', 'y', 'join', 'after']) expect(state.nodes[id]!.status).toBe('skipped');
    expect(state.status).toBe('succeeded');
  });

  it('a start inside a retry cycle goes round while the join keeps the other start’s input', () => {
    const w = cycleAndRoot;
    const begun = play(w, [start]);
    expect(begun.ran).toEqual(['lint', 'fix']);
    const lintDone = [start, done('lint'), done('fix')];
    expect(play(w, lintDone).ran).toEqual(['check']);
    // check fails: back to fix; the join must not run on lint alone.
    const round = play(w, [...lintDone, failed('check')]);
    expect(round.ran).toEqual(['fix']);
    expect(round.gates).toEqual([]);
    expect(round.state.nodes.join!.status).toBe('pending');
    expect(round.state.rounds).toEqual({ '2': 1 });
    const passed = play(w, [...lintDone, failed('check'), done('fix', 'fix 2'), done('check', 'check ok')]);
    expect(passed.gates).toEqual(['join']);
    expect(passed.state.nodes.join!.input!.summary).toBe('lint\n\ncheck ok');
  });
});

describe('WF-08 retrying from one start', () => {
  it('re-runs that start and what follows; the join reuses what the other start already sent', () => {
    const finished = [start, done('a'), done('b'), done('join')];
    expect(play(twoIntoJoin, finished).state.status).toBe('succeeded');
    const retry = play(twoIntoJoin, [...finished, { type: 'retry-from', nodeId: 'a', at: 2 }]);
    expect(retry.ran).toEqual(['a']);
    expect(retry.state.nodes.b!.status).toBe('passed');
    expect(retry.state.nodes.join!.status).toBe('pending');
    const again = play(twoIntoJoin, [
      ...finished,
      { type: 'retry-from', nodeId: 'a', at: 2 },
      done('a', 'a 2'),
    ]);
    expect(again.ran).toEqual(['join']);
    expect(again.effects[0]).toMatchObject({ packet: { summary: 'a 2\n\nb' } });
  });

  it('a join waits for the other start when it has not finished yet', () => {
    const retry = play(twoIntoJoin, [
      start,
      done('a'),
      { type: 'retry-from', nodeId: 'a', at: 2 },
      done('a', 'a 2'),
    ]);
    expect(retry.ran).toEqual([]);
    expect(
      play(twoIntoJoin, [
        start,
        done('a'),
        { type: 'retry-from', nodeId: 'a', at: 2 },
        done('a', 'a 2'),
        done('b'),
      ]).ran,
    ).toEqual(['join']);
  });
});

describe('WF-17 a join after a cycle', () => {
  it('does not open while the step before it goes back round its cycle', () => {
    const w = parseWorkflow(TEMPLATES['parallel-checks']!);
    const before = [start, done('build'), done('lint')];
    const retry = play(w, [...before, failed('test')]);
    expect(retry.ran).toEqual(['build']);
    expect(retry.gates).toEqual([]);
    expect(retry.state.nodes.review!.status).toBe('pending');
    // The next round: build, then lint and test again; the gate opens once test passes.
    const next = play(w, [...before, failed('test'), done('build', 'build 2'), done('lint'), done('test')]);
    expect(next.gates).toEqual(['review']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  backEdges,
  cycles,
  MemoryRunStore,
  parseWorkflow,
  roundLimit,
  validate,
  Workflow,
  WorkflowRunner,
  type HandOff,
  type NodeExecutor,
  type NodeResult,
  type WorkflowNode,
} from '../src/index.ts';

/** An executor that records calls (and overlap) and answers from a function. */
function fake(type: WorkflowNode['type'], answer: (n: WorkflowNode, p: HandOff) => NodeResult, delayMs = 0) {
  const calls: string[] = [];
  const inputs: Record<string, HandOff> = {};
  let running = 0;
  let peak = 0;
  const ex: NodeExecutor & { calls: string[]; inputs: Record<string, HandOff>; peak: () => number } = {
    type,
    calls,
    inputs,
    peak: () => peak,
    async execute(node, packet) {
      calls.push(node.id);
      inputs[node.id] = packet;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, delayMs));
      running--;
      return answer(node, packet);
    },
  };
  return ex;
}

const pass = (n: WorkflowNode): NodeResult => ({ outcome: 'pass', packet: { summary: `${n.id} done` } });

describe('WF-12 parallel branches', () => {
  const diamond = parseWorkflow(`
name: diamond
nodes:
  - { id: plan, type: agent, agent: codex, prompt: plan }
  - { id: lint, type: command, run: [lint] }
  - { id: test, type: command, run: [test] }
  - { id: join, type: agent, agent: codex, prompt: "fix {{checkOutput}}" }
  - { id: gate, type: gate }
edges:
  - { from: plan, to: lint }
  - { from: plan, to: test }
  - { from: lint, to: join }
  - { from: test, to: join }
  - { from: join, to: gate }
`);

  it('sends one result to several next steps, runs them in parallel, and joins their results', async () => {
    const agent = fake('agent', pass);
    const command = fake('command', (n) => ({ outcome: 'pass', packet: { checkOutput: `${n.id} ok` } }), 20);
    const runner = new WorkflowRunner(diamond, 'r', new MemoryRunStore(), [agent, command]);
    await runner.start();
    expect(runner.current.status).toBe('waiting-gate');
    expect(command.calls.sort()).toEqual(['lint', 'test']);
    expect(command.peak()).toBe(2);
    // The join ran once, after both inputs, with both outputs merged.
    expect(agent.calls).toEqual(['plan', 'join']);
    expect(agent.inputs.join!.checkOutput).toBe('lint ok\n\ntest ok');
    expect(runner.current.active).toEqual(['gate']);
  });

  it('lets exclusive steps take turns while branches still advance', async () => {
    const command = fake('command', (n) => ({ outcome: 'pass', packet: { checkOutput: n.id } }), 15);
    const runner = new WorkflowRunner(diamond, 'r', new MemoryRunStore(), [fake('agent', pass), command], {}, undefined, { exclusive: ['command'] });
    await runner.start();
    expect(command.peak()).toBe(1);
    expect(runner.current.status).toBe('waiting-gate');
  });

  it('skips a branch not taken, so a join after it still runs', async () => {
    const wf = parseWorkflow(`
name: skip
nodes:
  - { id: check, type: command, run: [test] }
  - { id: fix, type: agent, agent: codex, prompt: fix }
  - { id: notify, type: connector, connector: github, action: comment }
  - { id: gate, type: gate }
edges:
  - { from: check, to: fix, when: fail }
  - { from: check, to: notify }
  - { from: fix, to: gate }
  - { from: notify, to: gate }
`);
    const agent = fake('agent', pass);
    const runner = new WorkflowRunner(wf, 'r', new MemoryRunStore(), [agent, fake('command', () => ({ outcome: 'pass', packet: {} })), fake('connector', pass)]);
    await runner.start();
    expect(agent.calls).toEqual([]);
    expect(runner.current.nodes.fix!.status).toBe('skipped');
    expect(runner.current.status).toBe('waiting-gate');
  });

  it('a failed branch with nowhere to go fails the run once the other branches stop', async () => {
    const wf = parseWorkflow(`
name: fail
nodes:
  - { id: a, type: agent, agent: codex, prompt: a }
  - { id: x, type: command, run: [x] }
  - { id: y, type: command, run: [y] }
edges:
  - { from: a, to: x }
  - { from: a, to: y }
`);
    const command = fake('command', (n) => ({ outcome: n.id === 'x' ? 'fail' : 'pass', packet: {} }), 5);
    const runner = new WorkflowRunner(wf, 'r', new MemoryRunStore(), [fake('agent', pass), command]);
    await runner.start();
    expect(command.calls.sort()).toEqual(['x', 'y']);
    expect(runner.current.status).toBe('failed');
  });
});

describe('WF-13 cycles and round limits', () => {
  const loopy = (maxRounds?: number) =>
    parseWorkflow(`
name: cycle
nodes:
  - { id: build, type: agent, agent: codex, prompt: build }
  - { id: test, type: command, run: [test] }
  - { id: gate, type: gate }
edges:
  - { from: build, to: test }
  - { from: test, to: gate, when: pass }
  - { from: test, to: build, when: fail${maxRounds ? `, maxRounds: ${maxRounds}` : ''} }
`);

  it('finds the edge that closes each cycle and its limit (default 1)', () => {
    const wf = loopy();
    expect([...backEdges(wf)]).toEqual([2]);
    expect(cycles(wf)).toEqual([{ edgeIndex: 2, nodes: ['build', 'test'], maxRounds: 1 }]);
    expect(cycles(loopy(4))[0]!.maxRounds).toBe(4);
    expect(validate(wf).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('goes round once by default, then pauses; resuming grants the rounds again', async () => {
    const command = fake('command', () => ({ outcome: 'fail', packet: { checkOutput: 'red' } }));
    const agent = fake('agent', pass);
    const paused: string[] = [];
    const runner = new WorkflowRunner(loopy(), 'r', new MemoryRunStore(), [agent, command], { onPaused: (r) => paused.push(r) });
    await runner.start();
    expect(agent.calls).toEqual(['build', 'build']);
    expect(command.calls).toEqual(['test', 'test']);
    expect(runner.current.status).toBe('paused');
    expect(paused[0]).toBe('The cycle back to build reached its limit of 1 round.');
    expect(runner.current.current).toBe('build');
    await runner.resume();
    expect(agent.calls).toHaveLength(4);
    expect(runner.current.status).toBe('paused');
  });

  it('honours a higher limit and leaves the cycle as soon as the check passes', async () => {
    let n = 0;
    const command = fake('command', () => ({ outcome: ++n < 3 ? 'fail' : 'pass', packet: {} }));
    const runner = new WorkflowRunner(loopy(5), 'r', new MemoryRunStore(), [fake('agent', pass), command]);
    await runner.start();
    expect(command.calls).toHaveLength(3);
    expect(runner.current.status).toBe('waiting-gate');
    expect(runner.current.rounds).toEqual({ '2': 2 });
  });

  it('a loop node on the cycle sets the limit when the edge has none; a round limit off a cycle is a warning', () => {
    const wf = Workflow.parse({
      name: 'old',
      nodes: [
        { id: 'a', type: 'agent', agent: 'codex', prompt: 'a' },
        { id: 't', type: 'command', run: ['t'] },
        { id: 'r', type: 'loop', max: 3 },
      ],
      edges: [
        { from: 'a', to: 't', maxRounds: 2 },
        { from: 't', to: 'r', when: 'fail' },
        { from: 'r', to: 'a' },
      ],
    });
    expect(roundLimit(wf, 2)).toBe(3);
    expect(validate(wf).find((p) => p.level === 'warning')?.message).toBe('The round limit on a → t has no effect: that edge does not close a cycle.');
  });
});

describe('Empty workflows', () => {
  it('can be saved with no steps, but cannot run', () => {
    const wf = Workflow.parse({ name: 'Draft' });
    expect(wf.nodes).toEqual([]);
    expect(validate(wf)).toEqual([{ level: 'error', message: 'This workflow has no steps yet. Add a first step from the palette.' }]);
  });
});

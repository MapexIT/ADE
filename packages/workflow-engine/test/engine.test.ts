import { describe, expect, it } from 'vitest';
import {
  MemoryRunStore,
  parseWorkflow,
  reduce,
  initialState,
  renderPrompt,
  TEMPLATES,
  validate,
  Workflow,
  WorkflowError,
  WorkflowRunner,
  type NodeExecutor,
  type NodeResult,
  type WorkflowNode,
} from '../src/index.ts';

const fake = (type: WorkflowNode['type'], results: NodeResult[] | ((node: WorkflowNode) => NodeResult)): NodeExecutor & { calls: string[] } => {
  const calls: string[] = [];
  let i = 0;
  return {
    type,
    calls,
    async execute(node) {
      calls.push(node.id);
      return typeof results === 'function' ? results(node) : (results[Math.min(i++, results.length - 1)] ?? { outcome: 'pass', packet: {} });
    },
  };
};

describe('templates', () => {
  it.each(Object.keys(TEMPLATES))('%s validates', (name) => {
    expect(() => parseWorkflow(TEMPLATES[name]!)).not.toThrow();
  });
});

describe('validation', () => {
  const wf = (nodes: unknown[], edges: unknown[], budgets = {}) => Workflow.parse({ name: 't', nodes, edges, budgets });

  it('refuses a land node that no gate protects after the last agent', () => {
    const w = wf(
      [
        { id: 'a', type: 'agent', agent: 'codex', prompt: 'x' },
        { id: 'l', type: 'land', mode: 'commit' },
      ],
      [{ from: 'a', to: 'l' }],
    );
    expect(validate(w).some((p) => p.level === 'error' && p.nodeId === 'l')).toBe(true);
  });

  it('refuses an unbounded cycle and accepts one with a loop node', () => {
    const nodes = [
      { id: 'a', type: 'agent', agent: 'codex', prompt: 'x' },
      { id: 't', type: 'command', run: ['npm', 'test'] },
    ];
    const bad = wf(nodes, [
      { from: 'a', to: 't' },
      { from: 't', to: 'a', when: 'fail' },
    ]);
    expect(validate(bad).some((p) => p.message.includes('no limit'))).toBe(true);
    const good = wf([...nodes, { id: 'r', type: 'loop', max: 2 }], [
      { from: 'a', to: 't' },
      { from: 't', to: 'r', when: 'fail' },
      { from: 'r', to: 'a' },
    ]);
    expect(validate(good).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('reports unknown nodes, several first nodes and unreachable nodes', () => {
    expect(() => parseWorkflow('name: t\nnodes:\n  - { id: a, type: gate }\n  - { id: b, type: gate }\nedges: []')).toThrow(WorkflowError);
    expect(() => parseWorkflow('name: t\nnodes:\n  - { id: a, type: gate }\nedges:\n  - { from: a, to: zz }')).toThrow(/unknown node zz/);
    expect(() => parseWorkflow('name: [unclosed')).toThrow(/YAML is invalid/);
  });

  it('warns that autonomous agent nodes need a sandbox', () => {
    const w = wf([{ id: 'a', type: 'agent', agent: 'codex', prompt: 'x', profile: 'autonomous' }], []);
    expect(validate(w)).toEqual([expect.objectContaining({ level: 'warning', nodeId: 'a' })]);
  });
});

describe('run state machine', () => {
  const story = parseWorkflow(TEMPLATES['story-to-pull-request']!);

  it('M6 gate: story to pull request runs and stops at both gates', async () => {
    const store = new MemoryRunStore();
    const gates: string[] = [];
    const agent = fake('agent', (n) => ({ outcome: 'pass', packet: { summary: `${n.id} done` }, sessionId: `s-${n.id}`, turns: 1 }));
    const command = fake('command', [{ outcome: 'pass', packet: { checkOutput: 'all green' } }]);
    const land = fake('land', [{ outcome: 'pass', packet: {} }]);
    const runner = new WorkflowRunner(story, 'run1', store, [agent, command, land], { onGate: (id) => gates.push(id) });

    await runner.start({ title: 'Fix login' });
    expect(runner.current.status).toBe('waiting-gate');
    expect(gates).toEqual(['approve-plan']);
    await runner.decideGate('approve-plan', true);
    expect(gates).toEqual(['approve-plan', 'review']);
    expect(land.calls).toEqual([]);
    await runner.decideGate('review', true);
    expect(runner.current.status).toBe('succeeded');
    expect(agent.calls).toEqual(['plan', 'build']);
    expect(land.calls).toEqual(['open-pr']);
    expect(runner.current.nodes.build?.sessionId).toBe('s-build');
    expect(store.load('run1')?.status).toBe('succeeded');
  });

  it('loops on failing checks and pauses when the loop limit is hit', async () => {
    const paused: string[] = [];
    const agent = fake('agent', () => ({ outcome: 'pass', packet: {} }));
    const command = fake('command', [{ outcome: 'fail', packet: { checkOutput: 'red' } }]);
    const runner = new WorkflowRunner(story, 'run2', new MemoryRunStore(), [agent, command, fake('land', [])], { onPaused: (r) => paused.push(r) });
    await runner.start();
    await runner.decideGate('approve-plan', true);
    expect(runner.current.status).toBe('paused');
    expect(command.calls).toHaveLength(4);
    expect(paused[0]).toMatch(/looped|loop/);
  });

  it('pauses when a turn budget is reached and resumes on request (WF-07)', async () => {
    const wf = parseWorkflow(`
name: budget
budgets: { turns: 2 }
nodes:
  - { id: a, type: agent, agent: codex, prompt: one }
  - { id: b, type: agent, agent: codex, prompt: two }
  - { id: c, type: agent, agent: codex, prompt: three }
  - { id: g, type: gate }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
  - { from: c, to: g }
`);
    const agent = fake('agent', () => ({ outcome: 'pass', packet: {}, turns: 1 }));
    const runner = new WorkflowRunner(wf, 'run3', new MemoryRunStore(), [agent]);
    await runner.start();
    expect(runner.current.status).toBe('paused');
    expect(runner.current.current).toBe('c');
    await runner.resume();
    expect(runner.current.status).toBe('waiting-gate');
    expect(agent.calls).toEqual(['a', 'b', 'c']);
  });

  it('retries from a step, resetting the nodes after it (WF-08)', async () => {
    const agent = fake('agent', () => ({ outcome: 'pass', packet: {} }));
    const runner = new WorkflowRunner(story, 'run4', new MemoryRunStore(), [agent, fake('command', [{ outcome: 'pass', packet: {} }]), fake('land', [])]);
    await runner.start();
    await runner.decideGate('approve-plan', true);
    await runner.retryFrom('build');
    expect(agent.calls).toEqual(['plan', 'build', 'build']);
    expect(runner.current.status).toBe('waiting-gate');
    expect(runner.current.current).toBe('review');
  });

  it('a rejected gate with no way back cancels the run', async () => {
    const runner = new WorkflowRunner(story, 'run5', new MemoryRunStore(), [fake('agent', () => ({ outcome: 'pass', packet: {} }))]);
    await runner.start();
    await runner.decideGate('approve-plan', false);
    expect(runner.current.status).toBe('cancelled');
  });

  it('rejects events that do not fit the current state', () => {
    const s = initialState(story);
    expect(() => reduce(story, s, { type: 'gate.decided', nodeId: 'review', approved: true, at: 0 })).toThrow();
    expect(() => reduce(story, s, { type: 'resume', at: 0 })).toThrow();
  });

  it('tests a single node on sample input (WF-11)', async () => {
    const command = fake('command', [{ outcome: 'fail', packet: { checkOutput: 'boom' } }]);
    const res = await WorkflowRunner.testNode(command, story.nodes.find((n) => n.id === 'tests')!, { summary: 'sample' });
    expect(res.outcome).toBe('fail');
  });
});

describe('hand-off packet', () => {
  it('fills prompts from the packet (WF-05)', () => {
    expect(renderPrompt('Plan {{workItem.title}}: {{summary}} / {{ checkOutput }}', { summary: 'S', diff: '', checkOutput: 'C', workItem: { title: 'T' } })).toBe('Plan T: S / C');
  });
});

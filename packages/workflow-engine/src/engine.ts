import { outgoing, startNode, type Workflow, type WorkflowNode } from './schema.ts';

/** WF-05: what one node hands the next: summary, diff, check output and work item fields. */
export interface HandOff {
  summary: string;
  diff: string;
  checkOutput: string;
  workItem: Record<string, string>;
}

export const emptyHandOff = (workItem: Record<string, string> = {}): HandOff => ({ summary: '', diff: '', checkOutput: '', workItem });

export type NodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'waiting' | 'skipped';

export interface NodeRun {
  status: NodeStatus;
  attempts: number;
  sessionId: string | null;
  output: HandOff | null;
  startedAt: number | null;
  endedAt: number | null;
}

export type RunStatus = 'running' | 'waiting-gate' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface RunState {
  status: RunStatus;
  current: string | null;
  nodes: Record<string, NodeRun>;
  loops: Record<string, number>;
  used: { turns: number; minutes: number; loops: number; costUsd: number };
  packet: HandOff;
  pauseReason: string | null;
  log: string[];
}

export type RunEvent =
  | { type: 'start'; workItem?: Record<string, string>; packet?: Partial<HandOff>; at: number }
  | { type: 'node.started'; nodeId: string; sessionId?: string; at: number }
  | { type: 'node.session'; nodeId: string; sessionId: string }
  | { type: 'node.finished'; nodeId: string; outcome: 'pass' | 'fail'; packet: Partial<HandOff>; turns?: number; costUsd?: number; at: number }
  | { type: 'gate.decided'; nodeId: string; approved: boolean; at: number }
  | { type: 'tick'; minutes: number }
  | { type: 'resume'; at: number }
  | { type: 'retry-from'; nodeId: string; at: number }
  | { type: 'cancel'; at: number };

/** What the runner must do next. The reducer never performs side effects itself. */
export type Effect = { type: 'run-node'; nodeId: string; packet: HandOff } | { type: 'await-gate'; nodeId: string } | { type: 'paused'; reason: string } | { type: 'finished'; status: RunStatus };

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

const blankNode = (): NodeRun => ({ status: 'pending', attempts: 0, sessionId: null, output: null, startedAt: null, endedAt: null });

export function initialState(wf: Workflow): RunState {
  return {
    status: 'running',
    current: null,
    nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, blankNode()])),
    loops: {},
    used: { turns: 0, minutes: 0, loops: 0, costUsd: 0 },
    packet: emptyHandOff(),
    pauseReason: null,
    log: [],
  };
}

function overBudget(wf: Workflow, s: RunState): string | null {
  const b = wf.budgets;
  if (b.turns !== undefined && s.used.turns >= b.turns) return `The run used its ${b.turns} turns.`;
  if (b.minutes !== undefined && s.used.minutes >= b.minutes) return `The run used its ${b.minutes} minutes.`;
  if (b.loops !== undefined && s.used.loops > b.loops) return `The run looped more than ${b.loops} times.`;
  if (b.costUsd !== undefined && s.used.costUsd >= b.costUsd) return `The run reached its cost limit of $${b.costUsd}.`;
  return null;
}

const node = (wf: Workflow, id: string): WorkflowNode => {
  const n = wf.nodes.find((x) => x.id === id);
  if (!n) throw new RunError(`Unknown node ${id}`);
  return n;
};

/** Moves to `nodeId`, resolving control nodes (loop, branch) inline, and returns the effect to perform. */
function enter(wf: Workflow, s: RunState, nodeId: string | null, outcome: 'pass' | 'fail', at: number): { state: RunState; effects: Effect[] } {
  if (nodeId === null) {
    const status: RunStatus = outcome === 'pass' ? 'succeeded' : 'failed';
    return { state: { ...s, status, current: null }, effects: [{ type: 'finished', status }] };
  }
  const n = node(wf, nodeId);
  const budget = overBudget(wf, s);
  if (budget) return { state: { ...s, status: 'paused', current: nodeId, pauseReason: budget }, effects: [{ type: 'paused', reason: budget }] };

  if (n.type === 'loop') {
    const count = (s.loops[n.id] ?? 0) + 1;
    const loops = { ...s.loops, [n.id]: count };
    const used = { ...s.used, loops: s.used.loops + 1 };
    if (count > n.max) {
      const reason = `${n.id} looped ${n.max} times without passing.`;
      return { state: { ...s, loops, used, status: 'paused', current: n.id, pauseReason: reason }, effects: [{ type: 'paused', reason }] };
    }
    const next = outgoing(wf, n.id)[0]?.to ?? null;
    return enter(wf, { ...s, loops, used, log: [...s.log, `${n.id}: attempt ${count} of ${n.max}`] }, next, outcome, at);
  }
  if (n.type === 'branch') {
    const next = pickNext(wf, n.id, outcome === n.condition ? 'pass' : 'fail');
    return enter(wf, { ...s, nodes: { ...s.nodes, [n.id]: { ...s.nodes[n.id]!, status: outcome === n.condition ? 'passed' : 'failed' } } }, next, outcome, at);
  }
  const nodes = { ...s.nodes, [n.id]: { ...s.nodes[n.id]!, status: n.type === 'gate' ? ('waiting' as const) : ('running' as const), startedAt: at } };
  if (n.type === 'gate') return { state: { ...s, nodes, current: n.id, status: 'waiting-gate' }, effects: [{ type: 'await-gate', nodeId: n.id }] };
  return { state: { ...s, nodes, current: n.id, status: 'running' }, effects: [{ type: 'run-node', nodeId: n.id, packet: s.packet }] };
}

function pickNext(wf: Workflow, nodeId: string, outcome: 'pass' | 'fail'): string | null {
  const out = outgoing(wf, nodeId);
  return (out.find((e) => e.when === outcome) ?? out.find((e) => !e.when && outcome === 'pass'))?.to ?? null;
}

/**
 * The run state machine (M6-T01): a pure reducer from events to state plus effects. The runner persists every
 * state it returns, so a run survives a restart and can retry from any node (WF-08).
 */
export function reduce(wf: Workflow, s: RunState, e: RunEvent): { state: RunState; effects: Effect[] } {
  switch (e.type) {
    case 'start': {
      const first = startNode(wf);
      if (!first) throw new RunError('The workflow has no single first node.');
      return enter(wf, { ...initialState(wf), packet: { ...emptyHandOff(), ...e.packet, workItem: e.workItem ?? {} } }, first.id, 'pass', e.at);
    }
    case 'node.started': {
      const nr = s.nodes[e.nodeId];
      if (!nr) throw new RunError(`Unknown node ${e.nodeId}`);
      return { state: { ...s, nodes: { ...s.nodes, [e.nodeId]: { ...nr, sessionId: e.sessionId ?? nr.sessionId, attempts: nr.attempts + 1 } } }, effects: [] };
    }
    case 'node.session': {
      const nr = s.nodes[e.nodeId];
      if (!nr) throw new RunError(`Unknown node ${e.nodeId}`);
      return { state: { ...s, nodes: { ...s.nodes, [e.nodeId]: { ...nr, sessionId: e.sessionId } } }, effects: [] };
    }
    case 'node.finished': {
      if (s.current !== e.nodeId || s.status !== 'running') throw new RunError(`${e.nodeId} is not the running node.`);
      const packet: HandOff = { ...s.packet, ...e.packet, workItem: s.packet.workItem };
      const nodes = { ...s.nodes, [e.nodeId]: { ...s.nodes[e.nodeId]!, status: e.outcome === 'pass' ? ('passed' as const) : ('failed' as const), output: packet, endedAt: e.at } };
      const used = { ...s.used, turns: s.used.turns + (e.turns ?? 0), costUsd: s.used.costUsd + (e.costUsd ?? 0) };
      const next = pickNext(wf, e.nodeId, e.outcome);
      const after = { ...s, nodes, used, packet, log: [...s.log, `${e.nodeId}: ${e.outcome}`] };
      // A failure with nowhere to go ends the run as failed.
      if (next === null && e.outcome === 'fail') return { state: { ...after, status: 'failed', current: null }, effects: [{ type: 'finished', status: 'failed' }] };
      return enter(wf, after, next, e.outcome, e.at);
    }
    case 'gate.decided': {
      if (s.current !== e.nodeId || s.status !== 'waiting-gate') throw new RunError(`${e.nodeId} is not waiting for a decision.`);
      const nodes = { ...s.nodes, [e.nodeId]: { ...s.nodes[e.nodeId]!, status: e.approved ? ('passed' as const) : ('failed' as const), endedAt: e.at } };
      const after = { ...s, nodes, status: 'running' as const, log: [...s.log, `${e.nodeId}: ${e.approved ? 'approved' : 'rejected'}`] };
      const next = pickNext(wf, e.nodeId, e.approved ? 'pass' : 'fail');
      if (!e.approved && next === null) return { state: { ...after, status: 'cancelled', current: null }, effects: [{ type: 'finished', status: 'cancelled' }] };
      return enter(wf, after, next, e.approved ? 'pass' : 'fail', e.at);
    }
    case 'tick': {
      const used = { ...s.used, minutes: s.used.minutes + e.minutes };
      const reason = s.status === 'running' ? overBudget(wf, { ...s, used }) : null;
      if (reason) return { state: { ...s, used, status: 'paused', pauseReason: reason }, effects: [{ type: 'paused', reason }] };
      return { state: { ...s, used }, effects: [] };
    }
    case 'resume': {
      if (s.status !== 'paused' || !s.current) throw new RunError('Only a paused run can resume.');
      // Resuming grants the run its budget again from here (the user chose to continue).
      const fresh = { ...s, status: 'running' as const, pauseReason: null, used: { turns: 0, minutes: 0, loops: 0, costUsd: s.used.costUsd }, loops: {} };
      return enter(wf, fresh, s.current, 'pass', e.at);
    }
    case 'retry-from': {
      node(wf, e.nodeId);
      const nodes = { ...s.nodes };
      // Every node after the retried one starts over.
      for (const id of downstream(wf, e.nodeId)) nodes[id] = blankNode();
      return enter(wf, { ...s, nodes, status: 'running', pauseReason: null, log: [...s.log, `retry from ${e.nodeId}`] }, e.nodeId, 'pass', e.at);
    }
    case 'cancel':
      return { state: { ...s, status: 'cancelled', current: null }, effects: [{ type: 'finished', status: 'cancelled' }] };
  }
}

export function downstream(wf: Workflow, fromId: string): string[] {
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of outgoing(wf, id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return [...seen];
}

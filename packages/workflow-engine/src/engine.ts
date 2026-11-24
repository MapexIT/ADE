import { backEdges, incoming, outgoing, roundLimit, startNode, type Workflow, type WorkflowNode } from './schema.ts';

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
  /** What the node received the last time it started (kept for retries). */
  input?: HandOff | null;
  startedAt: number | null;
  endedAt: number | null;
}

export type RunStatus = 'running' | 'waiting-gate' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

/** A result travelling along one edge; `null` marks an edge that was not taken (dead-path elimination). */
export interface Token {
  packet: HandOff;
  outcome: 'pass' | 'fail';
}

export interface RunState {
  status: RunStatus;
  /** The first active node, for views that show one current step. */
  current: string | null;
  /** WF-12: every node running or waiting at a gate right now (parallel branches). */
  active: string[];
  nodes: Record<string, NodeRun>;
  loops: Record<string, number>;
  /** WF-13: how many times each back edge (by index) has sent the run round its cycle. */
  rounds: Record<string, number>;
  used: { turns: number; minutes: number; loops: number; costUsd: number };
  packet: HandOff;
  pauseReason: string | null;
  log: string[];
  /** Tokens waiting at a node with several inputs, keyed by the edge's index. */
  inbox: Record<string, Record<string, Token | null>>;
  /** Nodes held back by a pause; resuming starts them. */
  blocked: { nodeId: string; token: Token }[];
  /** A branch failed with nowhere to go: the run ends as failed once every branch has stopped. */
  failedBranch: boolean;
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

const blankNode = (): NodeRun => ({ status: 'pending', attempts: 0, sessionId: null, output: null, input: null, startedAt: null, endedAt: null });

export function initialState(wf: Workflow): RunState {
  return {
    status: 'running',
    current: null,
    active: [],
    nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, blankNode()])),
    loops: {},
    rounds: {},
    used: { turns: 0, minutes: 0, loops: 0, costUsd: 0 },
    packet: emptyHandOff(),
    pauseReason: null,
    log: [],
    inbox: {},
    blocked: [],
    failedBranch: false,
  };
}

/** Older saved runs lack the fields parallel branches added; fill them in. */
export function upgradeState(wf: Workflow, s: RunState): RunState {
  const nodes = { ...s.nodes };
  for (const n of wf.nodes) nodes[n.id] ??= blankNode();
  return { ...s, nodes, active: s.active ?? (s.current ? [s.current] : []), rounds: s.rounds ?? {}, inbox: s.inbox ?? {}, blocked: s.blocked ?? [], failedBranch: s.failedBranch ?? false };
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

/** Merges what several inputs hand over: each text once, in input order. */
export function mergePackets(packets: HandOff[], workItem: Record<string, string>): HandOff {
  const join = (key: 'summary' | 'diff' | 'checkOutput', sep: string) => [...new Set(packets.map((p) => p[key]).filter((v) => v.trim()))].join(sep);
  return { summary: join('summary', '\n\n'), diff: join('diff', '\n'), checkOutput: join('checkOutput', '\n\n'), workItem };
}

type Step = { state: RunState; effects: Effect[] };

const withActive = (s: RunState, active: string[]): RunState => ({ ...s, active, current: active[0] ?? null });

/** Ends the run when no branch is running, waiting or held back. */
function settle(step: Step): Step {
  const s = step.state;
  if (s.status === 'cancelled' || s.status === 'succeeded' || s.status === 'failed') return step;
  if (s.active.length || s.blocked.length) {
    // Waiting at gates only, nothing running: the run waits for a decision.
    if (s.status !== 'paused') {
      const running = s.active.some((id) => s.nodes[id]?.status === 'running');
      return { ...step, state: { ...s, status: running ? 'running' : 'waiting-gate' } };
    }
    return step;
  }
  const status: RunStatus = s.failedBranch ? 'failed' : 'succeeded';
  return { state: { ...s, status, current: null }, effects: [...step.effects, { type: 'finished', status }] };
}

function pause(s: RunState, nodeId: string, token: Token, reason: string): Step {
  const already = s.status === 'paused';
  return {
    state: { ...s, status: 'paused', current: s.active[0] ?? s.blocked[0]?.nodeId ?? nodeId, pauseReason: already ? s.pauseReason : reason, blocked: [...s.blocked, { nodeId, token }], log: already ? s.log : [...s.log, `paused: ${reason}`] },
    effects: already ? [] : [{ type: 'paused', reason }],
  };
}

/** Starts `nodeId` with what it received, resolving control nodes (loop, branch) inline. */
function enter(wf: Workflow, s: RunState, nodeId: string, token: Token, at: number): Step {
  if (s.status === 'paused') return pause(s, nodeId, token, s.pauseReason ?? 'Paused');
  const n = node(wf, nodeId);
  const budget = overBudget(wf, s);
  if (budget) return pause(s, nodeId, token, budget);

  if (n.type === 'loop') {
    const count = (s.loops[n.id] ?? 0) + 1;
    const after = { ...s, loops: { ...s.loops, [n.id]: count }, used: { ...s.used, loops: s.used.loops + 1 } };
    if (count > n.max) return pause(after, nodeId, token, `${n.id} looped ${n.max} times without passing.`);
    // A loop node lets the run through: it continues as a pass along its next edge.
    return finish(wf, { ...after, log: [...after.log, `${n.id}: attempt ${count} of ${n.max}`] }, n.id, 'pass', token.packet, at);
  }
  if (n.type === 'branch') {
    const outcome = token.outcome === n.condition ? 'pass' : 'fail';
    return finish(wf, s, n.id, outcome, token.packet, at, { quiet: true });
  }
  const nodes = { ...s.nodes, [n.id]: { ...s.nodes[n.id]!, status: n.type === 'gate' ? ('waiting' as const) : ('running' as const), startedAt: at, input: token.packet } };
  const next = withActive({ ...s, nodes, packet: token.packet }, [...s.active.filter((x) => x !== n.id), n.id]);
  if (n.type === 'gate') return { state: next, effects: [{ type: 'await-gate', nodeId: n.id }] };
  return { state: { ...next, status: 'running' }, effects: [{ type: 'run-node', nodeId: n.id, packet: token.packet }] };
}

/** The nodes a back edge sends round again: on a forward path from its target to its source. */
export function cycleRegion(wf: Workflow, edgeIndex: number): string[] {
  const edge = wf.edges[edgeIndex]!;
  const back = backEdges(wf);
  const forward = wf.edges.map((e, i) => ({ e, i })).filter(({ i }) => !back.has(i));
  const reach = (from: string, dir: 'out' | 'in') => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length) {
      const id = queue.shift()!;
      for (const { e } of forward) {
        const [a, b] = dir === 'out' ? [e.from, e.to] : [e.to, e.from];
        if (a === id && !seen.has(b)) {
          seen.add(b);
          queue.push(b);
        }
      }
    }
    return seen;
  };
  const fromTarget = reach(edge.to, 'out');
  const toSource = reach(edge.from, 'in');
  return wf.nodes.map((n) => n.id).filter((id) => fromTarget.has(id) && toSource.has(id));
}

/** Delivers a token (or a skip) along edge `i`, starting the target when every input it waits for has arrived. */
function deliver(wf: Workflow, s: RunState, i: number, token: Token | null, at: number): Step {
  const edge = wf.edges[i]!;
  const back = backEdges(wf);
  if (back.has(i)) {
    if (!token) return { state: s, effects: [] };
    // WF-13: a back edge sends the run round its cycle, at most `maxRounds` times (default 1).
    const max = roundLimit(wf, i, cycleRegion(wf, i));
    const used = s.rounds[String(i)] ?? 0;
    if (used >= max) return pause(s, edge.to, token, `The cycle back to ${edge.to} reached its limit of ${max} round${max === 1 ? '' : 's'}.`);
    const region = new Set(cycleRegion(wf, i));
    const nodes = { ...s.nodes };
    const inbox = { ...s.inbox };
    for (const id of region) {
      if (!s.active.includes(id)) nodes[id] = { ...blankNode(), attempts: s.nodes[id]?.attempts ?? 0, sessionId: s.nodes[id]?.sessionId ?? null };
      // Inputs from outside the cycle arrived once and stay; inputs from inside must arrive again.
      const box = inbox[id];
      if (box) inbox[id] = Object.fromEntries(Object.entries(box).filter(([k]) => !region.has(wf.edges[Number(k)]!.from)));
    }
    const after = { ...s, nodes, inbox, rounds: { ...s.rounds, [String(i)]: used + 1 }, log: [...s.log, `round ${used + 1} of ${max}: back to ${edge.to}`] };
    return enter(wf, after, edge.to, token, at);
  }
  const target = edge.to;
  const waitsFor = incoming(wf, target).filter((x) => !back.has(x.index));
  const box = { ...(s.inbox[target] ?? {}), [String(i)]: token };
  if (waitsFor.some((x) => !(String(x.index) in box))) return { state: { ...s, inbox: { ...s.inbox, [target]: box } }, effects: [] };
  // Every input has arrived: clear the inbox, then run with the merged inputs, or skip when none was taken.
  const inbox = { ...s.inbox };
  delete inbox[target];
  const live = waitsFor.map((x) => box[String(x.index)]).filter((t): t is Token => !!t);
  if (!live.length) {
    const skipped = { ...s, inbox, nodes: { ...s.nodes, [target]: { ...s.nodes[target]!, status: 'skipped' as const } } };
    return propagate(wf, skipped, target, null, at);
  }
  const merged: Token = live.length === 1 ? live[0]! : { packet: mergePackets(live.map((t) => t.packet), s.packet.workItem), outcome: live.some((t) => t.outcome === 'fail') ? 'fail' : 'pass' };
  return enter(wf, { ...s, inbox }, target, merged, at);
}

/** Sends a node's result down every edge it takes, and a skip down every forward edge it does not. */
function propagate(wf: Workflow, s: RunState, nodeId: string, result: Token | null, at: number): Step {
  let state = s;
  const effects: Effect[] = [];
  const out = outgoing(wf, nodeId);
  const taken = (e: (typeof out)[number]) => !!result && (e.when ? e.when === result.outcome : result.outcome === 'pass');
  if (result && result.outcome === 'fail' && !out.some(taken)) state = { ...state, failedBranch: true, log: [...state.log, `${nodeId}: failed with no next step`] };
  for (const e of out) {
    const step = deliver(wf, state, e.index, taken(e) ? result : null, at);
    state = step.state;
    effects.push(...step.effects);
    if (state.status === 'cancelled') break;
  }
  return { state, effects };
}

function finish(wf: Workflow, s: RunState, nodeId: string, outcome: 'pass' | 'fail', packet: HandOff, at: number, opts: { quiet?: boolean } = {}): Step {
  const nodes = { ...s.nodes, [nodeId]: { ...s.nodes[nodeId]!, status: outcome === 'pass' ? ('passed' as const) : ('failed' as const), output: packet, endedAt: at } };
  const after = withActive({ ...s, nodes, packet, log: opts.quiet ? s.log : [...s.log, `${nodeId}: ${outcome}`] }, s.active.filter((x) => x !== nodeId));
  return propagate(wf, after, nodeId, { packet, outcome }, at);
}

/**
 * The run state machine (M6-T01, WF-12, WF-13): a pure reducer from events to state plus effects. Results travel
 * as tokens along edges: a node may send to several next steps at once (they run in parallel), a node with several
 * inputs waits for each of them (an input not taken arrives as a skip), and a back edge sends the run round its
 * cycle at most `maxRounds` times. The runner persists every state, so a run survives a restart (WF-08).
 */
export function reduce(wf: Workflow, s0: RunState, e: RunEvent): Step {
  const s = upgradeState(wf, s0);
  switch (e.type) {
    case 'start': {
      const first = startNode(wf);
      if (!first) throw new RunError('The workflow has no steps yet.');
      const packet = { ...emptyHandOff(), ...e.packet, workItem: e.workItem ?? {} };
      return settle(enter(wf, { ...initialState(wf), packet }, first.id, { packet, outcome: 'pass' }, e.at));
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
      // A branch still running when the run was cancelled or another branch failed it: nothing to do.
      if (s.status === 'cancelled' || s.status === 'succeeded' || s.status === 'failed') return { state: s, effects: [] };
      if (!s.active.includes(e.nodeId) || s.nodes[e.nodeId]?.status !== 'running') throw new RunError(`${e.nodeId} is not running.`);
      const base = s.nodes[e.nodeId]!.input ?? s.packet;
      const packet: HandOff = { ...base, ...e.packet, workItem: s.packet.workItem };
      const used = { ...s.used, turns: s.used.turns + (e.turns ?? 0), costUsd: s.used.costUsd + (e.costUsd ?? 0) };
      return settle(finish(wf, { ...s, used }, e.nodeId, e.outcome, packet, e.at));
    }
    case 'gate.decided': {
      if (!s.active.includes(e.nodeId) || s.nodes[e.nodeId]?.status !== 'waiting') throw new RunError(`${e.nodeId} is not waiting for a decision.`);
      const packet = s.nodes[e.nodeId]!.input ?? s.packet;
      const outcome = e.approved ? 'pass' : 'fail';
      const rejectedEnd = !e.approved && !outgoing(wf, e.nodeId).some((x) => x.when === 'fail');
      const nodes = { ...s.nodes, [e.nodeId]: { ...s.nodes[e.nodeId]!, status: e.approved ? ('passed' as const) : ('failed' as const), output: packet, endedAt: e.at } };
      const logged = { ...s, nodes, log: [...s.log, `${e.nodeId}: ${e.approved ? 'approved' : 'rejected'}`] };
      // Rejecting a gate that has nowhere to go stops the whole run.
      if (rejectedEnd) return { state: { ...withActive(logged, []), status: 'cancelled', blocked: [] }, effects: [{ type: 'finished', status: 'cancelled' }] };
      return settle(propagate(wf, withActive({ ...logged, status: 'running' }, s.active.filter((x) => x !== e.nodeId)), e.nodeId, { packet, outcome }, e.at));
    }
    case 'tick': {
      const used = { ...s.used, minutes: s.used.minutes + e.minutes };
      const reason = s.status === 'running' ? overBudget(wf, { ...s, used }) : null;
      if (reason) return { state: { ...s, used, status: 'paused', pauseReason: reason, log: [...s.log, `paused: ${reason}`] }, effects: [{ type: 'paused', reason }] };
      return { state: { ...s, used }, effects: [] };
    }
    case 'resume': {
      if (s.status !== 'paused') throw new RunError('Only a paused run can resume.');
      // Resuming grants the run its budget, loops and cycle rounds again from here (the user chose to continue).
      let step: Step = { state: { ...s, status: 'running', pauseReason: null, blocked: [], used: { turns: 0, minutes: 0, loops: 0, costUsd: s.used.costUsd }, loops: {}, rounds: {} }, effects: [] };
      for (const b of s.blocked) {
        const next = enter(wf, step.state, b.nodeId, b.token, e.at);
        step = { state: next.state, effects: [...step.effects, ...next.effects] };
      }
      return settle(step);
    }
    case 'retry-from': {
      const target = node(wf, e.nodeId);
      const nodes = { ...s.nodes };
      const reset = new Set(downstream(wf, target.id));
      // Every node after the retried one starts over; their pending inputs are dropped.
      for (const id of reset) nodes[id] = { ...blankNode(), input: s.nodes[id]?.input ?? null };
      const inbox = Object.fromEntries(Object.entries(s.inbox).filter(([id]) => !reset.has(id)));
      const packet = s.nodes[target.id]?.input ?? s.packet;
      const fresh = withActive({ ...s, nodes, inbox, status: 'running', pauseReason: null, blocked: [], failedBranch: false, log: [...s.log, `retry from ${target.id}`] }, s.active.filter((x) => !reset.has(x)));
      return settle(enter(wf, fresh, target.id, { packet, outcome: 'pass' }, e.at));
    }
    case 'cancel':
      return { state: { ...withActive(s, []), status: 'cancelled', blocked: [] }, effects: [{ type: 'finished', status: 'cancelled' }] };
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

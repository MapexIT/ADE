import { AgentId, PermissionProfile } from '@ade/contracts';
import { parse } from 'yaml';
import { z } from 'zod';

const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'ids are lower-case letters, digits and dashes');

const base = { id: Id, title: z.string().max(120).optional() };

export const AgentNode = z.object({
  ...base,
  type: z.literal('agent'),
  agent: AgentId,
  model: z.string().optional(),
  prompt: z.string().min(1),
  profile: PermissionProfile.default('ask'),
  skills: z.array(z.string()).default([]),
});
export const CommandNode = z.object({ ...base, type: z.literal('command'), run: z.array(z.string()).min(1) });
export const GateNode = z.object({ ...base, type: z.literal('gate'), question: z.string().default('Review before continuing') });
export const LoopNode = z.object({ ...base, type: z.literal('loop'), max: z.number().int().min(1).max(20) });
export const BranchNode = z.object({ ...base, type: z.literal('branch'), condition: z.enum(['pass', 'fail']) });
export const ConnectorNode = z.object({ ...base, type: z.literal('connector'), connector: z.enum(['shortcut', 'github']), action: z.string().min(1) });
export const LandNode = z.object({ ...base, type: z.literal('land'), mode: z.enum(['apply', 'commit', 'pull-request']) });

export type AgentNode = z.infer<typeof AgentNode>;
export type CommandNode = z.infer<typeof CommandNode>;
export type GateNode = z.infer<typeof GateNode>;
export type LoopNode = z.infer<typeof LoopNode>;
export type BranchNode = z.infer<typeof BranchNode>;
export type ConnectorNode = z.infer<typeof ConnectorNode>;
export type LandNode = z.infer<typeof LandNode>;

export const WorkflowNode = z.discriminatedUnion('type', [AgentNode, CommandNode, GateNode, LoopNode, BranchNode, ConnectorNode, LandNode]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;
export type NodeType = WorkflowNode['type'];

/**
 * An edge. Several edges may leave one node (they run in parallel) and several may enter one (it waits for each).
 * `maxRounds` (WF-17) applies to an edge that closes a cycle: how many times the run may go round it; default 1.
 */
export const Edge = z.object({ from: Id, to: Id, when: z.enum(['pass', 'fail']).optional(), maxRounds: z.number().int().min(1).max(50).optional() });
export type Edge = z.infer<typeof Edge>;

export const Budgets = z.object({
  minutes: z.number().positive().optional(),
  turns: z.number().int().positive().optional(),
  loops: z.number().int().positive().optional(),
  costUsd: z.number().positive().optional(),
});
export type Budgets = z.infer<typeof Budgets>;

/** WF-03: a workflow file in `.ade/workflows/*.yaml`, versioned with the code. */
export const Workflow = z.object({
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  trigger: z.enum(['manual', 'work-item', 'failed-check', 'ready-session', 'terminal-command']).default('manual'),
  budgets: Budgets.default({}),
  /** May be empty while a workflow is being drawn from scratch; it cannot run until it has a first step. */
  nodes: z.array(WorkflowNode).default([]),
  edges: z.array(Edge).default([]),
});
export type Workflow = z.infer<typeof Workflow>;

export interface Problem {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export type IndexedEdge = Edge & { index: number };

export function outgoing(wf: Workflow, nodeId: string): IndexedEdge[] {
  return wf.edges.flatMap((e, index) => (e.from === nodeId ? [{ ...e, index }] : []));
}

export function incoming(wf: Workflow, nodeId: string): IndexedEdge[] {
  return wf.edges.flatMap((e, index) => (e.to === nodeId ? [{ ...e, index }] : []));
}

const backCache = new WeakMap<Workflow, Set<number>>();

/**
 * WF-17: the edges that close a cycle, found by a depth-first walk in edge order: first from every node nothing leads
 * into (in the order listed), then from any node not reached yet, in the order listed. Every cycle has exactly one,
 * and the run follows it at most its `maxRounds` times. Walking from the true starts first means a cycle is entered
 * where a start leads into it, so its first step there is not mistaken for a step the run starts with.
 */
export function backEdges(wf: Workflow): Set<number> {
  const cached = backCache.get(wf);
  if (cached) return cached;
  const back = new Set<number>();
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string) => {
    state.set(id, 'open');
    for (const e of outgoing(wf, id)) {
      const st = state.get(e.to);
      if (st === 'open') back.add(e.index);
      else if (!st) visit(e.to);
    }
    state.set(id, 'done');
  };
  const led = new Set(wf.edges.map((e) => e.to));
  for (const n of wf.nodes) if (!led.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of wf.nodes) if (!state.has(n.id)) visit(n.id);
  backCache.set(wf, back);
  return back;
}

/** WF-17: each cycle as its back edge, the nodes on it and its round limit, for the editor. */
export function cycles(wf: Workflow): { edgeIndex: number; nodes: string[]; maxRounds: number }[] {
  return [...backEdges(wf)].map((i) => {
    const e = wf.edges[i]!;
    // Nodes on a forward path from the back edge's target to its source.
    const back = backEdges(wf);
    const fwd = wf.edges.filter((_, j) => !back.has(j));
    const reach = (from: string, out: boolean) => {
      const seen = new Set([from]);
      const q = [from];
      while (q.length) {
        const id = q.shift()!;
        for (const x of fwd) {
          const [a, b] = out ? [x.from, x.to] : [x.to, x.from];
          if (a === id && !seen.has(b)) {
            seen.add(b);
            q.push(b);
          }
        }
      }
      return seen;
    };
    const a = reach(e.to, true);
    const b = reach(e.from, false);
    const nodes = wf.nodes.map((n) => n.id).filter((id) => a.has(id) && b.has(id));
    return { edgeIndex: i, nodes, maxRounds: roundLimit(wf, i, nodes) };
  });
}

/**
 * WF-17: how many times a back edge may send the run round its cycle: its own `maxRounds`; otherwise the limit of a
 * loop node on the cycle (so workflows written before round limits keep their retries); otherwise 1.
 */
export function roundLimit(wf: Workflow, edgeIndex: number, cycleNodes?: string[]): number {
  const e = wf.edges[edgeIndex]!;
  if (e.maxRounds !== undefined) return e.maxRounds;
  const on = new Set(cycleNodes ?? cycles(wf).find((c) => c.edgeIndex === edgeIndex)?.nodes ?? []);
  const loops = wf.nodes.filter((n): n is LoopNode => n.type === 'loop' && on.has(n.id));
  return loops.length ? Math.max(...loops.map((l) => l.max)) : 1;
}

/**
 * WF-18: the steps a run starts with: every step whose only inputs, if any, are back edges of cycles (so the first
 * step inside a retry cycle still counts). They all start together when the run starts. When no step qualifies, the
 * first step listed starts, as before; an empty workflow has none.
 */
export function startNodes(wf: Workflow): WorkflowNode[] {
  const back = backEdges(wf);
  const starts = wf.nodes.filter((n) => incoming(wf, n.id).every((e) => back.has(e.index)));
  return starts.length ? starts : wf.nodes.slice(0, 1);
}

/** Structural rules beyond the schema. Errors block running; warnings are shown in the editor. */
export function validate(wf: Workflow): Problem[] {
  const problems: Problem[] = [];
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) problems.push({ level: 'error', message: `Two nodes are called ${n.id}.`, nodeId: n.id });
    ids.add(n.id);
  }
  for (const e of wf.edges) {
    if (!ids.has(e.from)) problems.push({ level: 'error', message: `An edge starts at unknown node ${e.from}.` });
    if (!ids.has(e.to)) problems.push({ level: 'error', message: `An edge ends at unknown node ${e.to}.` });
  }
  if (problems.length) return problems;

  const starts = startNodes(wf).map((n) => n.id);
  if (!starts.length) return [{ level: 'error', message: 'This workflow has no steps yet. Add a first step from the palette.' }];

  // Reachability from every start.
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of outgoing(wf, id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  for (const n of wf.nodes) if (!seen.has(n.id)) problems.push({ level: 'error', message: `${n.id} can never run: nothing leads to it.`, nodeId: n.id });

  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  // A gate must stand between the last agent and any land node, on every path (docs/ARCHITECTURE.md section 8).
  const visited = new Set<string>();
  const stack: { id: string; gated: boolean }[] = starts.map((id) => ({ id, gated: true }));
  while (stack.length) {
    const { id, gated: before } = stack.pop()!;
    const node = byId.get(id)!;
    const gated = node.type === 'agent' ? false : node.type === 'gate' ? true : before;
    if (node.type === 'land' && !before) problems.push({ level: 'error', message: `${id} can land code that no gate reviewed. Put a gate after the last agent.`, nodeId: id });
    const key = `${id}|${gated}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const e of outgoing(wf, id)) stack.push({ id: e.to, gated });
  }

  // WF-17: every cycle is bounded by its back edge's round limit (default 1), so cycles need no loop node.
  const back = backEdges(wf);
  wf.edges.forEach((e, i) => {
    if (e.maxRounds !== undefined && !back.has(i)) problems.push({ level: 'warning', message: `The round limit on ${e.from} → ${e.to} has no effect: that edge does not close a cycle.` });
  });

  for (const n of wf.nodes) {
    const out = outgoing(wf, n.id);
    // WF-18: a step with no connections is a start of its own; say so, as it is often a step not wired up yet.
    if (wf.nodes.length > 1 && !out.length && !incoming(wf, n.id).length) {
      problems.push({ level: 'warning', message: `${n.id} is not connected to any other step, so it runs on its own when the run starts.`, nodeId: n.id });
    }
    // WF-16: several unmarked next steps run in parallel; say so where it may be a surprise.
    if (n.type === 'branch' && out.length > 1 && out.every((e) => !e.when)) {
      problems.push({ level: 'warning', message: `${n.id} is a branch, but none of its edges says pass or fail, so every next step runs.`, nodeId: n.id });
    }
    if (n.type === 'agent' && n.profile === 'autonomous') {
      problems.push({ level: 'warning', message: `${n.id} runs without approvals; it only starts when its session is sandboxed.`, nodeId: n.id });
    }
  }
  return problems;
}

export class WorkflowError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => p.message).join('\n'));
    this.name = 'WorkflowError';
    this.problems = problems;
  }
}

/** Parses and validates a workflow YAML file. Throws `WorkflowError` with every problem found. */
export function parseWorkflow(yamlText: string): Workflow {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new WorkflowError([{ level: 'error', message: `The YAML is invalid: ${(err as Error).message}` }]);
  }
  const parsed = Workflow.safeParse(raw);
  if (!parsed.success) throw new WorkflowError(parsed.error.issues.map((i) => ({ level: 'error', message: `${i.path.join('.')}: ${i.message}` })));
  const errors = validate(parsed.data).filter((p) => p.level === 'error');
  if (errors.length) throw new WorkflowError(errors);
  return parsed.data;
}

/** One line describing a node, shown on the canvas. */
export function describeNode(n: WorkflowNode): string {
  switch (n.type) {
    case 'agent':
      return `${n.agent}${n.model ? ` (${n.model})` : ''} · ${n.profile}${n.skills.length ? ` · skills: ${n.skills.join(', ')}` : ''}`;
    case 'command':
      return n.run.join(' ');
    case 'gate':
      return n.question;
    case 'loop':
      return `up to ${n.max} times`;
    case 'branch':
      return `on ${n.condition}`;
    case 'connector':
      return `${n.connector} · ${n.action}`;
    case 'land':
      return n.mode;
  }
}

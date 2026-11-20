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

export const WorkflowNode = z.discriminatedUnion('type', [AgentNode, CommandNode, GateNode, LoopNode, BranchNode, ConnectorNode, LandNode]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;
export type NodeType = WorkflowNode['type'];

export const Edge = z.object({ from: Id, to: Id, when: z.enum(['pass', 'fail']).optional() });
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
  nodes: z.array(WorkflowNode).min(1),
  edges: z.array(Edge).default([]),
});
export type Workflow = z.infer<typeof Workflow>;

export interface Problem {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export function outgoing(wf: Workflow, nodeId: string): Edge[] {
  return wf.edges.filter((e) => e.from === nodeId);
}

/** The first node listed runs first. (It may sit inside a retry cycle, so "no incoming edge" is not a rule.) */
export function startNode(wf: Workflow): WorkflowNode | null {
  return wf.nodes[0] ?? null;
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

  const start = startNode(wf);
  if (!start) return problems;

  // Reachability.
  const seen = new Set<string>([start.id]);
  const queue = [start.id];
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
  const stack: { id: string; gated: boolean }[] = [{ id: start.id, gated: true }];
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

  // Cycles need a bound: a loop node on the cycle, or a loop budget.
  const onStack = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string, path: string[]): void => {
    onStack.add(id);
    for (const e of outgoing(wf, id)) {
      if (onStack.has(e.to)) {
        const cycle = [...path.slice(path.indexOf(e.to)), id];
        const bounded = cycle.some((c) => byId.get(c)?.type === 'loop') || wf.budgets.loops !== undefined;
        if (!bounded) problems.push({ level: 'error', message: `The cycle ${cycle.join(' → ')} has no limit. Add a loop node or a loop budget.` });
      } else if (!done.has(e.to)) dfs(e.to, [...path, e.to]);
    }
    onStack.delete(id);
    done.add(id);
  };
  dfs(start.id, [start.id]);

  for (const n of wf.nodes) {
    const out = outgoing(wf, n.id);
    if ((n.type === 'command' || n.type === 'branch') && out.length > 1 && out.some((e) => !e.when)) {
      problems.push({ level: 'error', message: `${n.id} has several next steps; mark each edge with pass or fail.`, nodeId: n.id });
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

import { backEdges, cycles, incoming, outgoing, roundLimit, startNodes, validate, Workflow, type Edge, type NodeType, type Problem, type WorkflowNode } from '@ade/workflow-engine';

/**
 * Pure edits over a workflow being designed (WF-01). Every function returns a new workflow, so the canvas can
 * undo by keeping old values and tests need no React.
 */
export type Draft = Workflow;

export const NODE_TYPES: { type: NodeType; label: string }[] = [
  { type: 'agent', label: 'Agent' },
  { type: 'command', label: 'Command' },
  { type: 'gate', label: 'Gate' },
  { type: 'loop', label: 'Loop' },
  { type: 'branch', label: 'Branch' },
  { type: 'connector', label: 'Connector' },
  { type: 'land', label: 'Land' },
];

/** Reads a parsed YAML value into a draft, filling defaults. Null when it does not match the schema. */
export function toDraft(definition: unknown): Draft | null {
  const parsed = Workflow.safeParse(definition);
  return parsed.success ? parsed.data : null;
}

export function uniqueId(wf: Draft, base: string): string {
  const ids = new Set(wf.nodes.map((n) => n.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function defaultsFor(type: NodeType, id: string): WorkflowNode {
  switch (type) {
    case 'agent':
      return {
        id,
        type,
        agent: 'claude-code',
        prompt: 'Describe the task. {{summary}}',
        profile: 'ask',
        skills: [],
      };
    case 'command':
      return { id, type, run: ['pnpm', 'test'] };
    case 'gate':
      return { id, type, question: 'Review before continuing' };
    case 'loop':
      return { id, type, max: 3 };
    case 'branch':
      return { id, type, condition: 'pass' };
    case 'connector':
      return { id, type, connector: 'github', action: 'comment' };
    case 'land':
      return { id, type, mode: 'commit' };
  }
}

export function addNode(wf: Draft, type: NodeType): { wf: Draft; id: string } {
  const id = uniqueId(wf, type);
  return { wf: { ...wf, nodes: [...wf.nodes, defaultsFor(type, id)] }, id };
}

export function removeNode(wf: Draft, id: string): Draft {
  return {
    ...wf,
    nodes: wf.nodes.filter((n) => n.id !== id),
    edges: wf.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/** Changes a node. A new id is carried over to every edge that used the old one. */
export function updateNode(wf: Draft, id: string, next: WorkflowNode): Draft {
  const rename = (x: string) => (x === id ? next.id : x);
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n.id === id ? next : n)),
    edges:
      next.id === id ? wf.edges : wf.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) })),
  };
}

export function connect(wf: Draft, from: string, to: string): Draft {
  if (from === to || wf.edges.some((e) => e.from === from && e.to === to)) return wf;
  return { ...wf, edges: [...wf.edges, { from, to }] };
}

/** Clicking an edge cycles its condition: always, on pass, on fail. */
export function cycleEdge(wf: Draft, index: number): Draft {
  return {
    ...wf,
    edges: wf.edges.map((e, i) => {
      if (i !== index) return e;
      const { when, ...rest } = e;
      return when === undefined
        ? { ...rest, when: 'pass' as const }
        : when === 'pass'
          ? { ...rest, when: 'fail' as const }
          : rest;
    }),
  };
}

/** WF-16 / WF-17: changes one edge: when it applies, and (for an edge that closes a cycle) its round limit. */
export function setEdge(wf: Draft, index: number, patch: { when?: Edge['when'] | null; maxRounds?: number | null }): Draft {
  return {
    ...wf,
    edges: wf.edges.map((e, i) => {
      if (i !== index) return e;
      const next: Edge = { ...e };
      if (patch.when !== undefined) {
        if (patch.when === null) delete next.when;
        else next.when = patch.when;
      }
      if (patch.maxRounds !== undefined) {
        if (patch.maxRounds === null) delete next.maxRounds;
        else next.maxRounds = Math.min(50, Math.max(1, Math.round(patch.maxRounds)));
      }
      return next;
    }),
  };
}

/** WF-17: what the editor says about an edge: whether it closes a cycle, the steps on it and its round limit. */
export function edgeInfo(wf: Draft, index: number): { cycle: boolean; steps: string[]; maxRounds: number } {
  const c = cycles(wf).find((x) => x.edgeIndex === index);
  return c ? { cycle: true, steps: c.nodes, maxRounds: c.maxRounds } : { cycle: false, steps: [], maxRounds: 1 };
}

/** WF-16: how many inputs a step waits for and how many next steps it can start. */
export function fanOf(wf: Draft, id: string): { inputs: number; outputs: number } {
  const back = backEdges(wf);
  return { inputs: incoming(wf, id).filter((e) => !back.has(e.index)).length, outputs: outgoing(wf, id).length };
}

/** A new, empty workflow: no steps yet. */
export const emptyDraft = (name: string): Draft => Workflow.parse({ name: name.trim() || 'New workflow' });

export { roundLimit };

export function removeEdge(wf: Draft, index: number): Draft {
  return { ...wf, edges: wf.edges.filter((_, i) => i !== index) };
}

/**
 * Moves a step to the front. A run starts at every step nothing leads into (WF-18); in a cycle that no start leads
 * into, the step listed first is where the run enters it, so moving it first makes it a start.
 */
export function makeStart(wf: Draft, id: string): Draft {
  const node = wf.nodes.find((n) => n.id === id);
  return node ? { ...wf, nodes: [node, ...wf.nodes.filter((n) => n.id !== id)] } : wf;
}

/** WF-18: whether a run starts at this step. */
export function isStart(wf: Draft, id: string): boolean {
  return startNodes(wf).some((n) => n.id === id);
}

/** WF-18: whether "Start here" can make this step a start: only a step on a cycle no start leads into. */
export function canStartHere(wf: Draft, id: string): boolean {
  return !isStart(wf, id) && isStart(makeStart(wf, id), id);
}

/** Schema and structure problems, as the host would report them on save or run. */
export function problemsOf(wf: Draft): Problem[] {
  const parsed = Workflow.safeParse(wf);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({
      level: 'error' as const,
      message: `${i.path.join('.')}: ${i.message}`,
    }));
  return validate(parsed.data);
}

export function fileNameFor(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'workflow';
  return `${slug}.yaml`;
}

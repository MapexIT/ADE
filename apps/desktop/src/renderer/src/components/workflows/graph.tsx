import { MarkerType, Position, type Edge, type Node } from '@xyflow/react';
import { palette } from '@ade/ui';
import type { WorkflowRunView } from '@ade/contracts';

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  detail: string;
  status?: WorkflowRunView['nodes'][number]['status'];
}

export interface GraphEdge {
  from: string;
  to: string;
  when?: 'pass' | 'fail' | null | undefined;
}

export const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  command: 'Command',
  gate: 'Gate',
  loop: 'Loop',
  branch: 'Branch',
  connector: 'Connector',
  land: 'Land',
};

/** Every status has a word as well as a colour (UI rule), and only the three palette hues are used. */
export const STATUS: Record<
  NonNullable<GraphNode['status']>,
  { label: string; border: string; background: string }
> = {
  pending: { label: 'Not started', border: 'var(--line)', background: 'var(--surface)' },
  running: { label: 'Running', border: 'var(--accent)', background: 'var(--accent-tint)' },
  passed: { label: 'Passed', border: 'var(--accent-soft)', background: 'var(--surface)' },
  failed: { label: 'Failed', border: 'var(--danger-line)', background: 'var(--danger-tint)' },
  waiting: { label: 'Waiting for you', border: 'var(--attention-line)', background: 'var(--attention-tint)' },
  skipped: { label: 'Skipped', border: 'var(--line)', background: 'var(--surface)' },
};

/** Layered left-to-right layout: each node sits one column after the first node that reaches it. */
function columns(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const depth = new Map<string, number>();
  const first = nodes[0]?.id;
  if (!first) return depth;
  depth.set(first, 0);
  const queue = [first];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges.filter((x) => x.from === id)) {
      if (depth.has(e.to)) continue;
      depth.set(e.to, depth.get(id)! + 1);
      queue.push(e.to);
    }
  }
  // Unconnected nodes go after the last column so they stay visible while editing.
  const last = Math.max(0, ...depth.values()) + 1;
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, last);
  return depth;
}

export function buildGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: {
    problemNodes?: Set<string>;
    selected?: string | null;
    positions?: Record<string, { x: number; y: number }>;
  } = {},
): { nodes: Node[]; edges: Edge[] } {
  const depth = columns(nodes, edges);
  const rows = new Map<number, number>();
  const out: Node[] = nodes.map((n, index) => {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const status = n.status ? STATUS[n.status] : null;
    const gate = n.type === 'gate';
    const border = opts.problemNodes?.has(n.id)
      ? 'var(--danger-line)'
      : (status?.border ??
        (gate ? 'var(--attention-line)' : n.type === 'agent' ? 'var(--accent)' : 'var(--line)'));
    return {
      id: n.id,
      position: opts.positions?.[n.id] ?? { x: col * 240, y: row * 130 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: opts.selected === n.id,
      ariaLabel: `${TYPE_LABELS[n.type] ?? n.type} step ${n.title}${status ? `, ${status.label}` : ''}`,
      data: {
        label: (
          <div className="flex flex-col gap-0.5 text-left">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
              {TYPE_LABELS[n.type] ?? n.type}
              {index === 0 ? ' · start' : ''}
            </span>
            <span className="font-semibold text-ink">{n.title}</span>
            <span className="truncate text-[11px] text-ink-muted">{n.detail}</span>
            {status ? <span className="text-[11px] font-semibold text-ink">{status.label}</span> : null}
          </div>
        ),
      },
      style: {
        width: 200,
        background: status?.background ?? (gate ? 'var(--attention-tint)' : 'var(--surface)'),
        border: `${opts.selected === n.id ? 2 : 1}px solid ${opts.selected === n.id ? 'var(--accent-soft)' : border}`,
        borderRadius: 10,
        color: 'var(--ink)',
        padding: 10,
      },
    };
  });
  const flowEdges: Edge[] = edges.map((e, i) => {
    const fail = e.when === 'fail';
    const colour = fail ? 'var(--danger)' : 'var(--accent)';
    return {
      id: `e${i}`,
      type: 'smoothstep',
      source: e.from,
      target: e.to,
      label: e.when ? `on ${e.when}` : undefined,
      animated: fail,
      markerEnd: { type: MarkerType.ArrowClosed, color: fail ? palette.white : palette.accent },
      style: { stroke: colour },
      labelStyle: { fill: palette.ink, fontSize: 11 },
      labelBgStyle: { fill: palette.surfaceRaised },
    };
  });
  return { nodes: out, edges: flowEdges };
}

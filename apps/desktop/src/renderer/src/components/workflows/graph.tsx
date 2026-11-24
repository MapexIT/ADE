import { BaseEdge, MarkerType, Position, type Edge, type EdgeProps, type Node } from '@xyflow/react';
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
  /** WF-13: this edge closes a cycle; `maxRounds` is its limit and `rounds` how many a run has used. */
  cycle?: boolean | undefined;
  maxRounds?: number | null | undefined;
  rounds?: number | undefined;
}

/** How far below the steps a cycle's way back runs. */
const RETURN_DROP = 90;

/**
 * WF-13: a connection that closes a cycle goes back under the graph instead of across the steps: out of the source,
 * down, back along the bottom, and up into the target. Its label sits on the bottom stretch.
 */
export function CycleEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, labelBgStyle, interactionWidth, data }: EdgeProps) {
  // Below every step (the graph passes its lowest point), so the way back never crosses a step.
  const below = (data as { below?: number } | undefined)?.below ?? 0;
  const bottom = Math.max(Math.max(sourceY, targetY) + RETURN_DROP, below);
  const out = sourceX + 18;
  const back = targetX - 18;
  const r = 10;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `H ${out - r} Q ${out} ${sourceY} ${out} ${sourceY + r}`,
    `V ${bottom - r} Q ${out} ${bottom} ${out - r} ${bottom}`,
    `H ${back + r} Q ${back} ${bottom} ${back} ${bottom - r}`,
    `V ${targetY + r} Q ${back} ${targetY} ${back + r} ${targetY}`,
    `H ${targetX}`,
  ].join(' ');
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={(out + back) / 2}
      labelY={bottom}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelShowBg
      labelBgPadding={[6, 3]}
      labelBgBorderRadius={4}
      interactionWidth={interactionWidth ?? 20}
    />
  );
}

export const EDGE_TYPES = { cycle: CycleEdge };

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
    selectedEdge?: number | null;
    positions?: Record<string, { x: number; y: number }>;
  } = {},
): { nodes: Node[]; edges: Edge[] } {
  // Cycle edges go backwards; leave them out of the layering so steps stay in reading order.
  const depth = columns(nodes, edges.filter((e) => !e.cycle));
  const rows = new Map<number, number>();
  const inputs = (id: string) => edges.filter((e) => e.to === id && !e.cycle).length;
  const outputs = (id: string) => edges.filter((e) => e.from === id).length;
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
            {inputs(n.id) > 1 || outputs(n.id) > 1 ? (
              <span className="text-[11px] text-accent-soft">
                {[inputs(n.id) > 1 ? `waits for ${inputs(n.id)} inputs` : '', outputs(n.id) > 1 ? `${outputs(n.id)} next steps` : ''].filter(Boolean).join(' · ')}
              </span>
            ) : null}
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
  // The lowest step's bottom edge, for routing cycles underneath; each further cycle runs a little lower.
  const lowest = Math.max(0, ...out.map((n) => n.position.y)) + 140;
  let cycleIndex = 0;
  const flowEdges: Edge[] = edges.map((e, i) => {
    const fail = e.when === 'fail';
    const colour = e.cycle ? 'var(--accent-soft)' : fail ? 'var(--danger)' : 'var(--accent)';
    const max = e.maxRounds ?? 1;
    const cycleLabel = e.cycle ? (e.rounds !== undefined ? `round ${e.rounds} of ${max}` : `max ${max} round${max === 1 ? '' : 's'}`) : '';
    const label = [e.when ? `on ${e.when}` : '', cycleLabel].filter(Boolean).join(' · ');
    const selected = opts.selectedEdge === i;
    return {
      id: `e${i}`,
      type: e.cycle ? 'cycle' : 'smoothstep',
      ...(e.cycle ? { data: { below: lowest + 26 * cycleIndex++ } } : {}),
      source: e.from,
      target: e.to,
      label: label || undefined,
      ariaLabel: `Connection from ${e.from} to ${e.to}${label ? `, ${label}` : ''}`,
      animated: fail || !!e.cycle,
      selected,
      markerEnd: { type: MarkerType.ArrowClosed, color: fail ? palette.white : palette.accent },
      style: { stroke: colour, strokeWidth: selected ? 2.5 : 1.5, ...(e.cycle ? { strokeDasharray: '6 4' } : {}) },
      labelStyle: { fill: palette.ink, fontSize: 11 },
      labelBgStyle: { fill: palette.surfaceRaised },
    };
  });
  return { nodes: out, edges: flowEdges };
}

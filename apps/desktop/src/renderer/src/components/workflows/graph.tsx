import { BaseEdge, Handle, MarkerType, Position, type Edge, type EdgeProps, type Node, type NodeProps, type OnNodesChange } from '@xyflow/react';
import { Bot, GitMerge, Hand, Plug, Repeat, Split, SquareTerminal, type LucideIcon } from 'lucide-react';
import { cx, palette } from '@ade/ui';
import type { WorkflowRunView } from '@ade/contracts';
import { useCallback, useState, type CSSProperties } from 'react';

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
  /** WF-17: this edge closes a cycle; `maxRounds` is its limit and `rounds` how many a run has used. */
  cycle?: boolean | undefined;
  maxRounds?: number | null | undefined;
  rounds?: number | undefined;
}

/** How far below the steps a cycle's way back runs. */
const RETURN_DROP = 90;

/**
 * WF-17: a connection that closes a cycle goes back under the graph instead of across the steps: out of the source,
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

/** One icon per step type, shared by the canvas and the toolbar. */
export const STEP_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  command: SquareTerminal,
  gate: Hand,
  loop: Repeat,
  branch: Split,
  connector: Plug,
  land: GitMerge,
};

type XY = { x: number; y: number };
type Size = { width: number; height: number };

/**
 * The canvas's own state: where steps were dragged and the size React Flow measured for each. Every node passed to
 * React Flow carries its measured size, so rebuilding the nodes (on every drag frame, or when a run changes) never
 * hides them for a re-measure. Without this the whole canvas flashes while a step is dragged.
 */
export function useCanvasState() {
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [positions, setPositions] = useState<Record<string, XY>>({});
  const onNodesChange = useCallback<OnNodesChange>((changes) => {
    const size: Record<string, Size> = {};
    const moved: Record<string, XY> = {};
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) size[c.id] = c.dimensions;
      if (c.type === 'position' && c.position) moved[c.id] = c.position;
    }
    if (Object.keys(size).length) setSizes((o) => ({ ...o, ...size }));
    if (Object.keys(moved).length) setPositions((o) => ({ ...o, ...moved }));
  }, []);
  /** Forgets dragged positions, for when another workflow opens. */
  const reset = useCallback(() => setPositions({}), []);
  return { sizes, positions, onNodesChange, reset };
}

export interface StepData extends Record<string, unknown> {
  type: string;
  title: string;
  detail: string;
  start: boolean;
  fan: string;
  status: string | null;
  line: string;
  base: string;
  dim: boolean;
  running: boolean;
}

/**
 * A step on the canvas. Its outline says what kind of step it is (a rounded card for an agent, a terminal for a
 * command, an octagon for a gate, a stadium for a loop, a pointed hexagon for a branch, a parallelogram for a
 * connector, an arrow for land), and each kind has its own texture, all in the three palette hues.
 */
export function StepNode({ data, selected }: NodeProps<Node<StepData, 'step'>>) {
  const Icon = STEP_ICONS[data.type] ?? SquareTerminal;
  const style = {
    '--step-line': selected ? 'var(--accent-soft)' : data.line,
    '--step-base': data.base,
    '--step-edge': selected ? '2.5px' : '1.5px',
  } as CSSProperties;
  return (
    <div className={cx('ade-step', `ade-step-${data.type}`, data.dim && 'opacity-60', data.running && 'ade-step-running')} style={style}>
      <div className="ade-step-shape" aria-hidden="true" />
      <div className="ade-step-fill" aria-hidden="true" />
      <Handle type="target" position={Position.Left} />
      <div className="ade-step-content flex flex-col gap-0.5 text-left">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
          <Icon className="size-3.5 shrink-0 text-accent-soft" aria-hidden="true" />
          {TYPE_LABELS[data.type] ?? data.type}
          {data.start ? ' · start' : ''}
        </span>
        <span className={cx('font-semibold text-ink', data.type === 'command' && 'font-mono text-[12px]')}>{data.title}</span>
        <span className="truncate text-[11px] text-ink-muted">{data.detail}</span>
        {data.fan ? <span className="text-[11px] text-accent-soft">{data.fan}</span> : null}
        {data.status ? <span className="text-[11px] font-semibold text-ink">{data.status}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const NODE_KINDS = { step: StepNode };

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
    positions?: Record<string, XY>;
    sizes?: Record<string, Size>;
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
    const line = opts.problemNodes?.has(n.id)
      ? 'var(--danger-line)'
      : (status?.border ?? (n.type === 'gate' ? 'var(--attention-line)' : n.type === 'agent' || n.type === 'land' ? 'var(--accent)' : 'var(--line-strong)'));
    const ins = inputs(n.id);
    const outs = outputs(n.id);
    const size = opts.sizes?.[n.id];
    const data: StepData = {
      type: n.type,
      title: n.title,
      detail: n.detail,
      start: index === 0,
      fan: [ins > 1 ? `waits for ${ins} inputs` : '', outs > 1 ? `${outs} next steps` : ''].filter(Boolean).join(' · '),
      status: status?.label ?? null,
      line,
      // A status with its own tint shows under the step's texture; otherwise each kind keeps its own base.
      base: status && status.background !== 'var(--surface)' ? status.background : `var(--step-base-${n.type}, var(--surface))`,
      dim: n.status === 'skipped',
      running: n.status === 'running',
    };
    return {
      id: n.id,
      type: 'step',
      position: opts.positions?.[n.id] ?? { x: col * 250, y: row * 140 },
      ...(size ? { measured: size } : {}),
      selected: opts.selected === n.id,
      ariaLabel: `${TYPE_LABELS[n.type] ?? n.type} step ${n.title}${status ? `, ${status.label}` : ''}`,
      data,
      style: { width: 210 },
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

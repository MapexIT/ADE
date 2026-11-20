import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { WorkflowSummary } from '@ade/contracts';
import { useEffect, useMemo, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';

const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  command: 'Command',
  gate: 'Gate',
  loop: 'Loop',
  branch: 'Branch',
  connector: 'Connector',
  land: 'Land',
};

/** Layered left-to-right layout: each node sits one column after the first node that reaches it. */
function layout(wf: WorkflowSummary): { nodes: Node[]; edges: Edge[] } {
  const depth = new Map<string, number>();
  const first = wf.nodes[0]?.id;
  if (first) {
    depth.set(first, 0);
    const queue = [first];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of wf.edges.filter((x) => x.from === id)) {
        if (depth.has(e.to)) continue;
        depth.set(e.to, depth.get(id)! + 1);
        queue.push(e.to);
      }
    }
  }
  const rows = new Map<number, number>();
  const problemNodes = new Set(wf.problems.filter((p) => p.level === 'error' && p.nodeId).map((p) => p.nodeId));
  const nodes: Node[] = wf.nodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const gate = n.type === 'gate';
    return {
      id: n.id,
      position: { x: col * 230, y: row * 120 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <div className="flex flex-col gap-0.5 text-left">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{TYPE_LABELS[n.type] ?? n.type}</span>
            <span className="font-semibold text-ink">{n.title}</span>
            <span className="truncate text-[11px] text-ink-muted">{n.detail}</span>
          </div>
        ),
      },
      style: {
        width: 190,
        background: gate ? 'var(--attention-tint)' : 'var(--surface)',
        border: `1px solid ${problemNodes.has(n.id) ? 'var(--danger-line)' : gate ? 'var(--attention-line)' : n.type === 'agent' ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 10,
        color: 'var(--ink)',
        padding: 10,
      },
    };
  });
  const edges: Edge[] = wf.edges.map((e, i) => ({
    id: `e${i}`,
    type: 'smoothstep',
    source: e.from,
    target: e.to,
    label: e.when ?? undefined,
    animated: e.when === 'fail',
    markerEnd: { type: MarkerType.ArrowClosed, color: e.when === 'fail' ? '#FF9B9B' : '#7FA6F5' },
    style: { stroke: e.when === 'fail' ? '#FF9B9B' : '#7FA6F5' },
    labelStyle: { fill: '#E6EAF0', fontSize: 11 },
    labelBgStyle: { fill: '#161B22' },
  }));
  return { nodes, edges };
}

/** Screen 4: workflows from `.ade/workflows/` and the built-in templates, drawn as a graph with validation. */
export function WorkflowsScreen() {
  const workspaceId = useStore((s) => s.workspaceId);
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void attempt(() => host.call('workflows.list', { workspaceId })).then((l) => {
      setList(l ?? []);
      setSelected((s) => (s && l?.some((w) => w.id === s) ? s : (l?.[0]?.id ?? null)));
    });
  }, [workspaceId]);

  const wf = list.find((w) => w.id === selected) ?? null;
  const graph = useMemo(() => (wf ? layout(wf) : { nodes: [], edges: [] }), [wf]);
  const errors = wf?.problems.filter((p) => p.level === 'error') ?? [];
  const warnings = wf?.problems.filter((p) => p.level === 'warning') ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="m-0 text-[16px] font-semibold">{wf?.name ?? 'Workflows'}</h1>
        {wf ? <Badge>{wf.source === 'template' ? 'Template' : wf.path}</Badge> : null}
        {wf ? <Badge tone={errors.length ? 'danger' : 'ok'}>{errors.length ? `${errors.length} problem(s)` : 'Valid'}</Badge> : null}
        <Badge tone="attention">Running workflows arrives in v1</Badge>
        <span className="text-ink-muted">{wf?.description || 'Workflows chain agent sessions with checks and gates. A gate always comes before anything lands.'}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Workflows" className="flex w-64 flex-col gap-2 overflow-auto border-r border-line bg-surface p-3">
          {(['repository', 'template'] as const).map((source) => {
            const items = list.filter((w) => w.source === source);
            return (
              <section key={source} className="flex flex-col gap-2">
                <SectionLabel>{source === 'repository' ? 'In this repository' : 'Templates'}</SectionLabel>
                {items.length === 0 && source === 'repository' ? <p className="m-0 text-[12px] text-ink-muted">Add YAML files to .ade/workflows/ to version workflows with your code.</p> : null}
                {items.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setSelected(w.id)}
                    aria-current={w.id === selected ? 'true' : undefined}
                    className={cx('rounded-[var(--radius)] border px-3 py-2 text-left', w.id === selected ? 'border-accent bg-accent-tint' : 'border-line hover:bg-surface-raised')}
                  >
                    <span className="block font-semibold">{w.name}</span>
                    {w.problems.some((p) => p.level === 'error') ? <span className="text-[12px] text-danger">Has problems</span> : <span className="text-[12px] text-ink-muted">{w.nodes.length} steps</span>}
                  </button>
                ))}
              </section>
            );
          })}
        </aside>
        <div className="min-h-0 flex-1 bg-surface-sunken" aria-label="Workflow canvas">
          {wf && wf.nodes.length ? (
            <ReactFlow key={wf.id} nodes={graph.nodes} edges={graph.edges} fitView nodesConnectable={false} proOptions={{ hideAttribution: true }}>
              <Background color="#2A3441" gap={20} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <EmptyState title="Nothing to draw" body={errors[0]?.message ?? 'Pick a workflow on the left.'} />
          )}
        </div>
        {errors.length || warnings.length ? (
          <aside aria-label="Problems" className="flex w-80 flex-col gap-2 overflow-auto border-l border-line bg-surface p-3">
            <SectionLabel>Problems</SectionLabel>
            {[...errors, ...warnings].map((p, i) => (
              <div key={i} className={cx('rounded-[var(--radius)] border px-3 py-2', p.level === 'error' ? 'border-danger-line bg-danger-tint text-danger' : 'border-attention-line text-attention')}>
                {p.level === 'error' ? 'Error: ' : 'Warning: '}
                {p.message}
              </div>
            ))}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

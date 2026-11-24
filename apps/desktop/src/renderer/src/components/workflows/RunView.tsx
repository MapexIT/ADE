import { Check, MessagesSquare, Play, RotateCcw, X } from 'lucide-react';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { Badge, Button, palette, SectionLabel } from '@ade/ui';
import type { WorkflowRunView } from '@ade/contracts';
import { useMemo, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { duration } from '../../lib/format.ts';
import { attempt, useStore } from '../../lib/store.ts';
import { buildGraph, STATUS } from './graph.tsx';

export const RUN_STATUS: Record<
  WorkflowRunView['status'],
  { label: string; tone: 'accent' | 'attention' | 'danger' | 'neutral' | 'ok' }
> = {
  running: { label: 'Running', tone: 'accent' },
  'waiting-gate': { label: 'Waiting for you', tone: 'attention' },
  paused: { label: 'Paused', tone: 'attention' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const live = (s: WorkflowRunView['status']) => s === 'running' || s === 'waiting-gate' || s === 'paused';

function budgetLine(run: WorkflowRunView): string {
  const parts: string[] = [];
  const b = run.budgets;
  parts.push(`${run.used.turns}${b.turns ? ` of ${b.turns}` : ''} turns`);
  parts.push(`${Math.round(run.used.minutes)}${b.minutes ? ` of ${b.minutes}` : ''} min`);
  if (b.loops) parts.push(`${run.used.loops} of ${b.loops} loops`);
  if (run.used.costUsd || b.costUsd)
    parts.push(`$${run.used.costUsd.toFixed(2)}${b.costUsd ? ` of $${b.costUsd}` : ''}`);
  return parts.join(' · ');
}

/** WF-06: node status, the session behind each node, time per node, and the decisions the run waits for. */
export function RunView({ run }: { run: WorkflowRunView }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  const graph = useMemo(
    () => buildGraph(run.nodes, run.edges, { selected: selected ?? run.current }),
    [run, selected],
  );
  const node = run.nodes.find((n) => n.id === (selected ?? run.current)) ?? null;
  const gate = run.status === 'waiting-gate' ? run.nodes.find((n) => n.id === run.current) : null;
  const status = RUN_STATUS[run.status];
  // The session of the step that most recently finished: what a gate asks you to review.
  const latestSession =
    [...run.nodes]
      .filter((n) => n.sessionId && n.endedAt)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.sessionId ?? null;

  const openSession = (id: string) => {
    selectSession(id);
    set({ tab: 'sessions' });
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 bg-surface-sunken" aria-label="Run graph">
        <ReactFlow
          key={run.id}
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={(_, n) => setSelected(n.id)}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={palette.lineStrong} gap={22} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <aside
        aria-label="Run details"
        className="flex w-96 flex-col gap-4 overflow-auto border-l border-line bg-surface p-4"
      >
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[15px] font-semibold">{run.workflowName}</h2>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <span className="text-[12px] text-ink-muted">{budgetLine(run)}</span>
          {run.pauseReason && run.status === 'paused' ? (
            <p className="m-0 rounded-[var(--radius)] border border-attention-line bg-attention-tint px-3 py-2 text-attention">
              {run.pauseReason}
            </p>
          ) : null}
        </section>

        {gate ? (
          <section
            aria-label="Decision"
            className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-attention-line bg-attention-tint p-3"
          >
            <SectionLabel>Your decision</SectionLabel>
            <p className="m-0 font-semibold text-ink">{gate.detail}</p>
            <p className="m-0 text-[12px] text-ink-muted">
              {latestSession
                ? 'Review the latest session before you decide.'
                : 'No step has made changes yet.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {latestSession ? (
                <Button icon={<MessagesSquare className="size-4" aria-hidden="true" />} size="dense" onClick={() => openSession(latestSession)}>
                  Open latest session
                </Button>
              ) : null}
              <Button icon={<Check className="size-4" aria-hidden="true" />}
                variant="primary"
                size="dense"
                onClick={() =>
                  void attempt(() =>
                    host.call('workflows.decideGate', { runId: run.id, nodeId: gate.id, approved: true }),
                  )
                }
              >
                Approve and continue
              </Button>
              <Button icon={<X className="size-4" aria-hidden="true" />}
                variant="danger"
                size="dense"
                onClick={() =>
                  void attempt(() =>
                    host.call('workflows.decideGate', { runId: run.id, nodeId: gate.id, approved: false }),
                  )
                }
              >
                Reject
              </Button>
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {run.status === 'paused' ? (
            <Button icon={<Play className="size-4" aria-hidden="true" />}
              variant="attention"
              size="dense"
              onClick={() => void attempt(() => host.call('workflows.resume', { runId: run.id }))}
            >
              Resume
            </Button>
          ) : null}
          {live(run.status) ? (
            <Button
              variant="danger"
              size="dense"
              onClick={() => void attempt(() => host.call('workflows.cancel', { runId: run.id }))}
            >
              Cancel run
            </Button>
          ) : null}
        </div>

        {node ? (
          <section aria-label="Step details" className="flex flex-col gap-2">
            <SectionLabel>Step: {node.title}</SectionLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                tone={
                  node.status === 'failed'
                    ? 'danger'
                    : node.status === 'waiting'
                      ? 'attention'
                      : node.status === 'running'
                        ? 'accent'
                        : 'neutral'
                }
              >
                {STATUS[node.status].label}
              </Badge>
              {node.attempts > 1 ? <Badge>{node.attempts} attempts</Badge> : null}
              {node.startedAt ? (
                <span className="text-[12px] text-ink-muted">
                  {duration((node.endedAt ?? Date.now()) - node.startedAt)}
                </span>
              ) : null}
            </div>
            <span className="text-[12px] text-ink-muted">{node.detail}</span>
            {node.summary ? (
              <p className="m-0 max-h-60 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken px-3 py-2 whitespace-pre-wrap">
                {node.summary}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {node.sessionId ? (
                <Button icon={<MessagesSquare className="size-4" aria-hidden="true" />} size="dense" onClick={() => openSession(node.sessionId!)}>
                  Open session
                </Button>
              ) : null}
              {run.status !== 'running' && live(run.status) ? (
                <Button icon={<RotateCcw className="size-4" aria-hidden="true" />}
                  size="dense"
                  variant="ghost"
                  onClick={() =>
                    void attempt(() => host.call('workflows.retryFrom', { runId: run.id, nodeId: node.id }))
                  }
                >
                  Retry from here
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}

        {run.log.length ? (
          <section aria-label="Run log" className="flex flex-col gap-1">
            <SectionLabel>Log</SectionLabel>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-[12px] text-ink-muted">
              {run.log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

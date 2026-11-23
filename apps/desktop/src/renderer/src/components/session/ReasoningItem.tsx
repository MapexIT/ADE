import { BrainCircuit, Check, LoaderCircle, X } from 'lucide-react';
import { Badge, cx } from '@ade/ui';
import { strategyFor } from '@ade/reasoning';
import type { TimelineItem } from '@ade/session-core';

type Item = Extract<TimelineItem, { kind: 'reasoning' }>;

const PHASE_LABELS: Record<string, string> = {
  sample: 'Reasoning paths',
  generate: 'Generate',
  score: 'Score',
  aggregate: 'Aggregate',
  refine: 'Refine',
  resample: 'Resample',
  mutate: 'Mutate',
  select: 'Select',
};

const OUTCOME: Record<NonNullable<Item['outcome']>, { label: string; tone: 'ok' | 'neutral' | 'danger' }> = {
  sent: { label: 'Sent to the agent', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** GN-01: a reasoning run in the timeline: progress, every step of the graph and the approach it chose. */
export function ReasoningItem({ item }: { item: Item }) {
  const strategy = strategyFor(item.method);
  const running = item.outcome === null;
  const pct = item.plannedCalls ? Math.min(100, Math.round((item.calls / item.plannedCalls) * 100)) : 100;
  return (
    <section aria-label={`Reasoning: ${strategy.label}`} className="flex flex-col gap-2 rounded-[var(--radius)] border border-accent/50 bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <BrainCircuit className="size-4 text-accent-soft" aria-hidden="true" />
        <span className="font-semibold">Reasoning · {strategy.label}</span>
        {running ? (
          <Badge tone="accent">
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Reasoning
          </Badge>
        ) : (
          <Badge tone={OUTCOME[item.outcome!].tone}>{OUTCOME[item.outcome!].label}</Badge>
        )}
        <span className="ml-auto text-[12px] text-ink-muted">
          {item.calls}/{item.plannedCalls} agent calls · read-only
        </span>
      </div>
      {running ? (
        <div className="h-1 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-label="Reasoning progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {item.steps.length ? (
        <details open={running}>
          <summary className="cursor-pointer text-[12px] text-ink-muted">Steps ({item.steps.length})</summary>
          <ol className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {item.steps.map((s) => (
              <li key={s.stepId} className="flex flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  {s.status === 'running' ? (
                    <LoaderCircle className="size-3.5 animate-spin text-accent-soft motion-reduce:animate-none" aria-label="Running" />
                  ) : s.status === 'done' ? (
                    <Check className="size-3.5 text-ink-muted" aria-label="Done" />
                  ) : (
                    <X className="size-3.5 text-danger" aria-label="Failed" />
                  )}
                  <span className="font-mono text-[11px] text-ink-muted">{s.stepId}</span>
                  <span className="text-[11px] tracking-[0.06em] text-ink-muted uppercase">{PHASE_LABELS[s.phase] ?? s.phase}</span>
                  <span className={cx(s.status === 'failed' && 'text-danger')}>{s.label}</span>
                  {s.score !== null ? <Badge tone="accent">{s.score}/10</Badge> : null}
                  {s.parents.length ? <span className="font-mono text-[11px] text-ink-muted">from {s.parents.join(', ')}</span> : null}
                </div>
                {s.detail && s.phase !== 'select' ? (
                  <details className="ml-6 text-[12px] text-ink-muted">
                    <summary className="cursor-pointer">Details</summary>
                    <div className="mt-1 whitespace-pre-wrap">{s.detail}</div>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {item.approach ? (
        <details open>
          <summary className="cursor-pointer text-[12px] font-semibold">Chosen approach</summary>
          <div className="mt-1 rounded-[var(--radius-small)] bg-bg p-2 text-[13px] whitespace-pre-wrap">{item.approach}</div>
        </details>
      ) : null}
    </section>
  );
}

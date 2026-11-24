import { ArrowRight, Repeat, Trash2 } from 'lucide-react';
import { Badge, Button, SectionLabel } from '@ade/ui';
import type { Edge } from '@ade/workflow-engine';
import { Field, inputClass } from '../Modal.tsx';
import { edgeInfo, fanOf, type Draft } from '../../lib/workflow-draft.ts';

/**
 * WF-16 / WF-17: one connection's settings: when it applies, and, when it closes a cycle, how many rounds the run
 * may go round it (default 1). Several connections may leave or enter one step.
 */
export function EdgeSettings({
  draft,
  index,
  readOnly,
  onChange,
  onDelete,
}: {
  draft: Draft;
  index: number;
  readOnly: boolean;
  onChange(patch: { when?: Edge['when'] | null; maxRounds?: number | null }): void;
  onDelete(): void;
}) {
  const edge = draft.edges[index];
  if (!edge) return null;
  const info = edgeInfo(draft, index);
  const from = fanOf(draft, edge.from);
  const to = fanOf(draft, edge.to);
  return (
    <section aria-label="Connection settings" className="flex flex-col gap-3">
      <SectionLabel>Connection</SectionLabel>
      <div className="flex items-center gap-2 font-semibold">
        <span className="font-mono">{edge.from}</span>
        <ArrowRight className="size-4 text-accent-soft" aria-hidden="true" />
        <span className="font-mono">{edge.to}</span>
        {info.cycle ? (
          <Badge tone="accent">
            <Repeat className="size-3.5" aria-hidden="true" /> closes a cycle
          </Badge>
        ) : null}
      </div>
      <Field label="Follow this connection" htmlFor="edge-when" hint={from.outputs > 1 ? `${edge.from} has ${from.outputs} next steps: every one whose condition matches runs, at the same time.` : undefined}>
        <select
          id="edge-when"
          value={edge.when ?? 'always'}
          disabled={readOnly}
          onChange={(e) => onChange({ when: e.target.value === 'always' ? null : (e.target.value as 'pass' | 'fail') })}
          className={inputClass}
        >
          <option value="always">When the step passes (always, for steps that cannot fail)</option>
          <option value="pass">Only on pass</option>
          <option value="fail">Only on fail</option>
        </select>
      </Field>
      {to.inputs > 1 && !info.cycle ? (
        <p className="m-0 text-[12px] text-ink-muted">
          {edge.to} waits for all {to.inputs} of its inputs. An input whose step took another path counts as done, so {edge.to} still runs when at least one input arrived.
        </p>
      ) : null}
      {info.cycle ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-accent/60 bg-accent-tint/40 p-3">
          <Field
            label="Maximum rounds"
            htmlFor="edge-rounds"
            hint={`How many times a run may go back round this cycle (${info.steps.join(' → ')} → ${edge.to}). After that it pauses until you resume it. Default 1.`}
          >
            <input
              id="edge-rounds"
              type="number"
              min={1}
              max={50}
              disabled={readOnly}
              value={edge.maxRounds ?? info.maxRounds}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1) onChange({ maxRounds: n });
              }}
              className={inputClass}
            />
          </Field>
          {edge.maxRounds === undefined && info.maxRounds !== 1 ? <span className="text-[12px] text-ink-muted">Taken from the loop step on this cycle until you set it here.</span> : null}
        </div>
      ) : null}
      {!readOnly ? (
        <Button variant="danger" className="self-start" icon={<Trash2 className="size-4" aria-hidden="true" />} onClick={onDelete}>
          Delete connection
        </Button>
      ) : null}
    </section>
  );
}

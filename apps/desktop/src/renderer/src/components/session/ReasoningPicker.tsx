import { BrainCircuit, SlidersHorizontal } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { ReasoningMethod, ReasoningSettings } from '@ade/contracts';
import { DEFAULT_SETTINGS, METHODS, strategyFor } from '@ade/reasoning';
import { useState } from 'react';
import { useComposer } from '../../lib/composer.ts';
import { Field, inputClass, Modal } from '../Modal.tsx';

type NumberKey = 'samples' | 'branches' | 'agents' | 'generations';

const PARAMS: Partial<Record<ReasoningMethod, { key: NumberKey; label: string; min: number; max: number; hint: string }[]>> = {
  'cot-sc': [{ key: 'samples', label: 'Reasoning paths', min: 2, max: 7, hint: 'Independent paths sampled before the turn.' }],
  got: [{ key: 'branches', label: 'Thoughts', min: 2, max: 5, hint: 'Approaches generated before scoring and merging.' }],
  foa: [
    { key: 'agents', label: 'Agents in the fleet', min: 2, max: 6, hint: 'Plans evolved side by side.' },
    { key: 'generations', label: 'Generations', min: 1, max: 3, hint: 'Rounds of scoring, resampling and improving.' },
  ],
};

/**
 * GN-01: picks how prompts are generated. IO (as written) is the default; switching to any other method first asks
 * for confirmation, because it changes what the agent receives and may make extra agent calls.
 */
export function ReasoningPicker({ sessionId, agent, disabled }: { sessionId: string; agent: string; disabled?: boolean }) {
  // A stable fallback: a new object here would re-render forever before the state has loaded.
  const settings = useComposer((c) => c.states[sessionId]?.reasoning ?? DEFAULT_SETTINGS);
  const update = useComposer((c) => c.update);
  const [pending, setPending] = useState<ReasoningSettings | null>(null);
  const apply = (next: ReasoningSettings) => update(sessionId, (s) => ({ ...s, reasoning: next }));

  const choose = (method: ReasoningMethod) => {
    if (method === 'io') apply({ ...settings, method });
    else setPending({ ...settings, method });
  };

  return (
    <>
      <label htmlFor={`reasoning-${sessionId}`} className="sr-only">
        Generation method
      </label>
      <div className="flex items-center gap-1">
        <select
          id={`reasoning-${sessionId}`}
          value={settings.method}
          disabled={disabled}
          onChange={(e) => choose(e.target.value as ReasoningMethod)}
          title={strategyFor(settings.method).summary}
          className={cx('min-h-9 rounded-[var(--radius)] border bg-surface px-3 text-ink', settings.method === 'io' ? 'border-line' : 'border-accent')}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              Generation: {strategyFor(m).label}
            </option>
          ))}
        </select>
        {PARAMS[settings.method] ? (
          <Button size="dense" variant="ghost" className="w-9 px-0" aria-label="Adjust generation method" title="Adjust generation method" disabled={disabled} onClick={() => setPending(settings)}>
            <SlidersHorizontal className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ReasoningDialog
        settings={pending}
        agent={agent}
        current={settings.method}
        onCancel={() => setPending(null)}
        onAccept={(next) => {
          apply(next);
          setPending(null);
        }}
        onChange={setPending}
      />
    </>
  );
}

function ReasoningDialog({
  settings,
  agent,
  current,
  onCancel,
  onAccept,
  onChange,
}: {
  settings: ReasoningSettings | null;
  agent: string;
  current: ReasoningMethod;
  onCancel(): void;
  onAccept(s: ReasoningSettings): void;
  onChange(s: ReasoningSettings): void;
}) {
  const strategy = settings ? strategyFor(settings.method) : null;
  const calls = settings && strategy ? strategy.plannedCalls(settings) : 0;
  const switching = settings ? settings.method !== current : false;
  return (
    <Modal
      open={!!settings}
      onOpenChange={(o) => !o && onCancel()}
      icon={<BrainCircuit className="size-5 text-accent-soft" aria-hidden="true" />}
      title={strategy ? (switching ? `Switch generation to ${strategy.label}?` : `Adjust ${strategy.label}`) : ''}
      description={strategy?.summary}
      footer={
        <>
          <Button onClick={onCancel}>{switching ? 'Keep current method' : 'Cancel'}</Button>
          <Button variant="primary" onClick={() => settings && onAccept(settings)}>
            {switching ? `Use ${strategy?.label}` : 'Save'}
          </Button>
        </>
      }
    >
      {settings && strategy ? (
        <div className="flex flex-col gap-3">
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-ink-muted">
            <li>Your prompt is no longer sent exactly as written: ADE adds an instruction to reason step by step{calls ? ', plus the approach reasoning chose' : ''}. The timeline shows what was sent.</li>
            {calls ? (
              <>
                <li>
                  Before each message, <span className="font-semibold text-ink">{calls} extra calls</span> go to {agent}. They use your {agent} quota and the message takes longer to start.
                </li>
                <li>These calls are read-only and run in a temporary copy of the worktree. Cancel reasoning stops them, and nothing is sent.</li>
              </>
            ) : (
              <li>No extra agent calls are made.</li>
            )}
            <li>This applies to this session until you switch back to IO (as written).</li>
          </ul>
          {(PARAMS[settings.method] ?? []).map((p) => (
            <Field key={p.key} label={p.label} htmlFor={`reasoning-${p.key}`} hint={p.hint}>
              <input
                id={`reasoning-${p.key}`}
                type="number"
                min={p.min}
                max={p.max}
                value={settings[p.key]}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) onChange({ ...settings, [p.key]: Math.min(p.max, Math.max(p.min, n)) });
                }}
                className={inputClass}
              />
            </Field>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

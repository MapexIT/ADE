import { ListPlus, Plus, X } from 'lucide-react';
import { Badge, Button, cx, SectionLabel, Waiting } from '@ade/ui';
import type { AgentId, PermissionRule, RuleRehearsal, RuleSuggestion, RuleUsage } from '@ade/contracts';
import {
  agentsText,
  CAVEAT_TEXT,
  decisionWords,
  evidenceText,
  formatRuleDate,
  heldBackText,
  hintParts,
  rehearsalText,
  RISK_WORDS,
  UNUSED_TEXT,
  unseenText,
  usageText,
} from '@ade/session-core';
import { useEffect, useId, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { adoptSuggestion, dismissSuggestion, reviewSuggestion } from '../lib/rule-advice.ts';
import { useStore } from '../lib/store.ts';
import { inputClass, Modal } from './Modal.tsx';

const label = (id: string) => agentLabel(id as AgentId) ?? id;

/**
 * AP-09: the rehearsal of a rule as it is currently typed, from `rules.rehearse` 250 ms after the last change. The
 * suggestion's own rehearsal is used for its recommended pattern, so opening the dialog needs no request.
 */
function useRehearsal(
  workspaceId: string,
  rule: Pick<PermissionRule, 'id' | 'decision' | 'kind' | 'pattern'>,
  initial?: { pattern: string; value: RuleRehearsal },
) {
  const { id, decision, kind, pattern } = rule;
  const keyOf = (p: string) => `${decision}|${kind}|${p.trim()}`;
  const key = keyOf(pattern);
  const [cache, setCache] = useState<Record<string, RuleRehearsal>>(() => (initial ? { [keyOf(initial.pattern)]: initial.value } : {}));
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  useEffect(() => {
    const trimmed = pattern.trim();
    if (!trimmed || key in cacheRef.current) return;
    let live = true;
    const timer = setTimeout(() => {
      void host.call('rules.rehearse', { workspaceId, rule: { id, decision, kind, pattern: trimmed } }).then(
        (value) => live && setCache((c) => ({ ...c, [key]: value })),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, key, id, decision, kind, pattern]);
  const rehearsal = cache[key] ?? null;
  return { rehearsal, waiting: !!pattern.trim() && !rehearsal };
}

/** The rehearsal sentences: answered, held back, what else it covers, and anything against the user's decision. */
function RehearsalBlock({ rehearsal, waiting, detailed }: { rehearsal: RuleRehearsal | null; waiting: boolean; detailed: boolean }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-1.5 text-[12px]">
      {waiting || !rehearsal ? (
        waiting ? <Waiting>Rehearsing against your past requests</Waiting> : null
      ) : (
        <>
          <span className="text-ink">{rehearsalText(rehearsal)}</span>
          {rehearsal.heldBack > 0 ? <span className="text-ink-muted">{heldBackText(rehearsal.heldBack)}</span> : null}
          {detailed && rehearsal.covers.length ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-ink-muted">Commands it covers:</span>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {rehearsal.covers.map((c) => (
                  <li key={c.text} className="flex gap-2">
                    <code className="min-w-0 truncate font-mono text-ink">{c.text}</code>
                    <span className="shrink-0 text-ink-muted">{c.count === 1 ? 'once' : `${c.count} times`}</span>
                  </li>
                ))}
              </ul>
              {rehearsal.moreCovers > 0 ? <span className="text-ink-muted">and {rehearsal.moreCovers} more</span> : null}
            </div>
          ) : null}
          {detailed && rehearsal.conflicts.length ? (
            <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-danger-line p-2">
              <span className="font-semibold text-danger">Against your decision:</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {rehearsal.conflicts.map((c) => (
                  <li key={`${c.ts}-${c.text}`} className="flex flex-col">
                    <code className="font-mono text-ink">{c.text}</code>
                    <span className="text-ink-muted">
                      You {c.decided} it on {formatRuleDate(c.ts)}
                      {c.sessionTitle ? ` in ${c.sessionTitle}` : ''}.
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function HintText({ suggestion }: { suggestion: RuleSuggestion }) {
  const [before, command, after] = hintParts(suggestion);
  return (
    <span>
      {before}
      <code className="font-mono text-ink">{command}</code>
      {after}
    </span>
  );
}

/** AP-09: the line under a decided approval card. Never on a pending card, never in the attention tint. */
export function RuleHint({ workspaceId, suggestion }: { workspaceId: string; suggestion: RuleSuggestion }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="note" aria-label="Rule suggestion" className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2 text-[12px] text-ink-muted">
      <ListPlus className="size-4 shrink-0" aria-hidden="true" />
      <HintText suggestion={suggestion} />
      <span className="ml-auto flex gap-2">
        <Button size="dense" icon={<ListPlus className="size-4" aria-hidden="true" />} onClick={() => reviewSuggestion(workspaceId, suggestion)}>
          Review rule
        </Button>
        <Button
          size="dense"
          variant="ghost"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await dismissSuggestion(workspaceId, suggestion.key, false);
            setBusy(false);
          }}
        >
          Not now
        </Button>
      </span>
    </div>
  );
}

type Scope = 'exact' | 'wider' | 'custom';

/** AP-09: "Rule from your decisions". The only way a suggestion becomes a rule is Add rule here. */
export function RuleSuggestionDialog() {
  const open = useStore((s) => s.ruleSuggestion);
  const set = useStore((s) => s.set);
  const close = () => set({ ruleSuggestion: null });
  return (
    <Modal open={!!open} onOpenChange={(o) => !o && close()} title="Rule from your decisions" description="A workspace rule answers matching requests in this repository without asking.">
      {open ? <SuggestionBody key={open.suggestion.key} workspaceId={open.workspaceId} suggestion={open.suggestion} onClose={close} /> : null}
    </Modal>
  );
}

function SuggestionBody({ workspaceId, suggestion, onClose }: { workspaceId: string; suggestion: RuleSuggestion; onClose: () => void }) {
  const [pattern, setPattern] = useState(suggestion.pattern);
  const [scope, setScope] = useState<Scope>('exact');
  const [busy, setBusy] = useState<'add' | 'never' | null>(null);
  const id = useId();
  const { rehearsal, waiting } = useRehearsal(
    workspaceId,
    { id: 'suggestion', decision: suggestion.decision, kind: 'execute', pattern },
    { pattern: suggestion.pattern, value: suggestion.rehearsal },
  );
  const recommendedIsWide = suggestion.risk !== 'exact' && suggestion.pattern.endsWith(' *');
  const conflicts = (rehearsal?.conflict ?? 0) > 0;
  const choose = (next: Scope) => {
    setScope(next);
    setPattern(next === 'wider' && suggestion.wider ? suggestion.wider : suggestion.pattern);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{decisionWords(suggestion.decision)}</span>
        <span className="text-ink-muted">· Commands</span>
        <Badge className="ml-auto">{RISK_WORDS[suggestion.risk]}</Badge>
      </div>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] font-semibold text-ink-muted">How much it covers</legend>
        <label className="flex min-h-9 items-center gap-2">
          <input type="radio" name={`${id}-scope`} checked={scope === 'exact'} onChange={() => choose('exact')} className="size-4 accent-[var(--accent)]" />
          {recommendedIsWide ? 'This command with any arguments' : 'Only this exact command'}
        </label>
        {suggestion.wider ? (
          <label className="flex min-h-9 items-center gap-2">
            <input type="radio" name={`${id}-scope`} checked={scope === 'wider'} onChange={() => choose('wider')} className="size-4 accent-[var(--accent)]" />
            This command with any arguments
          </label>
        ) : null}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-pattern`} className="text-[12px] font-semibold text-ink-muted">
          Pattern
        </label>
        <input
          id={`${id}-pattern`}
          value={pattern}
          maxLength={500}
          onChange={(e) => {
            setPattern(e.target.value);
            setScope('custom');
          }}
          className={cx(inputClass, 'font-mono')}
        />
      </div>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[12px] text-ink-muted">
        {suggestion.caveats.map((c) => (
          <li key={c}>{CAVEAT_TEXT[c]}</li>
        ))}
      </ul>
      <p className="m-0 text-[12px] text-ink-muted">
        {evidenceText(suggestion.evidence, suggestion.decision)} {agentsText(suggestion.evidence.agents, label)}
      </p>
      <section aria-label="Rehearsal" className="flex flex-col gap-1 rounded-[var(--radius)] border border-line bg-surface-sunken p-3">
        <SectionLabel>Rehearsal</SectionLabel>
        <RehearsalBlock rehearsal={rehearsal} waiting={waiting} detailed />
      </section>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          busy={busy === 'never'}
          onClick={async () => {
            setBusy('never');
            if (await dismissSuggestion(workspaceId, suggestion.key, true)) onClose();
            setBusy(null);
          }}
        >
          Never suggest this
        </Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          icon={<Plus className="size-4" aria-hidden="true" />}
          busy={busy === 'add'}
          disabled={!pattern.trim()}
          onClick={async () => {
            setBusy('add');
            if (await adoptSuggestion(workspaceId, suggestion.key, { decision: suggestion.decision, kind: 'execute', pattern: pattern.trim() })) onClose();
            setBusy(null);
          }}
        >
          {conflicts ? 'Add rule anyway' : 'Add rule'}
        </Button>
      </div>
    </div>
  );
}

/** AP-09: suggestions for this repository, in Settings above the rules. */
export function SuggestedRules({ workspaceId, suggestions }: { workspaceId: string; suggestions: readonly RuleSuggestion[] }) {
  const section = useStore((s) => s.settingsSection);
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (section !== 'suggested-rules') return;
    ref.current?.scrollIntoView({ block: 'start' });
    ref.current?.focus();
    set({ settingsSection: null });
  }, [section, set]);
  return (
    <section ref={ref} tabIndex={-1} aria-label="Suggested rules" className="flex flex-col gap-2 rounded-[var(--radius)] border border-line p-3 focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-glow)]">
      <SectionLabel>Suggested rules</SectionLabel>
      {suggestions.length === 0 ? (
        <span className="text-[12px] text-ink-muted">No suggestions yet. ADE offers a rule after you have decided the same way a few times.</span>
      ) : (
        suggestions.map((s) => (
          <div key={s.key} className="flex flex-col gap-1.5 border-t border-line pt-2 first-of-type:border-t-0 first-of-type:pt-0">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
              <HintText suggestion={s} />
              <Badge>{RISK_WORDS[s.risk]}</Badge>
            </div>
            <span className="text-[12px] text-ink-muted">{rehearsalText(s.rehearsal)}</span>
            <div className="flex gap-2">
              <Button size="dense" icon={<ListPlus className="size-4" aria-hidden="true" />} onClick={() => reviewSuggestion(workspaceId, s)}>
                Review rule
              </Button>
              <Button size="dense" variant="ghost" icon={<X className="size-4" aria-hidden="true" />} onClick={() => void dismissSuggestion(workspaceId, s.key, false)}>
                Not now
              </Button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/** AP-09: under each rule in Settings: its rehearsal as typed, how often it answered, and what it answered unseen. */
export function RuleInsight({ workspaceId, rule, usage }: { workspaceId: string; rule: PermissionRule; usage: RuleUsage | undefined }) {
  const { rehearsal, waiting } = useRehearsal(workspaceId, rule);
  if (!rule.pattern.trim()) return null;
  return (
    <div className="flex w-full flex-col gap-1 pl-1 text-[12px] text-ink-muted" aria-label="Rule insight" role="group">
      <RehearsalBlock rehearsal={rehearsal} waiting={waiting} detailed={false} />
      {usage ? <span>{usageText(usage)}</span> : null}
      {usage?.unused ? <span className="font-semibold text-ink">{UNUSED_TEXT}</span> : null}
      {usage && usage.unseen.length ? (
        <details>
          <summary className="cursor-pointer">{unseenText(usage.unseen.length)}</summary>
          <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
            {usage.unseen.map((u) => (
              <li key={u.text}>
                <code className="font-mono text-ink">{u.text}</code>
                {u.count > 1 ? ` (${u.count} times)` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

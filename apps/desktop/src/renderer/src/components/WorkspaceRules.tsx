import { Plus, Save, Trash2 } from 'lucide-react';
import { Button, cx, SectionLabel } from '@ade/ui';
import { RuleAdviceSettings, type PermissionRule } from '@ade/contracts';
import { useEffect, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { newRuleId } from '../lib/rule-advice.ts';
import { attempt, EMPTY, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';
import { RuleInsight, SuggestedRules } from './RuleAdvice.tsx';

const KINDS: { id: PermissionRule['kind']; label: string }[] = [
  { id: 'any', label: 'Any request' },
  { id: 'execute', label: 'Commands' },
  { id: 'edit', label: 'Edits' },
  { id: 'delete', label: 'Deletes' },
  { id: 'fetch', label: 'Web requests' },
];


/**
 * AP-06: allow and deny rules for this repository. A matching request is answered without asking; deny wins
 * over allow, and every automatic answer appears in the timeline and the audit log.
 */
export function WorkspaceRules({ workspaceId }: { workspaceId: string }) {
  const toast = useStore((s) => s.toast);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [adviceOn, setAdviceOn] = useState(true);
  const advice = useStore((s) => s.ruleAdvice[workspaceId]);
  const refreshAdvice = useStore((s) => s.refreshRuleAdvice);
  // A rule added from a suggestion while Settings is open shows up here too.
  const ruleCount = advice?.usage.length ?? 0;

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) return;
    void attempt(() => host.call('rules.list', { workspaceId })).then((r) => {
      setRules(r ?? []);
      setDirty(false);
    });
  }, [workspaceId, ruleCount]);

  useEffect(() => {
    refreshAdvice(workspaceId);
    void host.call('settings.get', { key: 'ruleAdvice' }).then((v) => {
      const parsed = RuleAdviceSettings.safeParse(v.value ?? {});
      setAdviceOn(parsed.success ? parsed.data.enabled : true);
    });
  }, [workspaceId, refreshAdvice]);

  const update = (next: PermissionRule[]) => {
    setRules(next);
    setDirty(true);
  };
  const patch = (id: string, change: Partial<PermissionRule>) => update(rules.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const save = async () => {
    const valid = rules.filter((r) => r.pattern.trim());
    if (await attempt(() => host.call('rules.save', { workspaceId, rules: valid }))) {
      setRules(valid);
      setDirty(false);
      toast('Workspace rules saved.');
      refreshAdvice(workspaceId);
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label="Workspace rules">
      <SectionLabel>Workspace rules</SectionLabel>
      <p className="m-0 text-[12px] text-ink-muted">
        Answer matching requests in this repository without asking. The pattern is matched against the request and its command, ignoring case; * matches anything. Deny wins over allow, and every automatic answer is logged. An allow rule covers a command with several steps only when every step is allowed.
      </p>
      {adviceOn ? <SuggestedRules workspaceId={workspaceId} suggestions={advice?.suggestions ?? EMPTY} /> : null}
      {rules.length === 0 ? <span className="text-ink-muted">No rules. Every request follows the session's permission profile.</span> : null}
      {rules.map((r, i) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2" aria-label={`Rule ${i + 1}`} role="group">
          <label htmlFor={`rule-decision-${r.id}`} className="sr-only">
            Rule {i + 1} decision
          </label>
          <select
            id={`rule-decision-${r.id}`}
            value={r.decision}
            onChange={(e) => patch(r.id, { decision: e.target.value as PermissionRule['decision'] })}
            className={cx(inputClass, 'w-24', r.decision === 'deny' && 'text-danger')}
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
          </select>
          <label htmlFor={`rule-kind-${r.id}`} className="sr-only">
            Rule {i + 1} applies to
          </label>
          <select id={`rule-kind-${r.id}`} value={r.kind} onChange={(e) => patch(r.id, { kind: e.target.value as PermissionRule['kind'] })} className={cx(inputClass, 'w-36')}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <label htmlFor={`rule-pattern-${r.id}`} className="sr-only">
            Rule {i + 1} pattern
          </label>
          <input
            id={`rule-pattern-${r.id}`}
            value={r.pattern}
            placeholder="npm test *"
            onChange={(e) => patch(r.id, { pattern: e.target.value })}
            className={cx(inputClass, 'min-w-40 flex-1 font-mono')}
          />
          <Button icon={<Trash2 className="size-4" aria-hidden="true" />} variant="ghost" size="dense" onClick={() => update(rules.filter((x) => x.id !== r.id))} aria-label={`Remove rule ${i + 1}`}>
            Remove
          </Button>
          <RuleInsight workspaceId={workspaceId} rule={r} usage={advice?.usage.find((u) => u.ruleId === r.id)} />
        </div>
      ))}
      <div className="flex gap-2">
        <Button icon={<Plus className="size-4" aria-hidden="true" />} size="dense" onClick={() => update([...rules, { id: newRuleId(), decision: 'allow', kind: 'execute', pattern: '' }])}>
          Add rule
        </Button>
        <Button icon={<Save className="size-4" aria-hidden="true" />} size="dense" variant="primary" disabled={!dirty} onClick={() => void save()}>
          Save rules
        </Button>
      </div>
    </section>
  );
}

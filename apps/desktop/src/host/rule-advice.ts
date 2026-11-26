import { randomUUID } from 'node:crypto';
import {
  RpcError,
  RuleAdviceSettings,
  type PermissionRule,
  type RuleAdvice,
  type RuleRehearsal,
  type SessionEvent,
} from '@ade/contracts';
import { evidenceCount, foldDecisions, rehearse, suggest, usage, type Decided, type Dismissed } from '@ade/session-core';

/** AP-09: how many permission events the history reads (newest first). */
export const RULE_HISTORY_EVENTS = 4_000;
export const MAX_RULES = 200;
export const RULE_ADVICE_SETTING = 'ruleAdvice';
export const ruleCreatedKey = (workspaceId: string) => `rules.created.${workspaceId}`;
export const ruleDismissedKey = (workspaceId: string) => `rules.dismissed.${workspaceId}`;

export interface RuleAdviceDeps {
  /** The newest permission.requested / permission.decided events of the workspace, oldest first. */
  decisions(workspaceId: string): SessionEvent[];
  sessionMeta(sessionId: string): { title: string; agentId: string } | null;
  rules(workspaceId: string): PermissionRule[];
  saveRules(workspaceId: string, rules: PermissionRule[]): void;
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; raw(key: string): unknown };
  audit(entry: { workspaceId: string; sessionId: null; actor: string; action: string; detail: Record<string, unknown> }): void;
  now(): number;
}

/**
 * AP-09: rule suggestions, rehearsal and usage, derived from the stored permission events with the pure folds in
 * `session-core`. Nothing here adds a rule on its own: `adopt` runs only when the user presses Add rule.
 */
export class RuleAdviceService {
  constructor(private readonly deps: RuleAdviceDeps) {}

  private history(workspaceId: string): Decided[] {
    const meta = new Map<string, { title: string; agentId: string } | null>();
    return foldDecisions(this.deps.decisions(workspaceId), (id) => {
      if (!meta.has(id)) meta.set(id, this.deps.sessionMeta(id));
      return meta.get(id) ?? null;
    });
  }

  private settings(): RuleAdviceSettings {
    const parsed = RuleAdviceSettings.safeParse(this.deps.settings.raw(RULE_ADVICE_SETTING) ?? {});
    return parsed.success ? parsed.data : RuleAdviceSettings.parse({});
  }

  private dismissed(workspaceId: string): Dismissed {
    return this.deps.settings.get<Dismissed>(ruleDismissedKey(workspaceId), {});
  }

  private ages(workspaceId: string): Record<string, string | null> {
    return this.deps.settings.get<Record<string, string | null>>(ruleCreatedKey(workspaceId), {});
  }

  advice(workspaceId: string): RuleAdvice {
    const history = this.history(workspaceId);
    const rules = this.deps.rules(workspaceId);
    const settings = this.settings();
    return {
      suggestions: settings.enabled ? suggest(history, rules, this.dismissed(workspaceId), settings) : [],
      usage: usage(rules, history, this.ages(workspaceId), this.deps.now()),
      requests: history.filter((d) => d.by === 'user').length,
    };
  }

  rehearse(workspaceId: string, rule: PermissionRule): RuleRehearsal {
    return rehearse(rule, this.deps.rules(workspaceId), this.history(workspaceId));
  }

  /** Appends the rule (with a fresh id) and records where it came from. Evidence is recomputed here. */
  adopt(workspaceId: string, key: string, rule: PermissionRule): PermissionRule {
    const rules = this.deps.rules(workspaceId);
    if (rules.length >= MAX_RULES) throw new RpcError('invalid', `This repository already has ${MAX_RULES} rules. Remove one first.`);
    const history = this.history(workspaceId);
    const added: PermissionRule = { ...rule, id: randomUUID() };
    const rehearsal = rehearse(added, rules, history);
    const suggestion = key === 'manual' ? null : suggest(history, rules, {}, this.settings()).find((s) => s.key === key);
    this.deps.saveRules(workspaceId, [...rules, added]);
    this.stamp(workspaceId, rules, [...rules, added]);
    this.deps.audit({
      workspaceId,
      sessionId: null,
      actor: 'user',
      action: 'rules.suggestion.accepted',
      detail: {
        rule: added,
        key,
        evidence: suggestion
          ? { allowed: suggestion.evidence.allowed, rejected: suggestion.evidence.rejected, sessions: suggestion.evidence.sessions, agents: suggestion.evidence.agents }
          : null,
        rehearsal: { considered: rehearsal.considered, wouldAnswer: rehearsal.wouldAnswer, agree: rehearsal.agree, conflict: rehearsal.conflict },
      },
    });
    return added;
  }

  dismiss(workspaceId: string, key: string, forever: boolean): void {
    const dismissed = { ...this.dismissed(workspaceId), [key]: { forever, at: evidenceCount(this.history(workspaceId), key) } };
    this.deps.settings.set(ruleDismissedKey(workspaceId), dismissed);
    this.deps.audit({ workspaceId, sessionId: null, actor: 'user', action: 'rules.suggestion.dismissed', detail: { key, forever } });
  }

  /**
   * Records a creation time for rule ids not seen before and forgets ids that are gone. Rules that existed before
   * any time was recorded (saved before M12) keep an unknown age, so they are never marked unused.
   */
  stamp(workspaceId: string, previous: PermissionRule[], rules: PermissionRule[]): void {
    const stored = this.deps.settings.raw(ruleCreatedKey(workspaceId));
    const before: Record<string, string | null> =
      stored && typeof stored === 'object' ? (stored as Record<string, string | null>) : Object.fromEntries(previous.map((r) => [r.id, null]));
    const at = new Date(this.deps.now()).toISOString();
    const next: Record<string, string | null> = {};
    for (const r of rules) next[r.id] = r.id in before ? (before[r.id] ?? null) : at;
    this.deps.settings.set(ruleCreatedKey(workspaceId), next);
  }
}

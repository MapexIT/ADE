import type { PermissionRule, RuleSuggestion } from '@ade/contracts';
import { host } from './bridge.ts';
import { attempt, useStore } from './store.ts';

/**
 * AP-09: the suggestion whose newest evidence is this request. Using the newest evidence request puts the hint
 * under exactly one decided card and needs no shape logic in the renderer.
 */
export function hintFor(item: { requestId: string }, suggestions: readonly RuleSuggestion[] | undefined): RuleSuggestion | null {
  return suggestions?.find((s) => s.evidence.lastRequestId === item.requestId) ?? null;
}

export const newRuleId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36);

export function reviewSuggestion(workspaceId: string, suggestion: RuleSuggestion) {
  useStore.getState().set({ ruleSuggestion: { workspaceId, suggestion } });
}

/** "Not now" (until the user has decided the same way `threshold` more times) or "Never suggest this". */
export async function dismissSuggestion(workspaceId: string, key: string, forever: boolean) {
  const done = await attempt(() => host.call('rules.dismissSuggestion', { workspaceId, key, forever }));
  if (done) useStore.getState().refreshRuleAdvice(workspaceId);
  return !!done;
}

/** Adds the rule. Only ever called from the dialog's Add rule button. */
export async function adoptSuggestion(workspaceId: string, key: string, rule: Omit<PermissionRule, 'id'>) {
  const done = await attempt(() => host.call('rules.adopt', { workspaceId, key, rule: { ...rule, id: newRuleId() } }));
  if (done) {
    useStore.getState().toast('Workspace rule added.');
    useStore.getState().refreshRuleAdvice(workspaceId);
  }
  return !!done;
}

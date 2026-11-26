import type { PermissionRule } from '@ade/contracts';
import type { PermissionRequestInfo } from '@ade/acp-client';
import { decideByRules, ruleRegExp } from '@ade/session-core';
import type { AutoAnswer } from './permission-policy.ts';

export { ruleRegExp };

/**
 * AP-06: answers a request from the workspace rules, or null when no rule answers it. A matching deny rule wins
 * over any allow rule, and allow rules are chain-safe (AP-09, `decideByRules`). The answer names the rule in
 * `decidedBy` so the timeline and audit log show it.
 */
export function ruleAnswer(rules: PermissionRule[], request: PermissionRequestInfo): (AutoAnswer & { rule: PermissionRule }) | null {
  const decided = decideByRules(rules, request);
  if (!decided) return null;
  if (decided.decision === 'deny') {
    const reject = request.options.find((o) => o.kind === 'reject_once') ?? request.options.find((o) => o.kind === 'reject_always');
    return {
      rule: decided.rule,
      decidedBy: `rule:${decided.rule.id}`,
      decision: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' },
    };
  }
  const option = request.options.find((o) => o.kind === 'allow_once');
  return option ? { rule: decided.rule, decidedBy: `rule:${decided.rule.id}`, decision: { outcome: 'selected', optionId: option.optionId } } : null;
}

export const rulesKey = (workspaceId: string) => `rules.${workspaceId}`;

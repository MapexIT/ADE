import type { PermissionRule } from '@ade/contracts';
import type { PermissionRequestInfo } from '@ade/acp-client';
import type { AutoAnswer } from './permission-policy.ts';

/** `*` matches anything; everything else is literal. The whole text must match, ignoring case. Pure. */
export function ruleRegExp(pattern: string): RegExp {
  const body = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'is');
}

export function ruleMatches(rule: PermissionRule, request: PermissionRequestInfo): boolean {
  if (rule.kind !== 'any' && rule.kind !== request.kind) return false;
  const re = ruleRegExp(rule.pattern);
  return [request.title, request.detail].some((text) => !!text && re.test(text.trim()));
}

/**
 * AP-06: answers a request from the workspace rules, or null when no rule matches. A matching deny rule wins
 * over any allow rule. The answer names the rule in `decidedBy` so the timeline and audit log show it.
 */
export function ruleAnswer(rules: PermissionRule[], request: PermissionRequestInfo): (AutoAnswer & { rule: PermissionRule }) | null {
  const matches = rules.filter((r) => ruleMatches(r, request));
  const deny = matches.find((r) => r.decision === 'deny');
  if (deny) {
    const reject = request.options.find((o) => o.kind === 'reject_once') ?? request.options.find((o) => o.kind === 'reject_always');
    return {
      rule: deny,
      decidedBy: `rule:${deny.id}`,
      decision: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' },
    };
  }
  const allow = matches.find((r) => r.decision === 'allow');
  const option = request.options.find((o) => o.kind === 'allow_once');
  if (allow && option) return { rule: allow, decidedBy: `rule:${allow.id}`, decision: { outcome: 'selected', optionId: option.optionId } };
  return null;
}

export const rulesKey = (workspaceId: string) => `rules.${workspaceId}`;

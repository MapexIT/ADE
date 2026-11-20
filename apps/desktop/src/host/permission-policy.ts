import type { PermissionDecision, PermissionProfile } from '@ade/contracts';
import type { PermissionRequestInfo } from '@ade/acp-client';

export interface AutoAnswer {
  decision: PermissionDecision;
  decidedBy: string;
}

/**
 * Strategy that answers permission requests a profile settles without asking (AP-01). Returns null when the
 * user must decide. Every automatic answer is recorded with the profile as `decidedBy`.
 */
export interface PermissionPolicy {
  autoAnswer(profile: PermissionProfile, request: PermissionRequestInfo): AutoAnswer | null;
}

const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

const pick = (request: PermissionRequestInfo, kinds: string[]) => request.options.find((o) => kinds.includes(o.kind));

export const profilePolicy: PermissionPolicy = {
  autoAnswer(profile, request) {
    switch (profile) {
      case 'read-only': {
        if (!request.kind || !WRITE_KINDS.has(request.kind)) return null;
        const reject = pick(request, ['reject_once', 'reject_always']);
        return reject
          ? { decision: { outcome: 'selected', optionId: reject.optionId }, decidedBy: 'profile:read-only' }
          : { decision: { outcome: 'cancelled' }, decidedBy: 'profile:read-only' };
      }
      case 'auto-edit': {
        if (request.kind !== 'edit') return null;
        const allow = pick(request, ['allow_once']);
        return allow ? { decision: { outcome: 'selected', optionId: allow.optionId }, decidedBy: 'profile:auto-edit' } : null;
      }
      case 'autonomous': {
        // Only reachable for sandboxed sessions; the composer refuses Autonomous otherwise.
        const allow = pick(request, ['allow_once']);
        return allow ? { decision: { outcome: 'selected', optionId: allow.optionId }, decidedBy: 'profile:autonomous' } : null;
      }
      case 'ask':
        return null;
    }
  },
};

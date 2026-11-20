import type { SessionState } from '@ade/contracts';

/**
 * Session lifecycle (docs/PRODUCT.md "Session states"), plus `queued` for the concurrency cap (PL-02).
 * A pure function: the session service feeds triggers in and persists the resulting state change.
 */
export type SessionTrigger =
  | 'dequeue' // queued -> starting
  | 'prompt' // starting | ready -> working; interrupted -> working (agent session reloaded)
  | 'needs-user' // working -> waiting-on-user (permission request or question)
  | 'user-answered' // waiting-on-user -> working
  | 'turn-ended' // working -> ready (turn ended or cancelled; checkpoint taken)
  | 'crashed' // starting | working | waiting-on-user -> interrupted
  | 'reopen' // interrupted -> ready (reopened at the last checkpoint)
  | 'land' // ready -> landed
  | 'discard'; // ready | queued -> discarded

export const SESSION_TRIGGERS: readonly SessionTrigger[] = [
  'dequeue',
  'prompt',
  'needs-user',
  'user-answered',
  'turn-ended',
  'crashed',
  'reopen',
  'land',
  'discard',
];

const TABLE: Record<SessionState, Partial<Record<SessionTrigger, SessionState>>> = {
  queued: { dequeue: 'starting', discard: 'discarded' },
  starting: { prompt: 'working', crashed: 'interrupted' },
  working: { 'needs-user': 'waiting-on-user', 'turn-ended': 'ready', crashed: 'interrupted' },
  'waiting-on-user': { 'user-answered': 'working', crashed: 'interrupted' },
  ready: { prompt: 'working', land: 'landed', discard: 'discarded' },
  interrupted: { prompt: 'working', reopen: 'ready' },
  landed: {},
  discarded: {},
};

export class InvalidTransitionError extends Error {
  readonly from: SessionState;
  readonly trigger: SessionTrigger;
  constructor(from: SessionState, trigger: SessionTrigger) {
    super(`Cannot ${trigger} a session that is ${from}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.trigger = trigger;
  }
}

/** Returns the next state, or `null` when the trigger is not allowed in `from`. */
export function nextState(from: SessionState, trigger: SessionTrigger): SessionState | null {
  return TABLE[from][trigger] ?? null;
}

/** Like `nextState` but throws on an invalid transition. */
export function transition(from: SessionState, trigger: SessionTrigger): SessionState {
  const to = nextState(from, trigger);
  if (to === null) throw new InvalidTransitionError(from, trigger);
  return to;
}

export const isTerminal = (state: SessionState): boolean => state === 'landed' || state === 'discarded';
export const isLive = (state: SessionState): boolean =>
  state === 'starting' || state === 'working' || state === 'waiting-on-user';

/** Sessions list grouping (PL-01). */
export type SessionGroup = 'needs-you' | 'working' | 'ready' | 'done';
export function groupOf(state: SessionState): SessionGroup {
  switch (state) {
    case 'waiting-on-user':
    case 'interrupted':
      return 'needs-you';
    case 'queued':
    case 'starting':
    case 'working':
      return 'working';
    case 'ready':
      return 'ready';
    case 'landed':
    case 'discarded':
      return 'done';
  }
}

export const STATE_LABELS: Record<SessionState, string> = {
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  'waiting-on-user': 'Waiting on you',
  ready: 'Ready for review',
  interrupted: 'Interrupted',
  landed: 'Landed',
  discarded: 'Discarded',
};

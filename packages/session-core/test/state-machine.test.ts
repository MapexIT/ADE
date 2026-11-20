import { SessionState as SessionStateSchema, type SessionState } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import {
  groupOf,
  InvalidTransitionError,
  nextState,
  SESSION_TRIGGERS,
  transition,
  type SessionTrigger,
} from '../src/index.ts';

/** Every allowed transition. Anything not listed must be rejected. */
const ALLOWED: [SessionState, SessionTrigger, SessionState][] = [
  ['queued', 'dequeue', 'starting'],
  ['queued', 'discard', 'discarded'],
  ['starting', 'prompt', 'working'],
  ['starting', 'crashed', 'interrupted'],
  ['working', 'needs-user', 'waiting-on-user'],
  ['waiting-on-user', 'user-answered', 'working'],
  ['working', 'turn-ended', 'ready'],
  ['working', 'crashed', 'interrupted'],
  ['waiting-on-user', 'crashed', 'interrupted'],
  ['ready', 'prompt', 'working'],
  ['ready', 'land', 'landed'],
  ['ready', 'discard', 'discarded'],
  ['interrupted', 'prompt', 'working'],
  ['interrupted', 'reopen', 'ready'],
];

describe('session state machine', () => {
  it.each(ALLOWED)('%s --%s--> %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  const allowedKeys = new Set(ALLOWED.map(([f, t]) => `${f}|${t}`));
  const rejected = SessionStateSchema.options.flatMap((from) =>
    SESSION_TRIGGERS.filter((t) => !allowedKeys.has(`${from}|${t}`)).map((t) => [from, t] as const),
  );

  it.each(rejected)('rejects %s --%s', (from, trigger) => {
    expect(nextState(from, trigger)).toBeNull();
    expect(() => transition(from, trigger)).toThrow(InvalidTransitionError);
  });

  it('covers every state and trigger pair', () => {
    expect(ALLOWED.length + rejected.length).toBe(SessionStateSchema.options.length * SESSION_TRIGGERS.length);
  });

  it('groups sessions for the list', () => {
    expect(groupOf('waiting-on-user')).toBe('needs-you');
    expect(groupOf('working')).toBe('working');
    expect(groupOf('ready')).toBe('ready');
    expect(groupOf('landed')).toBe('done');
  });
});

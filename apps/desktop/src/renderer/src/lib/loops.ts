import { loopRedirect, type LoopFinding } from '@ade/session-core';
import { useStore } from './store.ts';

/**
 * WA-10: "Redirect the agent". Opens the session and puts a suggested instruction in its chat box for the user to
 * edit and send (Interrupt and send). Nothing is sent from here.
 */
export function redirectLoop(sessionId: string, finding: Pick<LoopFinding, 'pattern' | 'subject' | 'count'>) {
  const s = useStore.getState();
  if (s.selectedSessionId !== sessionId) s.selectSession(sessionId);
  s.set({ tab: 'sessions', composerDraft: { sessionId, text: loopRedirect(finding) } });
}

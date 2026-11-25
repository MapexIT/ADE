import { useMemo } from 'react';
import { openItems, proofPrompt, type OpenItem, type ReceiptState, type TimelineItem } from '@ade/session-core';
import { EMPTY, useStore } from './store.ts';

export type ReceiptItem = Extract<TimelineItem, { kind: 'receipt' }>;

/** RV-16: the session's receipts, as the projection keeps them in its timeline. */
export const receiptsOf = (items: readonly TimelineItem[]): ReceiptItem[] => items.filter((i): i is ReceiptItem => i.kind === 'receipt');

/** RV-16: the session's receipts and their open items, derived from its events. */
export function useReceipts(sessionId: string | null): { receipts: ReceiptState[]; open: OpenItem[] } {
  const items = useStore((s) => (sessionId ? s.views[sessionId]?.items : undefined) ?? (EMPTY as TimelineItem[]));
  return useMemo(() => {
    const receipts = receiptsOf(items);
    return { receipts, open: openItems(receipts) };
  }, [items]);
}

/**
 * RV-16: "Ask for proof". Opens the session and puts a suggested message in its message box for the user to edit
 * and send. Nothing is sent from here.
 */
export function askForProof(sessionId: string, items: readonly OpenItem[]) {
  const s = useStore.getState();
  if (s.selectedSessionId !== sessionId) s.selectSession(sessionId);
  s.set({ tab: 'sessions', composerDraft: { sessionId, text: proofPrompt(items) } });
}

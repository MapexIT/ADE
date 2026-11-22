import { Check } from 'lucide-react';
import { Badge } from '@ade/ui';
import type { ReviewProgress, ReviewState } from '@ade/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { useStore } from '../lib/store.ts';

/**
 * RV-15: the review state of every file the session changed (all turns). Reloads whenever `refreshKey`
 * changes; pass the changes list so it follows that list's debounce. A response is dropped when a newer
 * request or a `setProgress` call (for example the result of marking a file) came after it.
 */
export function useReviewProgress(sessionId: string | null, refreshKey: unknown) {
  // Tagged with its session, so switching sessions never shows the previous session's states.
  const [loaded, setLoaded] = useState<{ sessionId: string; progress: ReviewProgress } | null>(null);
  const generation = useRef(0);
  const setProgress = useCallback(
    (p: ReviewProgress) => {
      generation.current++;
      if (sessionId) setLoaded({ sessionId, progress: p });
    },
    [sessionId],
  );
  const state = useStore((s) => (sessionId ? s.sessions[sessionId]?.state : undefined));
  const ended = state === 'landed' || state === 'discarded';
  useEffect(() => {
    const mine = ++generation.current;
    if (!sessionId || ended) return;
    const keep = (p: ReviewProgress | null) => mine === generation.current && setLoaded(p ? { sessionId, progress: p } : null);
    void host.call('sessions.reviewProgress', { sessionId }).then(keep, () => keep(null));
  }, [sessionId, ended, refreshKey]);
  return { progress: !ended && loaded?.sessionId === sessionId ? loaded.progress : null, setProgress };
}

/** RV-15: a worded review state for a changed file. Files that are not reviewed show nothing. */
export function ReviewBadge({ state }: { state: ReviewState | undefined }) {
  if (state === 'reviewed') {
    return (
      <Badge tone="ok">
        <Check aria-hidden="true" className="size-3.5" />
        Reviewed
      </Badge>
    );
  }
  if (state === 'changed') return <Badge tone="attention">Changed since review</Badge>;
  return null;
}

import { BellOff, CircleStop, CornerUpRight, Repeat2 } from 'lucide-react';
import { Button } from '@ade/ui';
import { loopBody, loopTitle, type TimelineItem } from '@ade/session-core';
import { host } from '../../lib/bridge.ts';
import { redirectLoop } from '../../lib/loops.ts';
import { attempt, useStore } from '../../lib/store.ts';

/** WA-10: a loop warning in the timeline, with what was repeated and the user's three answers. */
export function LoopItem({ item, sessionId }: { item: Extract<TimelineItem, { kind: 'loop' }>; sessionId: string }) {
  const body = loopBody(item);
  // A turn cut short by ADE closing has no end event; the session's state says it is over.
  const running = useStore((s) => s.views[sessionId]?.activeTurnId === item.turnId && (s.sessions[sessionId]?.state === 'working' || s.sessions[sessionId]?.state === 'waiting-on-user'));
  const state = item.state === 'active' && !running ? 'ended' : item.state;
  return (
    <section role="region" aria-label="Loop warning" className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-attention-line bg-attention-tint p-3">
      <div className="flex items-start gap-2 font-semibold text-attention">
        <Repeat2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{loopTitle(item)}</span>
      </div>
      {body || item.level === 'severe' ? (
        <div className="text-ink-muted">
          {item.level === 'severe' ? 'Still going. ' : ''}
          {body}
        </div>
      ) : null}
      {state === 'active' ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="dense" icon={<CornerUpRight className="size-4" aria-hidden="true" />} onClick={() => redirectLoop(sessionId, item)}>
            Redirect the agent
          </Button>
          <Button size="dense" icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId }))}>
            Cancel turn
          </Button>
          <Button variant="ghost" size="dense" icon={<BellOff className="size-4" aria-hidden="true" />} onClick={() => void attempt(() => host.call('sessions.dismissLoop', { sessionId }))}>
            Not a loop
          </Button>
        </div>
      ) : (
        <div className="text-ink-muted">{state === 'dismissed' ? 'Dismissed. ADE will not warn again in this turn.' : 'The turn ended.'}</div>
      )}
    </section>
  );
}

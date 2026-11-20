import type { NeedsYouItem, Session, SessionEvent, WorkflowRunView } from '@ade/contracts';

export interface HostEvents {
  'session.event': SessionEvent;
  'session.changed': { workspaceId: string; session: Session };
  'inbox.changed': NeedsYouItem[];
  'workflow.run': WorkflowRunView;
  notify: { sessionId: string; title: string; body: string };
}

type Listener<T> = (payload: T) => void;

/** In-process Observer hub. Services publish; the RPC layer and tests subscribe. */
export class EventBus {
  private readonly listeners = new Map<keyof HostEvents, Set<Listener<never>>>();

  on<K extends keyof HostEvents>(topic: K, listener: Listener<HostEvents[K]>): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(listener as Listener<never>);
    this.listeners.set(topic, set);
    return () => set.delete(listener as Listener<never>);
  }

  emit<K extends keyof HostEvents>(topic: K, payload: HostEvents[K]): void {
    for (const l of this.listeners.get(topic) ?? []) {
      try {
        (l as Listener<HostEvents[K]>)(payload);
      } catch (err) {
        console.error(`[host] listener for ${topic} failed`, err);
      }
    }
  }
}

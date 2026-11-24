import { TRANSIENT_EVENTS, type DistributiveOmit, type LoopSettings, type NeedsYouItem, type NewSessionEvent, type Session, type SessionEvent } from '@ade/contracts';
import { applyLoop, emptyLoopState, isTerminal, loopTitle, type LoopFinding, type LoopState } from '@ade/session-core';
import type { EventBus } from './bus.ts';

type EventInput = DistributiveOmit<NewSessionEvent, 'sessionId'>;

export interface LoopWatchDeps {
  bus: EventBus;
  /** `SessionService.record`: stores and publishes an event. */
  record(sessionId: string, event: EventInput, turnId?: string | null): unknown;
  /** `SessionService.cancel`. */
  cancel(sessionId: string): Promise<void>;
  /** Read at every finding, so a change in Settings applies at once. */
  settings(): LoopSettings;
  session(sessionId: string): Session | null;
  audit(entry: { workspaceId: string; sessionId: string; actor: string; action: string; detail: Record<string, unknown> }): void;
  refreshInbox(): void;
}

interface Active {
  finding: LoopFinding;
  turnId: string;
  /** When the first warning of the turn was recorded. */
  since: string;
}

/**
 * WA-10: watches every session's events for an agent going round in circles within one turn, using the pure
 * `applyLoop` fold. Findings become `loop.detected` events, a Needs-you item and one notification per turn. It
 * stops a turn only when the user switched on `loops.stopTurn`, and never touches the worktree.
 */
export class LoopWatch {
  private readonly states = new Map<string, LoopState>();
  private readonly active = new Map<string, Active>();
  private readonly notified = new Set<string>();
  private readonly off: () => void;
  private disposed = false;

  constructor(private readonly deps: LoopWatchDeps) {
    this.off = deps.bus.on('session.event', (e) => this.onEvent(e));
  }

  inbox(): NeedsYouItem[] {
    const items: NeedsYouItem[] = [];
    for (const [sessionId, a] of this.active) {
      const session = this.deps.session(sessionId);
      if (!session) continue;
      items.push({ id: `loop:${sessionId}`, sessionId, sessionTitle: session.title, kind: 'loop', title: loopTitle(a.finding), createdAt: a.since });
    }
    return items;
  }

  /** "Not a loop": no more loop events in the session's current turn. */
  dismiss(sessionId: string): void {
    const turnId = this.states.get(sessionId)?.turnId ?? this.active.get(sessionId)?.turnId ?? null;
    if (!turnId) return;
    this.deps.record(sessionId, { type: 'loop.dismissed', turnId }, turnId);
    this.clear(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }

  private clear(sessionId: string) {
    if (this.active.delete(sessionId)) this.deps.refreshInbox();
  }

  private onEvent(e: SessionEvent) {
    if (this.disposed || TRANSIENT_EVENTS.has(e.type) || e.type === 'loop.detected') return;
    const sessionId = e.sessionId;
    const prev = this.states.get(sessionId) ?? emptyLoopState();
    const { state, findings } = applyLoop(prev, e);
    this.states.set(sessionId, state);

    if (e.type === 'turn.ended') {
      this.notified.delete(e.turnId);
      this.clear(sessionId);
    } else if (e.type === 'session.state_changed' && e.to !== 'working' && e.to !== 'waiting-on-user') {
      this.clear(sessionId);
      if (isTerminal(e.to)) this.states.delete(sessionId);
    }

    const turnId = state.turnId;
    if (!findings.length || !turnId) return;
    // Recorded after the bus has delivered `e` to every listener, so the renderer sees the triggering event first
    // (its projection skips sequence numbers it has already passed). A turn that ended meanwhile gets nothing.
    queueMicrotask(() => {
      if (this.disposed || this.states.get(sessionId)?.turnId !== turnId || this.states.get(sessionId)?.muted) return;
      if (!this.deps.settings().enabled) return;
      for (const finding of findings) this.report(sessionId, turnId, finding);
    });
  }

  private report(sessionId: string, turnId: string, finding: LoopFinding) {
    const session = this.deps.session(sessionId);
    if (!session) return;
    this.deps.record(sessionId, { type: 'loop.detected', turnId, ...finding }, turnId);
    const since = this.active.get(sessionId)?.turnId === turnId ? this.active.get(sessionId)!.since : new Date().toISOString();
    this.active.set(sessionId, { finding, turnId, since });
    this.deps.refreshInbox();
    if (!this.notified.has(turnId)) {
      this.notified.add(turnId);
      this.deps.bus.emit('notify', { sessionId, title: 'An agent may be going round in circles', body: `${session.title}: ${loopTitle(finding)}` });
    }
    if (finding.level !== 'severe' || !this.deps.settings().stopTurn) return;
    this.deps.record(
      sessionId,
      { type: 'notice', level: 'warning', text: `ADE stopped this turn: ${loopTitle(finding)}. Nothing was undone; the changes so far are still in the worktree.` },
      turnId,
    );
    this.deps.audit({
      workspaceId: session.workspaceId,
      sessionId,
      actor: 'system',
      action: 'loop.turn_stopped',
      detail: { pattern: finding.pattern, subject: finding.subject, count: finding.count },
    });
    this.deps.bus.emit('notify', { sessionId, title: 'ADE stopped a looping turn', body: `${session.title}: ${loopTitle(finding)}` });
    void this.deps.cancel(sessionId).catch(() => undefined);
  }
}

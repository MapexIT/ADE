import { realpathSync } from 'node:fs';
import {
  TRANSIENT_EVENTS,
  type CheckResult,
  type DistributiveOmit,
  type NewSessionEvent,
  type ReceiptSettings,
  type Session,
  type SessionEvent,
  type Turn,
} from '@ade/contracts';
import type { changedFiles, diffPatch, ignoredPaths } from '@ade/git';
import {
  applyEvidence,
  buildReceipt,
  classifyCommand,
  emptyEvidence,
  isTerminal,
  isTestPath,
  openItems,
  phantomCandidates,
  receiptFromEvent,
  receiptOpenItems,
  receiptsFrom,
  type ChangeSeen,
  type EvidenceState,
  type OpenItem,
} from '@ade/session-core';
import type { EventBus } from './bus.ts';

type EventInput = DistributiveOmit<NewSessionEvent, 'sessionId'>;

export const RECEIPT_EVENTS = ['receipt.issued', 'receipt.checked', 'receipt.acknowledged'] as const;
const TEST_PATCH_FILES = 50;
const TEST_PATCH_CHARS = 400_000;

export interface ReceiptDeps {
  bus: EventBus;
  /** `SessionService.record`: stores and publishes an event. */
  record(sessionId: string, event: EventInput, turnId?: string | null): unknown;
  /** Read each time, so a change in Settings applies at once. */
  settings(): ReceiptSettings;
  session(sessionId: string): Session | null;
  turns(sessionId: string): Turn[];
  /** The session's `receipt.*` events, in order. */
  receiptEvents(sessionId: string): SessionEvent[];
  git: { changedFiles: typeof changedFiles; diffPatch: typeof diffPatch; ignoredPaths: typeof ignoredPaths };
  audit(entry: { workspaceId: string; sessionId: string; actor: string; action: string; detail: Record<string, unknown> }): void;
}

/**
 * RV-16: issues a receipt when a turn ends normally, by folding every session event through the pure
 * `applyEvidence` and adding the turn's Git facts. Receipts, ADE's check results and the user's "Mark as checked"
 * are ordinary session events. The service never blocks, cancels or undoes anything; a failure records nothing.
 */
export class ReceiptService {
  private readonly states = new Map<string, EvidenceState>();
  /** Receipts in progress per session, chained so they are recorded in turn order. */
  private readonly issuing = new Map<string, Promise<void>>();
  private readonly off: () => void;
  private disposed = false;

  constructor(private readonly deps: ReceiptDeps) {
    this.off = deps.bus.on('session.event', (e) => this.onEvent(e));
  }

  /** The session's open items across all its receipts. */
  open(sessionId: string): OpenItem[] {
    return openItems(receiptsFrom(this.deps.receiptEvents(sessionId)));
  }

  /** "Mark as checked": closes every open item of the turn's receipt. Quietly does nothing when there is none. */
  acknowledge(sessionId: string, turnId: string): void {
    const session = this.deps.session(sessionId);
    if (!session) return;
    const receipts = receiptsFrom(this.deps.receiptEvents(sessionId));
    const receipt = receipts.find((r) => r.turnId === turnId);
    if (!receipt || receipt.acknowledged) return;
    const items = receiptOpenItems(receipts, receipt).map((i) => i.text).slice(0, 20);
    this.deps.record(sessionId, { type: 'receipt.acknowledged', turnId }, turnId);
    this.deps.audit({ workspaceId: session.workspaceId, sessionId, actor: 'user', action: 'receipt.acknowledged', detail: { turnIndex: receipt.turnIndex, items } });
  }

  /** RV-10 checks finished for the session: their results cover every turn up to the last one that ended. */
  async onChecks(sessionId: string, results: CheckResult[]): Promise<void> {
    await this.issuing.get(sessionId);
    if (this.disposed || !this.deps.receiptEvents(sessionId).some((e) => e.type === 'receipt.issued')) return;
    const last = this.deps
      .turns(sessionId)
      .filter((t) => t.endedAt)
      .reduce<Turn | null>((a, t) => (!a || t.index > a.index ? t : a), null);
    if (!last) return;
    const checks = results.slice(0, 20).map((r) => ({ name: r.name.slice(0, 200), categories: classifyCommand(r.command.join(' ')), exitCode: r.exitCode }));
    this.deps.record(sessionId, { type: 'receipt.checked', turnId: last.id, turnIndex: last.index, checks }, last.id);
  }

  dispose(): void {
    this.disposed = true;
    this.off();
  }

  private onEvent(e: SessionEvent) {
    if (this.disposed || TRANSIENT_EVENTS.has(e.type) || e.type.startsWith('receipt.')) return;
    const sessionId = e.sessionId;
    const prev = this.states.get(sessionId) ?? emptyEvidence();
    const state = applyEvidence(prev, e);
    if (state !== prev) this.states.set(sessionId, state);
    if (e.type === 'turn.ended') {
      if (e.stopReason === 'cancelled' || e.stopReason === 'error' || state.turnId !== e.turnId) return;
      if (!this.settings().enabled) return;
      this.queue(sessionId, () => this.issue(sessionId, state));
    } else if (e.type === 'session.state_changed' && isTerminal(e.to)) {
      this.states.delete(sessionId);
    }
  }

  private settings(): ReceiptSettings {
    try {
      return this.deps.settings();
    } catch {
      return { enabled: true, notify: true };
    }
  }

  /** Runs after the bus has delivered the triggering event to every listener (a `then` is always asynchronous). */
  private queue(sessionId: string, job: () => Promise<void>) {
    const next = (this.issuing.get(sessionId) ?? Promise.resolve()).then(job).catch(() => undefined);
    this.issuing.set(sessionId, next);
    void next.then(() => {
      if (this.issuing.get(sessionId) === next) this.issuing.delete(sessionId);
    });
  }

  private async issue(sessionId: string, ev: EvidenceState): Promise<void> {
    try {
      const session = this.deps.session(sessionId);
      const worktree = session?.worktreePath;
      if (!session || !worktree || this.disposed) return;
      const turn = this.deps.turns(sessionId).find((t) => t.id === ev.turnId);
      const roots = [worktree];
      try {
        const real = realpathSync.native(worktree);
        if (real !== worktree) roots.push(real);
      } catch {
        // the worktree is gone; Git below fails and nothing is recorded
      }
      let changed: ChangeSeen[] | null = null;
      let ignored: string[] = [];
      let testPatch = '';
      if (turn?.startCheckpoint && turn.endCheckpoint) {
        const { startCheckpoint: from, endCheckpoint: to } = turn;
        changed = await this.deps.git.changedFiles(worktree, from, to);
        ignored = await this.deps.git.ignoredPaths(worktree, phantomCandidates(ev, changed, roots));
        const tests = changed.filter((c) => c.status !== 'deleted' && isTestPath(c.path)).map((c) => c.path);
        if (tests.length) testPatch = (await this.deps.git.diffPatch(worktree, from, to, tests.slice(0, TEST_PATCH_FILES))).toString('utf8').slice(0, TEST_PATCH_CHARS);
      }
      const draft = buildReceipt(ev, { changed, ignored, testPatch, roots });
      if (!draft || this.disposed) return;
      const stored = this.deps.record(sessionId, { type: 'receipt.issued', ...draft }, draft.turnId);
      if (stored === null || !this.settings().notify) return;
      const receipt = receiptFromEvent({ ...draft, type: 'receipt.issued', sessionId, seq: 0, ts: '' });
      const [first] = receiptOpenItems([receipt], receipt);
      if (first) this.deps.bus.emit('notify', { sessionId, title: 'A finished turn has something to check', body: `${session.title}: ${first.text}` });
    } catch (err) {
      console.error('[host] receipt failed', err);
    }
  }
}

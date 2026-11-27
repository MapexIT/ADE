import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LESSON_LIMITS,
  LessonAdviceSettings,
  RpcError,
  redactSecrets,
  TRANSIENT_EVENTS,
  type DistributiveOmit,
  type InstructionStatus,
  type Lesson,
  type LessonAdvice,
  type LessonDraft,
  type LessonFiles,
  type LessonRehearsal,
  type NewSessionEvent,
  type Session,
  type SessionEvent,
} from '@ade/contracts';
import {
  applyLessonsBlock,
  commandsOf,
  foldCorrections,
  hasLessonsBlock,
  importsAgents,
  lessonEvidence,
  lessonPatternMatches,
  notFollowedText,
  rehearseLesson,
  standingNotesBlock,
  suggestLessons,
  type LessonDismissed,
} from '@ade/session-core';
import type { EventBus } from './bus.ts';

type EventInput = DistributiveOmit<NewSessionEvent, 'sessionId'>;

/** ED-05: how many events the correction history and the rehearsal read (newest first). */
export const LESSON_HISTORY_EVENTS = 6_000;
export const LESSON_ADVICE_SETTING = 'lessonAdvice';
export const lessonsKey = (workspaceId: string) => `lessons.${workspaceId}`;
export const lessonsDismissedKey = (workspaceId: string) => `lessons.dismissed.${workspaceId}`;

const CORRECTION_EVENTS = ['user.message', 'permission.decided', 'turn.ended', 'notice'] as const;
const COMMAND_EVENTS = ['command.started', 'permission.requested'] as const;

export interface LessonDeps {
  bus: EventBus;
  events(workspaceId: string, types: readonly SessionEvent['type'][], limit: number): SessionEvent[];
  session(sessionId: string): Session | null;
  workspaceRoot(workspaceId: string): string;
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void; raw(key: string): unknown };
  /** `SessionService.record`. */
  record(sessionId: string, event: EventInput, turnId: string | null): unknown;
  instructionStatus(root: string): Promise<InstructionStatus>;
  audit(entry: { workspaceId: string; sessionId: string | null; actor: string; action: string; detail: Record<string, unknown> }): void;
  now(): number;
}

const clean = (t: string) => redactSecrets(t.replace(/\s+/g, ' ').trim()).slice(0, LESSON_LIMITS.text);
const cleanPattern = (p: string | null) => {
  const t = p?.trim() ?? '';
  return t && redactSecrets(t) === t ? t.slice(0, LESSON_LIMITS.pattern) : null;
};

/**
 * ED-05: lessons. Suggestions come from the user's own corrections in the stored events (pure folds in
 * `session-core`); a lesson exists only after the user presses Add lesson. Lessons reach agents with the first
 * prompt (see `notesFor`) or through a marked AGENTS.md block (`writeFiles`). The watch never blocks or answers
 * anything: it adds one "Lesson not followed" notice per lesson per turn.
 */
export class LessonService {
  private readonly turns = new Map<string, string>();
  private readonly flagged = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly deps: LessonDeps) {
    this.off = deps.bus.on('session.event', (e) => this.onEvent(e));
  }

  dispose(): void {
    this.off();
  }

  list(workspaceId: string): Lesson[] {
    return this.deps.settings.get<Lesson[]>(lessonsKey(workspaceId), []);
  }

  /** Saves edits, switches and removals. Texts and patterns are redacted; bookkeeping comes from what is stored. */
  save(workspaceId: string, lessons: Lesson[]): void {
    const stored = new Map(this.list(workspaceId).map((l) => [l.id, l]));
    const next = lessons.slice(0, LESSON_LIMITS.lessons).map((l) => {
      const was = stored.get(l.id);
      return {
        ...(was ?? l),
        text: clean(l.text) || (was?.text ?? ''),
        route: l.route,
        pattern: cleanPattern(l.pattern),
        enabled: l.enabled,
      };
    });
    this.deps.settings.set(lessonsKey(workspaceId), next.filter((l) => l.text));
    this.deps.audit({ workspaceId, sessionId: null, actor: 'user', action: 'lessons.saved', detail: { lessons: next.map((l) => ({ id: l.id, route: l.route, enabled: l.enabled, pattern: l.pattern })) } });
  }

  private enabled(): boolean {
    const parsed = LessonAdviceSettings.safeParse(this.deps.settings.raw(LESSON_ADVICE_SETTING) ?? {});
    return parsed.success ? parsed.data.enabled : true;
  }

  private corrections(workspaceId: string) {
    return foldCorrections(this.deps.events(workspaceId, CORRECTION_EVENTS, LESSON_HISTORY_EVENTS), (id) => {
      const s = this.deps.session(id);
      return s ? { title: s.title, agentId: s.agentId } : null;
    });
  }

  private dismissed(workspaceId: string): LessonDismissed {
    return this.deps.settings.get<LessonDismissed>(lessonsDismissedKey(workspaceId), {});
  }

  advice(workspaceId: string): LessonAdvice {
    if (!this.enabled()) return { suggestions: [] };
    return { suggestions: suggestLessons(this.corrections(workspaceId), this.list(workspaceId), this.dismissed(workspaceId)) };
  }

  /** Add lesson: from a suggestion (its occasions are recomputed here) or, with key "manual", without evidence. */
  adopt(workspaceId: string, key: string, draft: LessonDraft): Lesson {
    const lessons = this.list(workspaceId);
    if (lessons.length >= LESSON_LIMITS.lessons) throw new RpcError('invalid', `This repository already has ${LESSON_LIMITS.lessons} lessons. Remove one first.`);
    const text = clean(draft.text);
    if (!text) throw new RpcError('invalid', 'Write the lesson first.');
    const evidence = key === 'manual' ? { count: 0, occasions: [] } : lessonEvidence(this.corrections(workspaceId), key);
    const lesson: Lesson = {
      id: randomUUID(),
      text,
      route: draft.route,
      pattern: cleanPattern(draft.pattern),
      enabled: true,
      occasions: evidence.occasions,
      createdAt: new Date(this.deps.now()).toISOString(),
      lastSentAt: null,
      sent: 0,
      notFollowed: 0,
      lastNotFollowedAt: null,
    };
    this.deps.settings.set(lessonsKey(workspaceId), [...lessons, lesson]);
    this.deps.audit({ workspaceId, sessionId: null, actor: 'user', action: 'lessons.adopted', detail: { id: lesson.id, key, route: lesson.route, pattern: lesson.pattern, occasions: evidence.count } });
    return lesson;
  }

  dismiss(workspaceId: string, key: string, forever: boolean): void {
    const at = lessonEvidence(this.corrections(workspaceId), key).count;
    this.deps.settings.set(lessonsDismissedKey(workspaceId), { ...this.dismissed(workspaceId), [key]: { forever, at } });
    this.deps.audit({ workspaceId, sessionId: null, actor: 'user', action: 'lessons.suggestion.dismissed', detail: { key, forever } });
  }

  rehearse(workspaceId: string, pattern: string): LessonRehearsal {
    return rehearseLesson(pattern, commandsOf(this.deps.events(workspaceId, COMMAND_EVENTS, LESSON_HISTORY_EVENTS)));
  }

  /**
   * The standing notes for a new session: the enabled first-prompt lessons, or only `ids` among them. Counts each
   * as sent. Null when there is nothing to send.
   */
  notesFor(workspaceId: string, ids: string[] | undefined): { text: string; ids: string[] } | null {
    const lessons = this.list(workspaceId);
    const chosen = lessons.filter((l) => l.enabled && l.route === 'first-prompt' && (!ids || ids.includes(l.id)));
    const text = standingNotesBlock(chosen.map((l) => l.text));
    if (!text) return null;
    const at = new Date(this.deps.now()).toISOString();
    const sent = new Set(chosen.map((l) => l.id));
    this.deps.settings.set(
      lessonsKey(workspaceId),
      lessons.map((l) => (sent.has(l.id) ? { ...l, sent: l.sent + 1, lastSentAt: at } : l)),
    );
    return { text, ids: [...sent] };
  }

  /**
   * Writes the enabled instruction-file lessons into the marked block of AGENTS.md in the checkout (and CLAUDE.md
   * when asked or when it already has a block). Only the block changes; nothing is committed.
   */
  async writeFiles(workspaceId: string, alsoClaude: boolean): Promise<LessonFiles> {
    const root = this.deps.workspaceRoot(workspaceId);
    const texts = this.list(workspaceId)
      .filter((l) => l.enabled && l.route === 'instruction-files')
      .map((l) => l.text);
    const read = (name: string) => {
      const p = join(root, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    };
    const changed: string[] = [];
    const write = (name: string) => {
      const before = read(name);
      const after = applyLessonsBlock(before, texts);
      if (after === null || after === before) return;
      writeFileSync(join(root, name), after, 'utf8');
      changed.push(name);
    };
    write('AGENTS.md');
    const claude = read('CLAUDE.md');
    if (claude !== null && !importsAgents(claude) && (alsoClaude || hasLessonsBlock(claude))) write('CLAUDE.md');
    const claudeNow = read('CLAUDE.md');
    const status = await this.deps.instructionStatus(root);
    const readers = status.agents.filter((a) => a.files.some((f) => f.scope === 'project' && f.path === 'AGENTS.md')).map((a) => a.agentId);
    if (changed.length) this.deps.audit({ workspaceId, sessionId: null, actor: 'user', action: 'lessons.files.written', detail: { files: changed, lessons: texts.length } });
    return {
      changed,
      readers,
      claudeSeparate: claudeNow !== null && !importsAgents(claudeNow) && !hasLessonsBlock(claudeNow) && texts.length > 0,
      lessons: texts.length,
    };
  }

  // ------------------------------------------------------------------ watch

  private onEvent(e: SessionEvent) {
    if (TRANSIENT_EVENTS.has(e.type)) return;
    if (e.type === 'turn.started') {
      this.turns.set(e.sessionId, e.turnId);
      return;
    }
    if (e.type === 'turn.ended') {
      this.turns.delete(e.sessionId);
      for (const k of this.flagged) if (k.startsWith(`${e.turnId}:`)) this.flagged.delete(k);
      return;
    }
    const req =
      e.type === 'command.started'
        ? { kind: 'execute' as const, title: e.command, detail: e.command }
        : e.type === 'permission.requested' && e.kind === 'execute'
          ? { kind: e.kind, title: e.title, detail: e.detail }
          : null;
    if (!req) return;
    const session = this.deps.session(e.sessionId);
    if (!session) return;
    const turnId = this.turns.get(e.sessionId) ?? null;
    const lessons = this.list(session.workspaceId);
    const hits = lessons.filter((l) => l.enabled && l.pattern && session.createdAt >= l.createdAt && lessonPatternMatches(l.pattern, req) && !this.flagged.has(`${turnId}:${l.id}`));
    if (!hits.length) return;
    const at = new Date(this.deps.now()).toISOString();
    for (const l of hits) {
      this.flagged.add(`${turnId}:${l.id}`);
      this.deps.record(e.sessionId, { type: 'notice', level: 'warning', text: notFollowedText(l.text) }, turnId);
    }
    const hit = new Set(hits.map((l) => l.id));
    // Re-read: recording the notice may have run other listeners that changed the list.
    this.deps.settings.set(
      lessonsKey(session.workspaceId),
      this.list(session.workspaceId).map((l) => (hit.has(l.id) ? { ...l, notFollowed: l.notFollowed + 1, lastNotFollowedAt: at } : l)),
    );
  }
}

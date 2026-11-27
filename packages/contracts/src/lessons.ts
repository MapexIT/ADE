import { z } from 'zod';
import { MessageOrigin } from './events.ts';

/**
 * ED-05: lessons. A lesson is a sentence in the user's own words that ADE hands to every agent, either with the
 * first prompt of each new session or in a marked block of AGENTS.md. Stored per workspace in settings.
 */
const Id = z.string().min(1).max(200);

export const LESSON_LIMITS = {
  text: 500,
  pattern: 500,
  lessons: 50,
  occasions: 10,
} as const;

/** `first-prompt`: personal, appended to the first prompt of new sessions. `instruction-files`: shared, in AGENTS.md. */
export const LessonRoute = z.enum(['first-prompt', 'instruction-files']);
export type LessonRoute = z.infer<typeof LessonRoute>;

/** One time the user said it: a correction ADE recognised. */
export const LessonOccasion = z.object({
  sessionId: Id,
  sessionTitle: z.string().max(200),
  agentId: z.string().max(100),
  ts: z.string().max(100),
  origin: MessageOrigin,
  /** The sentence as the user wrote it, redacted. */
  text: z.string().max(LESSON_LIMITS.text),
});
export type LessonOccasion = z.infer<typeof LessonOccasion>;

export const Lesson = z.object({
  id: Id,
  text: z.string().trim().min(1).max(LESSON_LIMITS.text),
  route: LessonRoute,
  /** Optional watch pattern in the workspace-rule syntax (AP-06), matched against commands agents run. */
  pattern: z.string().trim().max(LESSON_LIMITS.pattern).nullable(),
  enabled: z.boolean(),
  occasions: z.array(LessonOccasion).max(LESSON_LIMITS.occasions),
  createdAt: z.string().max(100),
  lastSentAt: z.string().max(100).nullable(),
  sent: z.number().int().nonnegative(),
  notFollowed: z.number().int().nonnegative(),
  lastNotFollowedAt: z.string().max(100).nullable(),
});
export type Lesson = z.infer<typeof Lesson>;

/** What the user can set when adding or adopting a lesson; the rest is ADE's bookkeeping. */
export const LessonDraft = z.object({
  text: z.string().trim().min(1).max(LESSON_LIMITS.text),
  route: LessonRoute,
  pattern: z.string().trim().max(LESSON_LIMITS.pattern).nullable(),
});
export type LessonDraft = z.infer<typeof LessonDraft>;

export const LessonSuggestion = z.object({
  /** Stable for the group: the sorted words of its oldest sentence. */
  key: z.string().max(200),
  /** The newest sentence of the group, redacted: what the dialog offers to keep. */
  text: z.string().max(LESSON_LIMITS.text),
  count: z.number().int().positive(),
  sessions: z.number().int().positive(),
  agents: z.array(z.string()).max(10),
  occasions: z.array(LessonOccasion).max(LESSON_LIMITS.occasions),
  /** Per session, the timeline item of its newest occasion (`user:<seq>` or `perm:<requestId>`). */
  anchors: z.array(z.object({ sessionId: Id, itemKey: z.string().max(300) })).max(50),
  lastTs: z.string(),
});
export type LessonSuggestion = z.infer<typeof LessonSuggestion>;

export const LessonAdvice = z.object({ suggestions: z.array(LessonSuggestion).max(10) });
export type LessonAdvice = z.infer<typeof LessonAdvice>;

/** Stored under the settings key `lessonAdvice`. */
export const LessonAdviceSettings = z.object({ enabled: z.boolean().default(true) });
export type LessonAdviceSettings = z.infer<typeof LessonAdviceSettings>;

/** A watch pattern replayed over the commands agents ran or asked to run in the workspace. */
export const LessonRehearsal = z.object({
  considered: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  examples: z.array(z.object({ text: z.string().max(300), count: z.number().int().positive() })).max(5),
});
export type LessonRehearsal = z.infer<typeof LessonRehearsal>;

/** The result of writing the marked lessons block into the checkout's instruction files. */
export const LessonFiles = z.object({
  /** Files whose content changed (repository-relative). */
  changed: z.array(z.string().max(100)).max(2),
  /** Agent ids that read AGENTS.md in this repository, from the ED-04 resolver. */
  readers: z.array(z.string().max(100)).max(5),
  /** CLAUDE.md exists, does not import @AGENTS.md and has no lessons block, so Claude Code does not see them. */
  claudeSeparate: z.boolean(),
  lessons: z.number().int().nonnegative(),
});
export type LessonFiles = z.infer<typeof LessonFiles>;

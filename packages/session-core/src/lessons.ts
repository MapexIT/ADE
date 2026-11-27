import {
  redactSecrets,
  LESSON_LIMITS,
  type Lesson,
  type LessonOccasion,
  type LessonRehearsal,
  type LessonSuggestion,
  type MessageOrigin,
  type PromptBlock,
  type SessionEvent,
} from '@ade/contracts';
import { commandText, ruleTouches, type RequestText } from './rule-advice.ts';

/**
 * ED-05: lessons. Pure and agent-neutral: recognises the user's corrections in stored session events, groups the
 * sentences that repeat across sessions or agents, and builds what ADE hands to agents (the standing notes block
 * of a first prompt and the marked block of AGENTS.md). No model is involved anywhere.
 */

export const LESSON_ADVICE_LIMITS = {
  /** Two sentences belong together at this word overlap (Jaccard) or more. */
  overlap: 0.6,
  /** Words in a sentence that can become a lesson. */
  minWords: 2,
  maxWords: 40,
  /** A dismissed suggestion comes back after this many more occasions ("Not now"). */
  again: 2,
  suggestions: 10,
  unusedDays: 30,
} as const;

/** Origins that are corrections. `composer` is an ordinary prompt. */
export const CORRECTION_ORIGINS: ReadonlySet<MessageOrigin> = new Set(['interrupt', 'review-comment', 'reject-note', 'loop-redirect', 'after-undo']);

/** One correction ADE recognised. `itemKey` is the timeline item it belongs to (`user:<seq>` or `perm:<requestId>`). */
export interface Correction {
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  ts: string;
  origin: MessageOrigin;
  text: string;
  itemKey: string;
}

export type LessonDismissed = Record<string, { forever: boolean; at: number }>;

// ---------------------------------------------------------------------------------------------------------------
// Standing notes and the instruction-file block

export const STANDING_NOTES_HEADING = 'Standing notes from the user:';
export const LESSONS_START = '<!-- ade:lessons -->';
export const LESSONS_END = '<!-- /ade:lessons -->';
export const LESSONS_BLOCK_INTRO = 'Standing notes from the user, kept by ADE (Settings, Lessons):';

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

/** The text block appended to a first prompt, after the user's own words; null when there is nothing to send. */
export function standingNotesBlock(texts: readonly string[]): string | null {
  const lines = texts.map(oneLine).filter(Boolean);
  if (!lines.length) return null;
  return `\n\n${STANDING_NOTES_HEADING}\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** The text of a prompt as the user wrote it: text blocks joined, without a standing notes block. */
export function promptText(content: readonly PromptBlock[]): string {
  const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const at = text.indexOf(`\n\n${STANDING_NOTES_HEADING}`);
  const own = at >= 0 ? text.slice(0, at) : text.startsWith(STANDING_NOTES_HEADING) ? '' : text;
  return own.trim();
}

/**
 * Writes the lessons into the marked block of an instruction file. Only the block changes; the rest of the file
 * stays byte for byte. Line endings follow the file (CRLF when it has any). With no lessons the block is removed.
 * Idempotent. `content` null means the file does not exist; the result is null when it still should not.
 */
export function applyLessonsBlock(content: string | null, texts: readonly string[]): string | null {
  const eol = content?.includes('\r\n') ? '\r\n' : '\n';
  const lines = texts.map(oneLine).filter(Boolean);
  const block = [LESSONS_START, LESSONS_BLOCK_INTRO, ...lines.map((l) => `- ${l}`), LESSONS_END].join(eol);
  const text = content ?? '';
  const start = text.indexOf(LESSONS_START);
  const end = start >= 0 ? text.indexOf(LESSONS_END, start) : -1;
  if (start >= 0 && end >= 0) {
    let before = text.slice(0, start);
    let after = text.slice(end + LESSONS_END.length);
    if (lines.length) return before + block + after;
    if (after.startsWith(eol)) after = after.slice(eol.length);
    if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
    return before + after;
  }
  if (!lines.length) return content;
  const sep = text === '' ? '' : text.endsWith(eol) ? eol : eol + eol;
  return text + sep + block + eol;
}

/** Whether CLAUDE.md pulls in AGENTS.md, so Claude Code reads the block too. */
export const importsAgents = (claudeMd: string) => /@AGENTS\.md\b/.test(claudeMd);
export const hasLessonsBlock = (text: string) => text.includes(LESSONS_START);

// ---------------------------------------------------------------------------------------------------------------
// Recognising corrections

/** A review comment sent to the agent (RV-05 single, RV-09 batch): only the user's comment text. */
export function correctionText(origin: MessageOrigin, text: string): string {
  if (origin !== 'review-comment') return text.trim();
  const lines = text.split(/\r?\n/);
  if (lines[0]?.startsWith('Review comment on ')) return lines.slice(1).join('\n').trim();
  const bullets = lines.flatMap((l) => {
    const m = /^- line \d+: (.*)$/.exec(l);
    return m ? [m[1]!] : [];
  });
  return bullets.length ? bullets.join('\n').trim() : text.trim();
}

interface Track {
  cancelled: boolean;
  undone: boolean;
  lastNote: string | null;
}

/**
 * The user's corrections, oldest first: reject notes, and user messages sent with Interrupt and send, as review
 * comments, as a loop redirect or as the first prompt after an undone turn. Messages without an origin (stored
 * before ED-05) count as an interrupt after a cancelled turn and as after-undo after an "Undid turn" notice.
 * The note a reject sends on is the same correction as the reject, so that message is skipped.
 */
export function foldCorrections(events: readonly SessionEvent[], meta: (sessionId: string) => { title: string; agentId: string } | null): Correction[] {
  const tracks = new Map<string, Track>();
  const metas = new Map<string, { title: string; agentId: string } | null>();
  const metaOf = (id: string) => {
    if (!metas.has(id)) metas.set(id, meta(id));
    return metas.get(id) ?? null;
  };
  const out: Correction[] = [];
  const push = (e: SessionEvent, origin: MessageOrigin, text: string, itemKey: string) => {
    if (!text.trim()) return;
    const m = metaOf(e.sessionId);
    out.push({ sessionId: e.sessionId, sessionTitle: m?.title ?? '', agentId: m?.agentId ?? '', ts: e.ts, origin, text, itemKey });
  };
  for (const e of events) {
    let t = tracks.get(e.sessionId);
    if (!t) {
      t = { cancelled: false, undone: false, lastNote: null };
      tracks.set(e.sessionId, t);
    }
    if (e.type === 'turn.ended') t.cancelled = e.stopReason === 'cancelled';
    else if (e.type === 'notice' && e.text.startsWith('Undid turn')) t.undone = true;
    else if (e.type === 'permission.decided') {
      const note = e.note?.trim();
      if (e.decidedBy === 'user' && note) {
        push(e, 'reject-note', note, `perm:${e.requestId}`);
        t.lastNote = note;
      }
    } else if (e.type === 'user.message') {
      const text = promptText(e.content);
      let origin: MessageOrigin | undefined = e.origin;
      const isNote = origin === 'reject-note' || (!origin && t.lastNote !== null && text === t.lastNote);
      if ((!origin || origin === 'composer') && t.undone) origin = 'after-undo';
      else if (!origin && t.cancelled) origin = 'interrupt';
      t.cancelled = false;
      t.undone = false;
      t.lastNote = null;
      if (isNote || !origin || !CORRECTION_ORIGINS.has(origin)) continue;
      push(e, origin, correctionText(origin, text), `user:${e.seq}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sentences, words and grouping

const STOP = new Set(
  `a an the to of in on at for and or but so as by from with into onto than then also just please kindly instead rather
   is are be been being was were am it its this that these those there here i me my we our us you your yours
   should must will would shall can could may might do does did done let lets make sure`
    .split(/\s+/)
    .filter(Boolean),
);
const DEMONSTRATIVE = new Set(['this', 'that', 'these', 'those', 'it', 'them', 'here', 'there']);
const LEADING = new Set(['please', 'just', 'also', 'never', 'always', 'dont', "don't", 'do', 'not', 'now', 'again', 'and']);
const QUESTION_START = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which']);

/** Sentences of a correction: split at sentence ends, semicolons and line breaks; list markers removed. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\r?\n+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

const rawWords = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}'’_-]+/gu) ?? [];

/** Lower-case words without punctuation and stop words; "n't" becomes "not" so "don't" and "do not" agree. */
export function lessonWords(sentence: string): string[] {
  const text = sentence
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/n't\b/g, ' not')
    .replace(/[^\p{L}\p{N}_\-./@]+/gu, ' ');
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((w) => w && !STOP.has(w));
}

/**
 * Whether a sentence reads like a standing instruction rather than a remark about one spot: not a question, a few
 * words long, and the word after its leading verb is not "this", "that", "it" or "here" ("rename this").
 */
export function isLessonLike(sentence: string): boolean {
  const s = sentence.trim();
  if (!s || s.endsWith('?')) return false;
  const raw = rawWords(s).map((w) => w.replace(/’/g, "'"));
  if (raw.length < LESSON_ADVICE_LIMITS.minWords || raw.length > LESSON_ADVICE_LIMITS.maxWords) return false;
  if (QUESTION_START.has(raw[0]!)) return false;
  let i = 0;
  while (i < raw.length - 1 && LEADING.has(raw[i]!)) i++;
  const object = raw[i + 1];
  if (object !== undefined && DEMONSTRATIVE.has(object)) return false;
  if (raw.length - i <= 2 && raw.slice(i).some((w) => DEMONSTRATIVE.has(w))) return false;
  return lessonWords(s).length >= LESSON_ADVICE_LIMITS.minWords;
}

/** Word overlap of two sentences: shared words over all words (Jaccard). */
export function overlap(a: ReadonlySet<string> | readonly string[], b: ReadonlySet<string> | readonly string[]): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

interface Said {
  correction: Correction;
  sentence: string;
  words: Set<string>;
}

interface Group {
  key: string;
  members: Said[];
}

/** Groups the lesson-like sentences of the corrections, oldest first. A sentence joins the first group it overlaps. */
export function groupCorrections(corrections: readonly Correction[]): Group[] {
  const groups: Group[] = [];
  for (const c of corrections) {
    for (const sentence of splitSentences(c.text)) {
      if (!isLessonLike(sentence)) continue;
      const words = new Set(lessonWords(sentence));
      const said = { correction: c, sentence, words };
      const g = groups.find((x) => x.members.some((m) => overlap(m.words, words) >= LESSON_ADVICE_LIMITS.overlap));
      if (g) g.members.push(said);
      else groups.push({ key: [...words].sort().join(' ').slice(0, 200), members: [said] });
    }
  }
  return groups;
}

const shown = (t: string) => redactSecrets(oneLine(t)).slice(0, LESSON_LIMITS.text);
const distinct = (xs: string[], max = 10) => [...new Set(xs.filter(Boolean))].slice(0, max);

/** Whether a lesson already says what a group says. */
const covered = (lessons: readonly Pick<Lesson, 'text'>[], g: Group) =>
  lessons.some((l) => {
    const words = new Set(lessonWords(l.text));
    return g.members.some((m) => overlap(m.words, words) >= LESSON_ADVICE_LIMITS.overlap);
  });

/**
 * Lessons suggested by repetition: a group of sentences said in two sessions or to two agents. Never one a lesson
 * already covers or one dismissed (Not now returns after two more occasions; Never suggest this does not). Newest
 * first.
 */
export function suggestLessons(corrections: readonly Correction[], lessons: readonly Pick<Lesson, 'text'>[], dismissed: LessonDismissed): LessonSuggestion[] {
  const out: LessonSuggestion[] = [];
  for (const g of groupCorrections(corrections)) {
    const sessions = distinct(g.members.map((m) => m.correction.sessionId), 1_000);
    const agents = distinct(g.members.map((m) => m.correction.agentId));
    if (sessions.length < 2 && agents.length < 2) continue;
    if (covered(lessons, g)) continue;
    const count = g.members.length;
    const d = dismissed[g.key];
    if (d && (d.forever || count < d.at + LESSON_ADVICE_LIMITS.again)) continue;
    const newest = g.members.at(-1)!;
    const newestFirst = [...g.members].reverse();
    const anchors = new Map<string, string>();
    for (const m of newestFirst) if (!anchors.has(m.correction.sessionId)) anchors.set(m.correction.sessionId, m.correction.itemKey);
    out.push({
      key: g.key,
      text: shown(newest.sentence),
      count,
      sessions: sessions.length,
      agents,
      occasions: newestFirst.slice(0, LESSON_LIMITS.occasions).map(occasionOf),
      anchors: [...anchors].slice(0, 50).map(([sessionId, itemKey]) => ({ sessionId, itemKey })),
      lastTs: newest.correction.ts,
    });
  }
  return out.sort((a, b) => b.lastTs.localeCompare(a.lastTs)).slice(0, LESSON_ADVICE_LIMITS.suggestions);
}

const occasionOf = (m: Said): LessonOccasion => ({
  sessionId: m.correction.sessionId,
  sessionTitle: m.correction.sessionTitle.slice(0, 200),
  agentId: m.correction.agentId.slice(0, 100),
  ts: m.correction.ts,
  origin: m.correction.origin,
  text: shown(m.sentence),
});

/** The occasions behind a suggestion key now (stored when it is dismissed or adopted). */
export function lessonEvidence(corrections: readonly Correction[], key: string): { count: number; occasions: LessonOccasion[] } {
  const g = groupCorrections(corrections).find((x) => x.key === key);
  if (!g) return { count: 0, occasions: [] };
  return { count: g.members.length, occasions: [...g.members].reverse().slice(0, LESSON_LIMITS.occasions).map(occasionOf) };
}

// ---------------------------------------------------------------------------------------------------------------
// Watch patterns

/** Whether a lesson's watch pattern matches a command (whole text or any step, as workspace rules match). */
export function lessonPatternMatches(pattern: string, req: RequestText): boolean {
  const p = pattern.trim();
  if (!p) return false;
  return ruleTouches({ id: 'lesson', decision: 'deny', kind: 'execute', pattern: p }, req);
}

/** A watch pattern replayed over past commands (each a `command.started` or an execute permission request). */
export function rehearseLesson(pattern: string, commands: readonly RequestText[]): LessonRehearsal {
  const counts = new Map<string, number>();
  let matched = 0;
  for (const req of commands) {
    if (!lessonPatternMatches(pattern, req)) continue;
    matched++;
    const t = redactSecrets(commandText(req)).slice(0, 300);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const examples = [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  return { considered: commands.length, matched, examples };
}

/** The commands in stored events that watch patterns are checked against, oldest first. */
export function commandsOf(events: readonly SessionEvent[]): RequestText[] {
  return events.flatMap((e): RequestText[] => {
    if (e.type === 'command.started') return [{ kind: 'execute', title: e.command, detail: e.command }];
    if (e.type === 'permission.requested' && e.kind === 'execute') return [{ kind: e.kind, title: e.title, detail: e.detail }];
    return [];
  });
}

const DAY = 86_400_000;

/** A first-prompt lesson not sent in 30 days (counted from when it was added if never sent). */
export function lessonUnused(lesson: Pick<Lesson, 'route' | 'createdAt' | 'lastSentAt' | 'enabled'>, now: number): boolean {
  if (lesson.route !== 'first-prompt' || !lesson.enabled) return false;
  const since = Date.parse(lesson.lastSentAt ?? lesson.createdAt);
  return Number.isFinite(since) && now - since >= LESSON_ADVICE_LIMITS.unusedDays * DAY;
}

// ---------------------------------------------------------------------------------------------------------------
// Copy (UK English, sentence case)

export const timesWord = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** "You have said this 3 times, to Codex and Claude Code." */
export function lessonHintText(s: Pick<LessonSuggestion, 'count' | 'agents' | 'sessions'>, label: (id: string) => string): string {
  const names = s.agents.filter(Boolean).map(label);
  const head = `You have said this ${timesWord(s.count)}`;
  if (names.length >= 2) return `${head}, to ${list(names)}.`;
  return `${head}, in ${s.sessions} sessions${names.length ? ` with ${names[0]}` : ''}.`;
}

export const ORIGIN_WORDS: Record<MessageOrigin, string> = {
  composer: 'Message',
  interrupt: 'Interrupt and send',
  'review-comment': 'Review comment',
  'reject-note': 'Reject note',
  'loop-redirect': 'Loop redirect',
  'after-undo': 'After an undo',
};

export const ROUTE_WORDS = {
  'first-prompt': 'With the first prompt',
  'instruction-files': 'In the instruction files',
} as const;

export const ROUTE_HINTS = {
  'first-prompt': 'Added after your words in the first prompt of each new session in this repository. Nothing in the repository changes.',
  'instruction-files': 'Written into a marked block of AGENTS.md in your checkout as an uncommitted change. New sessions see it once you commit it.',
} as const;

export function lessonRehearsalText(r: Pick<LessonRehearsal, 'considered' | 'matched'>): string {
  const cmds = (n: number) => `${n} ${n === 1 ? 'command' : 'commands'}`;
  if (r.considered === 0) return 'Agents have not run any commands in this repository yet.';
  if (r.matched === 0) return `Matches none of the last ${cmds(r.considered)} agents ran or asked to run here.`;
  return `Matches ${r.matched} of the last ${cmds(r.considered)} agents ran or asked to run here.`;
}

export const notFollowedText = (text: string) => `Lesson not followed: ${oneLine(text).slice(0, 300)}`;

export const lessonsChipText = (n: number) => `${n} ${n === 1 ? 'lesson' : 'lessons'} will be sent`;

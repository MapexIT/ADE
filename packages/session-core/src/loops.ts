import type { LoopLevel, LoopPattern, SessionEvent, ToolContent, ToolKind } from '@ade/contracts';

/**
 * WA-10: loop watch. Notices when an agent seems to go round in circles within one turn. Pure and agent-neutral:
 * a fold over the ACP events ADE already records, so it behaves the same for every agent. The host runs it and
 * records what it finds as `loop.detected` events; the copy helpers are shared with the renderer.
 */

export const LOOP_LIMITS = { repeat: 4, failing: 5, pingPong: 2, window: 30, severeFactor: 2 } as const;

export interface LoopFinding {
  pattern: LoopPattern;
  subject: string;
  count: number;
  level: LoopLevel;
  detail: string | null;
}

interface ToolEntry {
  kind: ToolKind;
  title: string;
  fp: string;
  locations: string[];
  /** Paths whose diff was already folded for this call. */
  paths: string[];
  diffed: boolean;
  terminal: boolean;
  /** Set once the call's final status was handled, so a repeated completion is not counted twice. */
  done: boolean;
}

export interface LoopState {
  turnId: string | null;
  /** After `loop.dismissed`, until the turn ends. */
  muted: boolean;
  /** Fingerprints of the last `LOOP_LIMITS.window` counted actions, oldest first. */
  recent: string[];
  /** Fingerprint to title, for a finding's subject. */
  titles: Record<string, string>;
  /** Command to its failures in this turn; `last` is the last result, such as "exit 1". */
  failures: Record<string, { count: number; last: string | null }>;
  /** Path to the content hashes seen in this turn (at most 32), the current one and how often it went back. */
  files: Record<string, { seen: string[]; last: string; returns: number }>;
  /** Edit-kind and execute calls by tool call id. */
  tools: Record<string, ToolEntry>;
  /** Terminal id to command text. */
  commands: Record<string, string>;
  /** `${pattern}|${subject}` to the highest level already reported. */
  reported: Record<string, LoopLevel>;
}

export const emptyLoopState = (): LoopState => ({
  turnId: null,
  muted: false,
  recent: [],
  titles: {},
  failures: {},
  files: {},
  tools: {},
  commands: {},
  reported: {},
});

const MAX_TOOLS = 200;
const MAX_FILES = 200;
const MAX_FAILURES = 100;
const MAX_COMMANDS = 100;
const MAX_HASHES = 32;
const ABSENT = 'absent';

const EDIT_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'delete', 'move']);
const COUNTED_KINDS: ReadonlySet<ToolKind> = new Set(['read', 'search', 'execute', 'fetch', 'other']);

/** Trims, collapses whitespace and cuts at 300 characters. */
export const normaliseLoopText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

/** FNV-1a (32 bit) of the text plus its length. Only used to compare file versions; never stored. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

/** Drops the oldest keys beyond `max` (insertion order). */
function cap(record: Record<string, unknown>, max: number) {
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length - max; i++) delete record[keys[i]!];
}

const RANK: Record<LoopLevel, number> = { warning: 1, severe: 2 };

interface Fold {
  s: LoopState;
  out: LoopFinding[];
}

function check(f: Fold, pattern: LoopPattern, subject: string, count: number, limit: number, detail: string | null) {
  const level: LoopLevel | null =
    count >= limit * LOOP_LIMITS.severeFactor ? 'severe' : count >= limit ? 'warning' : null;
  if (!level) return;
  const key = `${pattern}|${subject}`;
  const before = f.s.reported[key];
  if (before && RANK[before] >= RANK[level]) return;
  f.s.reported[key] = level;
  f.out.push({ pattern, subject, count, level, detail });
}

/** Rule 5: counts an action in the window. Returns whether its fingerprint was already in the window. */
function countAction(f: Fold, fp: string, title: string): boolean {
  const s = f.s;
  const known = s.recent.includes(fp);
  s.recent.push(fp);
  if (s.recent.length > LOOP_LIMITS.window) s.recent.splice(0, s.recent.length - LOOP_LIMITS.window);
  s.titles[fp] = title;
  if (Object.keys(s.titles).length > LOOP_LIMITS.window * 2) {
    for (const k of Object.keys(s.titles)) if (!s.recent.includes(k)) delete s.titles[k];
  }
  const count = s.recent.filter((x) => x === fp).length;
  check(f, 'repeated-action', title, count, LOOP_LIMITS.repeat, null);
  return known;
}

/** Rule 9: new content clears the repetition window only. */
function progress(f: Fold) {
  f.s.recent = [];
}

/** Rule 8: one reported version of a file. `before` is the hash of its previous content when known. */
function fileVersion(f: Fold, path: string, before: string | null, after: string) {
  const s = f.s;
  let file = s.files[path];
  if (!file) {
    file = { seen: before === null ? [] : [before], last: before ?? '', returns: 0 };
    s.files[path] = file;
    cap(s.files, MAX_FILES);
  }
  if (after === file.last) {
    countAction(f, `edit|${path}|same`, normaliseLoopText(`Edit ${path}`));
    return;
  }
  if (file.seen.includes(after)) {
    file.returns++;
    file.last = after;
    check(f, 'edit-ping-pong', normaliseLoopText(path), file.returns, LOOP_LIMITS.pingPong, null);
    return;
  }
  file.seen.push(after);
  if (file.seen.length > MAX_HASHES) file.seen.splice(0, file.seen.length - MAX_HASHES);
  file.last = after;
  progress(f);
}

function diffs(f: Fold, tool: ToolEntry, content: ToolContent[]) {
  for (const c of content) {
    if (c.type === 'terminal') tool.terminal = true;
    if (c.type !== 'diff' || tool.paths.includes(c.path)) continue;
    tool.paths.push(c.path);
    tool.diffed = true;
    fileVersion(f, c.path, c.oldText === null ? ABSENT : contentHash(c.oldText), contentHash(c.newText));
  }
}

/** Rule 10: a command's result. */
function commandResult(f: Fold, command: string, failed: boolean, last: string) {
  const s = f.s;
  if (!failed) {
    delete s.failures[command];
    return;
  }
  const entry = s.failures[command] ?? { count: 0, last: null };
  delete s.failures[command];
  s.failures[command] = { count: entry.count + 1, last };
  cap(s.failures, MAX_FAILURES);
  check(f, 'failing-command', command, entry.count + 1, LOOP_LIMITS.failing, last);
}

/** Rule 7: a final status for a call ADE remembered. */
function finish(f: Fold, tool: ToolEntry, status: 'completed' | 'failed') {
  if (tool.done) return;
  tool.done = true;
  if (EDIT_KINDS.has(tool.kind)) {
    if (status !== 'completed' || tool.diffed) return;
    if (tool.kind === 'delete' && tool.locations.length) {
      for (const path of tool.locations) fileVersion(f, path, null, ABSENT);
      return;
    }
    if (!countAction(f, tool.fp, tool.title)) {
      progress(f);
      f.s.recent = [tool.fp];
    }
    return;
  }
  if (tool.kind === 'execute' && !tool.terminal) commandResult(f, tool.title, status === 'failed', status);
}

/**
 * Folds one event. Returns the next state (the input is not changed) and the findings whose level this event
 * reached. Events outside an ADE turn (such as `session/load` replay) are ignored.
 */
export function applyLoop(prev: LoopState, e: SessionEvent): { state: LoopState; findings: LoopFinding[] } {
  if (e.type === 'turn.started') return { state: { ...emptyLoopState(), turnId: e.turnId }, findings: [] };
  if (prev.turnId === null) return { state: prev, findings: [] };
  if (e.type === 'turn.ended') return { state: emptyLoopState(), findings: [] };
  const f: Fold = { s: structuredClone(prev), out: [] };
  const s = f.s;
  switch (e.type) {
    case 'loop.dismissed':
      if (e.turnId === s.turnId) s.muted = true;
      break;
    case 'tool.call': {
      if (e.kind === 'think' || e.kind === 'switch_mode') break;
      const title = normaliseLoopText(e.title);
      const fp = `${e.kind}|${title}|${[...e.locations].sort().join(',')}`;
      const remember = EDIT_KINDS.has(e.kind) || e.kind === 'execute';
      const tool: ToolEntry = { kind: e.kind, title, fp, locations: [...e.locations], paths: [], diffed: false, terminal: false, done: false };
      if (remember) {
        delete s.tools[e.toolCallId];
        s.tools[e.toolCallId] = tool;
        cap(s.tools, MAX_TOOLS);
      }
      if (COUNTED_KINDS.has(e.kind)) countAction(f, fp, title);
      diffs(f, tool, e.content);
      if (e.status === 'completed' || e.status === 'failed') finish(f, tool, e.status);
      break;
    }
    case 'tool.update': {
      const tool = s.tools[e.toolCallId];
      if (!tool) break;
      if (e.content) diffs(f, tool, e.content);
      if (e.status === 'completed' || e.status === 'failed') finish(f, tool, e.status);
      break;
    }
    case 'command.started':
      delete s.commands[e.terminalId];
      s.commands[e.terminalId] = normaliseLoopText(e.command);
      cap(s.commands, MAX_COMMANDS);
      break;
    case 'command.exited': {
      const command = s.commands[e.terminalId];
      if (command === undefined || e.killed) break;
      const failed = e.exitCode !== 0;
      commandResult(f, command, failed, e.exitCode !== null ? `exit ${e.exitCode}` : `stopped by ${e.signal ?? 'a signal'}`);
      break;
    }
    default:
      break;
  }
  return { state: s, findings: s.muted ? [] : f.out };
}

/** The finding's headline, e.g. "Repeated the same step 4 times: Read README.md". */
export function loopTitle(f: Pick<LoopFinding, 'pattern' | 'subject' | 'count'>): string {
  switch (f.pattern) {
    case 'repeated-action':
      return `Repeated the same step ${f.count} times: ${f.subject}`;
    case 'failing-command':
      return `The same command has failed ${f.count} times: ${f.subject}`;
    case 'edit-ping-pong':
      return `${f.subject} keeps going back to an earlier version`;
  }
}

/** One sentence saying what was counted. */
export function loopBody(f: Pick<LoopFinding, 'pattern' | 'count' | 'detail'>): string {
  switch (f.pattern) {
    case 'repeated-action':
      return 'The agent reported no new edit in between.';
    case 'failing-command':
      return f.detail ? `Last result: ${f.detail}.` : '';
    case 'edit-ping-pong':
      return `Its content returned to a version from this turn ${f.count} times.`;
  }
}

/** The suggested instruction for "Redirect the agent". The user edits it and sends it themselves. */
export function loopRedirect(f: Pick<LoopFinding, 'pattern' | 'subject' | 'count'>): string {
  switch (f.pattern) {
    case 'repeated-action':
      return `You have repeated the same step ${f.count} times without changing anything: ${f.subject}. Stop repeating it. Say what you learnt from it and what is blocking you, then try a different approach.`;
    case 'failing-command':
      return `\`${f.subject}\` has failed ${f.count} times in this turn. Stop re-running it. Explain the root cause of the failure first, then make one fix before you run it again.`;
    case 'edit-ping-pong':
      return `You keep switching ${f.subject} between the same versions. Stop editing it. Say which version is right and why, then make that change once.`;
  }
}

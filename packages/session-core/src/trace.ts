import type { SessionEvent, ToolContent, ToolKind, ToolStatus } from '@ade/contracts';
import { repoPath } from './receipt.ts';

/**
 * RV-17: Trace. Which turn, tool call and prompt wrote each changed line of a session's diff. Pure and agent-neutral:
 * the host hands in the file's text at each checkpoint and the session's ACP events; nothing here calls Git or a
 * model. A line no reported edit accounts for is labelled, never guessed.
 */

// ------------------------------------------------------------------------------------------------ lines and diff

/** A file as lines. `noEol` when the last line has no line break; `\r` stays part of a line, as Git counts it. */
export interface Lines {
  lines: string[];
  noEol: boolean;
}

export function toLines(text: string | null): Lines {
  if (!text) return { lines: [], noEol: false };
  const lines = text.split('\n');
  const noEol = lines.at(-1) !== '';
  if (!noEol) lines.pop();
  return { lines, noEol };
}

/** Exact identity, as Git compares lines: the last line without a line break differs from the same text with one. */
const exactKeys = (l: Lines) => l.lines.map((s, i) => (l.noEol && i === l.lines.length - 1 ? `${s}\u0000` : s));

/**
 * For each line of `b`, the index of the line of `a` it is matched to, or -1 when it was inserted. A minimal line
 * diff (Myers' O(ND) algorithm with the linear-space middle-snake split), so its counts equal `git diff`'s.
 */
export function matchLines(a: readonly string[], b: readonly string[]): Int32Array {
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const A = Int32Array.from(a, id);
  const B = Int32Array.from(b, id);
  const out = new Int32Array(B.length).fill(-1);
  const stack: [number, number, number, number][] = [[0, A.length, 0, B.length]];
  while (stack.length) {
    let [aLo, aHi, bLo, bHi] = stack.pop()!;
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) out[bLo++] = aLo++;
    while (aLo < aHi && bLo < bHi && A[aHi - 1] === B[bHi - 1]) out[--bHi] = --aHi;
    if (aLo === aHi || bLo === bHi) continue;
    const split = bisect(A, B, aLo, aHi, bLo, bHi);
    if (!split) continue; // nothing in common: every line in the range is replaced
    const [x, y] = split;
    stack.push([aLo, x, bLo, y], [x, aHi, y, bHi]);
  }
  return out;
}

/** The middle of an optimal edit path through a[aLo..aHi) and b[bLo..bHi), or null when they share no line. */
function bisect(A: Int32Array, B: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[i - 1]! < v1[i + 1]!) ? v1[i + 1]! : v1[i - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[i] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const j = off + delta - k1;
        if (j >= 0 && j < size && v2[j] !== -1 && x1 >= n - v2[j]!) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[i - 1]! < v2[i + 1]!) ? v2[i + 1]! : v2[i - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && A[aHi - x2 - 1] === B[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[i] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const j = off + delta - k2;
        if (j >= 0 && j < size && v1[j] !== -1) {
          const x1 = v1[j]!;
          const y1 = off + x1 - j;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ origins

/** How a version of the file came from the one before it. */
export type Transition = { kind: 'agent'; turnIndex: number } | { kind: 'user' } | { kind: 'unknown' };
export type Origin = { kind: 'base' } | Transition;

interface LineState {
  origin: Origin;
  /** The last transition that changed the line's exact bytes (a line break added at the end of the file). */
  touch: Transition | null;
  /** Its line index in the base version while it is unchanged since then. */
  base: number | null;
}

export interface TraceVersion {
  /** The file's text at this point; null when it does not exist there. */
  text: string | null;
  /** How this version came from the previous one. Ignored for the first (base) version. */
  via: Transition;
}

export interface TracedLine {
  /** 1-based, in the final version for `new` and in the base version for `old`. */
  line: number;
  side: 'new' | 'old';
  /** The transition that wrote (new) or removed (old) the line's current text. */
  origin: Transition;
  text: string;
}

export interface TracedHunk {
  /** 1-based first line on each side; for an empty side, the line after which the change sits. */
  oldStart: number;
  newStart: number;
  /** Indexes into `TracedFile.lines`. */
  lines: number[];
}

export interface TracedFile {
  lines: TracedLine[];
  hunks: TracedHunk[];
  additions: number;
  deletions: number;
}

/**
 * Carries each line's origin forward over the versions (base first) and returns the origin of every line that the
 * diff from the base to the last version adds or removes. Carry-forward ignores a missing line break at the end of
 * the file, so "alpha" becoming "alpha\nbeta" keeps alpha's origin; the final diff is exact, so the counts match Git.
 */
export function traceFile(versions: readonly TraceVersion[]): TracedFile {
  const [first, ...rest] = versions;
  const base = toLines(first?.text ?? null);
  let cur = base;
  let state: LineState[] = base.lines.map((_, i) => ({ origin: { kind: 'base' }, touch: null, base: i }));
  const removedBy = new Map<number, Transition>();
  for (const v of rest) {
    const next = toLines(v.text);
    const match = matchLines(cur.lines, next.lines);
    const prevExact = exactKeys(cur);
    const nextExact = exactKeys(next);
    const kept = new Uint8Array(cur.lines.length);
    const nextState: LineState[] = [];
    for (let j = 0; j < next.lines.length; j++) {
      const i = match[j]!;
      if (i < 0) {
        nextState.push({ origin: v.via, touch: v.via, base: null });
        continue;
      }
      kept[i] = 1;
      const s = state[i]!;
      if (prevExact[i] === nextExact[j]) {
        nextState.push(s);
        continue;
      }
      // Only the final line break changed: Git sees the base line removed and written again by this step.
      if (s.base !== null) removedBy.set(s.base, v.via);
      nextState.push({ ...s, touch: v.via });
    }
    for (let i = 0; i < cur.lines.length; i++) {
      const b = state[i]!.base;
      if (!kept[i] && b !== null) removedBy.set(b, v.via);
    }
    cur = next;
    state = nextState;
  }

  // The session diff: base to the last version, exactly as Git counts it.
  const match = matchLines(exactKeys(base), exactKeys(cur));
  const lines: TracedLine[] = [];
  const hunks: TracedHunk[] = [];
  const unknown: Transition = { kind: 'unknown' };
  let ai = 0;
  let bj = 0;
  const flush = (aTo: number, bTo: number) => {
    if (ai === aTo && bj === bTo) return;
    const hunk: TracedHunk = { oldStart: ai + (ai < aTo ? 1 : 0), newStart: bj + (bj < bTo ? 1 : 0), lines: [] };
    for (; ai < aTo; ai++) {
      hunk.lines.push(lines.length);
      // A base line the carry-forward kept but the final diff removes (lines moved): unknown, never a guess.
      lines.push({ line: ai + 1, side: 'old', origin: removedBy.get(ai) ?? unknown, text: base.lines[ai]! });
    }
    for (; bj < bTo; bj++) {
      const s = state[bj]!;
      const origin = s.origin.kind === 'base' ? (s.touch ?? unknown) : s.origin;
      hunk.lines.push(lines.length);
      lines.push({ line: bj + 1, side: 'new', origin, text: cur.lines[bj]! });
    }
    hunks.push(hunk);
  };
  for (let j = 0; j < match.length; j++) {
    const i = match[j]!;
    if (i < 0) continue;
    flush(i, j);
    ai = i + 1;
    bj = j + 1;
  }
  flush(base.lines.length, cur.lines.length);
  const additions = lines.filter((l) => l.side === 'new').length;
  return { lines, hunks, additions, deletions: lines.length - additions };
}

// ------------------------------------------------------------------------------------------------ checkpoints

export interface TraceTurn {
  index: number;
  startedAt: string;
  endedAt: string | null;
  startCheckpoint: string | null;
  endCheckpoint: string | null;
}

/** A checkpoint in the chain and how its content came from the point before. `gap` is time between turns. */
export interface ChainPoint {
  commit: string;
  via: { kind: 'agent'; turnIndex: number } | { kind: 'gap' } | { kind: 'unknown' };
}

/**
 * RV-04: turns an undo threw away. An undo of turn `u` at time `ts` removes every turn from `u` on that had started
 * by then; their checkpoints no longer describe the worktree, so they leave the chain.
 */
export function undoneTurns(turns: readonly TraceTurn[], undos: readonly { turnIndex: number; ts: string }[]): Set<number> {
  const out = new Set<number>();
  for (const t of turns) if (undos.some((u) => t.index >= u.turnIndex && t.startedAt <= u.ts)) out.add(t.index);
  return out;
}

/**
 * The checkpoints to walk, base first and `current` (a snapshot of the worktree now) last. A step between a turn's
 * own start and end checkpoints belongs to that turn; a step from one turn's end to the next turn's start is a gap
 * (the user or something outside ADE); a step that skips a missing checkpoint is unknown.
 */
export function checkpointChain(baseCommit: string, turns: readonly TraceTurn[], current: string, undone: ReadonlySet<number> = new Set()): ChainPoint[] {
  const live = turns.filter((t) => !undone.has(t.index)).sort((a, b) => a.index - b.index);
  const points: ChainPoint[] = [{ commit: baseCommit, via: { kind: 'unknown' } }];
  // What the last point is: the base or a turn's end (then the next step is a gap) or a turn's start.
  let at: { kind: 'end' } | { kind: 'start'; turnIndex: number } | { kind: 'broken' } = { kind: 'end' };
  for (const t of live) {
    if (t.startCheckpoint) {
      points.push({ commit: t.startCheckpoint, via: at.kind === 'end' ? { kind: 'gap' } : { kind: 'unknown' } });
      at = { kind: 'start', turnIndex: t.index };
    } else at = { kind: 'broken' };
    if (t.endCheckpoint) {
      points.push({ commit: t.endCheckpoint, via: at.kind === 'start' && at.turnIndex === t.index ? { kind: 'agent', turnIndex: t.index } : { kind: 'unknown' } });
      at = { kind: 'end' };
    } else if (t.endedAt) at = { kind: 'broken' };
  }
  const last = live.at(-1);
  // A running turn has no end checkpoint yet: what changed since its start is its own work so far.
  const running = !!last && !last.endedAt && at.kind === 'start' && at.turnIndex === last.index;
  points.push({ commit: current, via: running ? { kind: 'agent', turnIndex: last.index } : at.kind === 'end' ? { kind: 'gap' } : { kind: 'unknown' } });
  return points;
}

/** A gap step is the user's when they edited the file in ADE (RV-06); otherwise ADE cannot say who changed it. */
export function resolveVia(via: ChainPoint['via'], editedByUser: boolean): Transition {
  if (via.kind === 'gap') return editedByUser ? { kind: 'user' } : { kind: 'unknown' };
  return via;
}

// ------------------------------------------------------------------------------------------------ events

export interface EditReport {
  toolCallId: string;
  /** Path relative to the worktree with forward slashes. */
  path: string;
  oldText: string | null;
  newText: string;
  /** Order of the report in the session (the tool call's last content). */
  seq: number;
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolStatus;
  seq: number;
}

export interface TurnEvents {
  index: number;
  turnId: string;
  startedAt: string;
  /** The text of the prompt that started the turn. */
  prompt: string;
  events: SessionEvent[];
}

/** The session's events cut into turns: the prompt before `turn.started`, then everything up to `turn.ended`. */
export function turnsOf(events: readonly SessionEvent[]): TurnEvents[] {
  const out: TurnEvents[] = [];
  let lastPrompt = '';
  let cur: TurnEvents | null = null;
  for (const e of events) {
    if (e.type === 'user.message' && !cur) {
      lastPrompt = e.content.map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? `[${b.name}]` : '[image]')).join('\n');
      continue;
    }
    if (e.type === 'turn.started') {
      cur = { index: e.index, turnId: e.turnId, startedAt: e.ts, prompt: lastPrompt, events: [] };
      out.push(cur);
      lastPrompt = '';
      continue;
    }
    if (!cur) continue;
    if (e.type === 'turn.ended' && e.turnId === cur.turnId) {
      cur = null;
      continue;
    }
    cur.events.push(e);
  }
  return out;
}

/** Tool calls of a turn with their latest title, status and content. */
export function toolCallsOf(events: readonly SessionEvent[]): (ToolCallInfo & { content: ToolContent[] })[] {
  const calls = new Map<string, ToolCallInfo & { content: ToolContent[] }>();
  for (const e of events) {
    if (e.type === 'tool.call') {
      calls.set(e.toolCallId, { toolCallId: e.toolCallId, title: e.title, kind: e.kind, status: e.status, seq: e.seq, content: e.content });
    } else if (e.type === 'tool.update') {
      const c = calls.get(e.toolCallId);
      if (!c) continue;
      calls.set(e.toolCallId, {
        ...c,
        title: e.title ?? c.title,
        status: e.status ?? c.status,
        content: e.content ?? c.content,
        seq: e.content ? e.seq : c.seq,
      });
    }
  }
  return [...calls.values()];
}

/** Every diff a turn's tool calls reported, with paths made relative to the worktree (`roots`). */
export function editReports(events: readonly SessionEvent[], roots: readonly string[]): EditReport[] {
  const out: EditReport[] = [];
  for (const c of toolCallsOf(events)) {
    for (const item of c.content) {
      if (item.type !== 'diff') continue;
      const path = repoPath(item.path, [...roots]);
      if (path !== null) out.push({ toolCallId: c.toolCallId, path, oldText: item.oldText, newText: item.newText, seq: c.seq });
    }
  }
  return out;
}

const countIn = (text: string | null, line: string) => {
  if (!text) return 0;
  let n = 0;
  for (const l of text.split('\n')) if (l.trim() === line) n++;
  return n;
};

/**
 * The tool call that wrote (`new`) or removed (`old`) a line, newest first: the first report for the path whose
 * new text has the line more often than its old text (old side: the reverse). Lines compare without surrounding
 * whitespace and `\r`, so fragments without indentation, whole files and CRLF all match. A line without a letter or
 * digit (a brace, a blank line) is common, so it falls back to the newest report that contains it at all.
 */
export function matchToolCall(text: string, side: 'new' | 'old', reports: readonly EditReport[], path: string): string | null {
  const line = text.trim();
  const mine = reports.filter((r) => r.path === path).sort((a, b) => b.seq - a.seq);
  const [has, lacks] = side === 'new' ? (['newText', 'oldText'] as const) : (['oldText', 'newText'] as const);
  for (const r of mine) if (countIn(r[has], line) > countIn(r[lacks], line)) return r.toolCallId;
  if (!/[\p{L}\p{N}]/u.test(line)) for (const r of mine) if (countIn(r[has], line) > 0) return r.toolCallId;
  return null;
}

// ------------------------------------------------------------------------------------------------ result shapes

export type TraceKind = 'agent' | 'user' | 'unreported' | 'unknown';

export interface LineOrigin {
  line: number;
  side: 'new' | 'old';
  turnIndex: number | null;
  toolCallId: string | null;
  kind: TraceKind;
}

/** Each traced line with its tool call: agent when a reported edit explains it, unreported when none does. */
export function lineOrigins(file: TracedFile, path: string, reportsByTurn: ReadonlyMap<number, readonly EditReport[]>): LineOrigin[] {
  return file.lines.map((l) => {
    const base = { line: l.line, side: l.side };
    if (l.origin.kind === 'user') return { ...base, turnIndex: null, toolCallId: null, kind: 'user' };
    if (l.origin.kind === 'unknown') return { ...base, turnIndex: null, toolCallId: null, kind: 'unknown' };
    const toolCallId = matchToolCall(l.text, l.side, reportsByTurn.get(l.origin.turnIndex) ?? [], path);
    return { ...base, turnIndex: l.origin.turnIndex, toolCallId, kind: toolCallId ? 'agent' : 'unreported' };
  });
}

export interface PromptHunk {
  path: string;
  /** 1-based first line, on the new side when the piece adds lines, otherwise on the old side. */
  line: number;
  side: 'new' | 'old';
  additions: number;
  deletions: number;
}

export interface PromptGroup {
  /** `turn` groups lines a reported edit of that turn explains. */
  kind: 'turn' | 'unreported' | 'user' | 'unknown';
  turnIndex: number | null;
  prompt: string | null;
  additions: number;
  deletions: number;
  hunks: PromptHunk[];
}

const groupKey = (o: LineOrigin) => (o.kind === 'agent' ? `t${o.turnIndex}` : o.kind);

/**
 * "By prompt": every hunk of every file under the group of its lines. A hunk whose lines come from several groups
 * is split into one piece per group, so each line is counted once and the totals equal the Files view.
 */
export function groupByPrompt(files: readonly { path: string; file: TracedFile; origins: readonly LineOrigin[] }[], prompts: ReadonlyMap<number, string>): PromptGroup[] {
  const groups = new Map<string, PromptGroup>();
  for (const { path, file, origins } of files) {
    for (const hunk of file.hunks) {
      const pieces = new Map<string, PromptHunk & { o: LineOrigin }>();
      for (const i of hunk.lines) {
        const o = origins[i]!;
        const key = groupKey(o);
        let p = pieces.get(key);
        if (!p) pieces.set(key, (p = { path, line: 0, side: 'old', additions: 0, deletions: 0, o }));
        if (o.side === 'new') {
          if (!p.additions) p.line = o.line;
          p.side = 'new';
          p.additions++;
        } else {
          if (!p.deletions && !p.additions) p.line = o.line;
          p.deletions++;
        }
      }
      for (const [key, { o, ...piece }] of pieces) {
        let g = groups.get(key);
        if (!g) {
          const kind = o.kind === 'agent' ? 'turn' : o.kind;
          const turnIndex = o.kind === 'agent' ? o.turnIndex : null;
          groups.set(key, (g = { kind, turnIndex, prompt: turnIndex === null ? null : (prompts.get(turnIndex) ?? null), additions: 0, deletions: 0, hunks: [] }));
        }
        g.hunks.push(piece);
        g.additions += piece.additions;
        g.deletions += piece.deletions;
      }
    }
  }
  const rank = { turn: 0, unreported: 1, user: 2, unknown: 3 } as const;
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
}

// ------------------------------------------------------------------------------------------------ detail

export interface TraceDetail {
  turnIndex: number;
  startedAt: string | null;
  prompt: string | null;
  toolCall: { toolCallId: string; title: string; kind: ToolKind; status: ToolStatus } | null;
  /** The agent's last message or thought before the tool call (or in the turn, without one). */
  preceding: { kind: 'message' | 'thought'; text: string } | null;
  /** The tool call's own approval, or approvals earlier in the turn. */
  permissions: { title: string; decision: string; decidedBy: string; forToolCall: boolean }[];
  /** Commands the turn ran: ADE-run commands and the agent's own execute tool calls. */
  commands: string[];
}

/** Who decided a permission, in words (the same words as the timeline). */
export function deciderLabel(decidedBy: string): string {
  if (decidedBy === 'user') return 'you';
  if (decidedBy.startsWith('profile:')) return `the ${decidedBy.slice(8)} profile`;
  if (decidedBy.startsWith('rule:')) return 'a workspace rule';
  return 'ADE automatically';
}

const PROMPT_MAX = 20_000;
const TEXT_MAX = 4_000;

export function traceDetail(events: readonly SessionEvent[], turnIndex: number, toolCallId: string | null): TraceDetail {
  const turn = turnsOf(events).find((t) => t.index === turnIndex);
  if (!turn) return { turnIndex, startedAt: null, prompt: null, toolCall: null, preceding: null, permissions: [], commands: [] };
  const calls = toolCallsOf(turn.events);
  const call = toolCallId ? (calls.find((c) => c.toolCallId === toolCallId) ?? null) : null;
  const callAt = call ? turn.events.findIndex((e) => e.type === 'tool.call' && e.toolCallId === call.toolCallId) : turn.events.length;
  let preceding: TraceDetail['preceding'] = null;
  for (let i = callAt - 1; i >= 0 && !preceding; i--) {
    const e = turn.events[i]!;
    if ((e.type === 'agent.message' || e.type === 'agent.thought') && e.text.trim()) {
      preceding = { kind: e.type === 'agent.message' ? 'message' : 'thought', text: e.text.trim().slice(0, TEXT_MAX) };
    }
  }
  const requests = turn.events.flatMap((e, i) => (e.type === 'permission.requested' ? [{ e, i }] : []));
  const describe = (e: Extract<SessionEvent, { type: 'permission.requested' }>, forToolCall: boolean) => {
    const decided = turn.events.find((d): d is Extract<SessionEvent, { type: 'permission.decided' }> => d.type === 'permission.decided' && d.requestId === e.requestId);
    const decision = !decided ? 'Not decided' : decided.decision.outcome === 'cancelled' ? 'Cancelled' : (e.options.find((o) => o.optionId === (decided.decision as { optionId: string }).optionId)?.name ?? 'Answered');
    return { title: e.title, decision, decidedBy: decided ? deciderLabel(decided.decidedBy) : 'nobody yet', forToolCall };
  };
  const own = call ? requests.filter((r) => r.e.toolCallId === call.toolCallId) : [];
  const permissions = own.length ? own.map((r) => describe(r.e, true)) : requests.filter((r) => r.i < callAt).map((r) => describe(r.e, false));
  const commands: string[] = [];
  for (const c of calls) if (c.kind === 'execute') commands.push(`${c.title} (${c.status.replace('_', ' ')})`);
  for (const e of turn.events) {
    if (e.type === 'command.started' && !calls.some((c) => c.kind === 'execute' && c.title.includes(e.command))) commands.push(e.command);
  }
  return {
    turnIndex,
    startedAt: turn.startedAt,
    prompt: turn.prompt.slice(0, PROMPT_MAX),
    toolCall: call ? { toolCallId: call.toolCallId, title: call.title, kind: call.kind, status: call.status } : null,
    preceding,
    permissions: permissions.slice(0, 10),
    commands: commands.slice(0, 20),
  };
}

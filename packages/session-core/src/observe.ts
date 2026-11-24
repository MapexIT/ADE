import type { SessionEvent, ToolKind, Usage } from '@ade/contracts';
import { loopTitle, type LoopFinding } from './loops.ts';

/**
 * WA-07: live observability of an agent session, derived from its event stream. Pure and agent-neutral:
 * everything here comes from ACP events ADE already records, so it works the same for every agent.
 */

/** What the agent is doing right now. */
export type ActivityPhase =
  'starting' | 'working' | 'thinking' | 'writing' | 'tool' | 'command' | 'waiting' | 'idle' | 'stopped';

export interface PhaseSegment {
  phase: ActivityPhase;
  /** Milliseconds since the epoch. */
  start: number;
  end: number | null;
}

export type FeedKind =
  | 'you'
  | 'message'
  | 'tool'
  | 'tool-failed'
  | 'command'
  | 'command-failed'
  | 'approval'
  | 'plan'
  | 'turn'
  | 'state'
  | 'notice'
  | 'loop';

export interface FeedEntry {
  id: number;
  at: number;
  kind: FeedKind;
  text: string;
}

export interface Activity {
  startedAt: number | null;
  lastEventAt: number | null;
  phase: ActivityPhase;
  /** When the current phase began. */
  phaseSince: number | null;
  /** A short line saying what is happening now, e.g. "Editing src/app.ts" or "Running npm test". */
  now: string | null;
  counts: {
    events: number;
    messages: number;
    thoughts: number;
    toolCalls: number;
    toolsFailed: number;
    edits: number;
    reads: number;
    searches: number;
    commands: number;
    commandsFailed: number;
    approvals: number;
    /** WA-10: loop warnings (warning level) in this session. */
    loops: number;
  };
  /** Files the agent read or changed, with how often. */
  files: Record<string, { reads: number; edits: number }>;
  segments: PhaseSegment[];
  /** Event times (ms) for the activity rate; the most recent RATE_WINDOW_MS are kept. */
  times: number[];
  plan: { done: number; total: number };
  usage: Usage | null;
  turns: number;
  /** Set when a turn ends; cleared when the next starts. */
  outcome: { stopReason: string; at: number; durationMs: number | null } | null;
  lastMessage: string | null;
  /** WA-10: the latest loop warning of the running turn, until the turn ends or the user dismisses it. */
  loop: (LoopFinding & { since: number }) | null;
  feed: FeedEntry[];
  /** Internal: open tool calls and commands, so the phase falls back correctly when one finishes. */
  open: { tools: Record<string, { title: string; kind: ToolKind }>; commands: Record<string, string> };
  /** Internal: paths already counted per tool call, so an update carrying the same diff is not counted twice. */
  toolPaths: Record<string, string[]>;
  turnStartedAt: number | null;
  nextFeedId: number;
}

export const RATE_WINDOW_MS = 120_000;
const MAX_SEGMENTS = 400;
const MAX_FEED = 80;

export const emptyActivity = (): Activity => ({
  startedAt: null,
  lastEventAt: null,
  phase: 'starting',
  phaseSince: null,
  now: null,
  counts: {
    events: 0,
    messages: 0,
    thoughts: 0,
    toolCalls: 0,
    toolsFailed: 0,
    edits: 0,
    reads: 0,
    searches: 0,
    commands: 0,
    commandsFailed: 0,
    approvals: 0,
    loops: 0,
  },
  files: {},
  segments: [],
  times: [],
  plan: { done: 0, total: 0 },
  usage: null,
  turns: 0,
  outcome: null,
  lastMessage: null,
  loop: null,
  feed: [],
  open: { tools: {}, commands: {} },
  toolPaths: {},
  turnStartedAt: null,
  nextFeedId: 1,
});

const VERB: Partial<Record<ToolKind, string>> = {
  read: 'Reading',
  edit: 'Editing',
  delete: 'Deleting',
  move: 'Moving',
  search: 'Searching',
  execute: 'Running',
  think: 'Thinking',
  fetch: 'Fetching',
};

const excerpt = (text: string, max = 120) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function setPhase(a: Activity, phase: ActivityPhase, at: number) {
  if (a.phase === phase && a.segments.length) return;
  const last = a.segments[a.segments.length - 1];
  if (last && last.end === null) last.end = at;
  a.segments.push({ phase, start: at, end: null });
  if (a.segments.length > MAX_SEGMENTS) a.segments.splice(0, a.segments.length - MAX_SEGMENTS);
  a.phase = phase;
  a.phaseSince = at;
}

/** After a tool or command finishes, fall back to whatever is still open, or to plain working. */
function settle(a: Activity, at: number) {
  const command = Object.values(a.open.commands).at(-1);
  if (command) {
    setPhase(a, 'command', at);
    a.now = `Running ${command}`;
    return;
  }
  const tool = Object.values(a.open.tools).at(-1);
  if (tool) {
    setPhase(a, 'tool', at);
    a.now = tool.title;
    return;
  }
  setPhase(a, 'working', at);
  a.now = 'Working';
}

function feed(a: Activity, at: number, kind: FeedKind, text: string) {
  a.feed.push({ id: a.nextFeedId++, at, kind, text });
  if (a.feed.length > MAX_FEED) a.feed.splice(0, a.feed.length - MAX_FEED);
}

function touch(a: Activity, paths: string[], kind: ToolKind) {
  for (const p of paths) {
    const f = (a.files[p] ??= { reads: 0, edits: 0 });
    if (kind === 'read') f.reads++;
    else if (kind === 'edit' || kind === 'delete' || kind === 'move') f.edits++;
  }
}

/**
 * Folds one event into the activity. Returns a new object (the input is not changed), so it can sit in a
 * React store. Transient events (chunks, command output) count towards the phase and rate but not the feed.
 */
export function applyActivity(prev: Activity, e: SessionEvent): Activity {
  const a: Activity = structuredClone(prev);
  const at = Date.parse(e.ts) || Date.now();
  a.startedAt ??= at;
  a.lastEventAt = at;
  a.counts.events++;
  a.times.push(at);
  const cutoff = at - RATE_WINDOW_MS;
  while (a.times.length && a.times[0]! < cutoff) a.times.shift();

  switch (e.type) {
    case 'user.message': {
      const text = e.content
        .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? `[${b.name}]` : '[image]'))
        .join(' ');
      feed(a, at, 'you', excerpt(text));
      break;
    }
    case 'turn.started':
      a.turns = Math.max(a.turns, e.index + 1);
      a.turnStartedAt = at;
      a.outcome = null;
      a.loop = null;
      setPhase(a, 'working', at);
      a.now = 'Working';
      feed(a, at, 'turn', `Turn ${e.index + 1} started`);
      break;
    case 'turn.ended':
      if (e.usage) a.usage = e.usage;
      a.outcome = {
        stopReason: e.stopReason,
        at,
        durationMs: a.turnStartedAt === null ? null : at - a.turnStartedAt,
      };
      a.open = { tools: {}, commands: {} };
      a.loop = null;
      setPhase(a, 'idle', at);
      a.now = null;
      feed(a, at, 'turn', `Turn finished (${e.stopReason.replace(/_/g, ' ')})`);
      break;
    case 'agent.thought.chunk':
    case 'agent.thought':
      if (e.type === 'agent.thought') a.counts.thoughts++;
      if (a.phase !== 'tool' && a.phase !== 'command' && a.phase !== 'waiting') {
        setPhase(a, 'thinking', at);
        a.now = 'Thinking';
      }
      break;
    case 'agent.message.chunk':
    case 'agent.message':
      if (e.type === 'agent.message') {
        a.counts.messages++;
        a.lastMessage = e.text;
        feed(a, at, 'message', excerpt(e.text));
      }
      if (a.phase !== 'tool' && a.phase !== 'command' && a.phase !== 'waiting') {
        setPhase(a, 'writing', at);
        a.now = 'Writing a reply';
      }
      break;
    case 'tool.call': {
      a.counts.toolCalls++;
      if (e.kind === 'read') a.counts.reads++;
      else if (e.kind === 'edit' || e.kind === 'delete' || e.kind === 'move') a.counts.edits++;
      else if (e.kind === 'search') a.counts.searches++;
      const diffPaths = e.content.flatMap((c) => (c.type === 'diff' ? [c.path] : []));
      const paths = [...new Set([...e.locations, ...diffPaths])];
      touch(a, paths, e.kind);
      a.toolPaths[e.toolCallId] = paths;
      const ids = Object.keys(a.toolPaths);
      if (ids.length > 200) delete a.toolPaths[ids[0]!];
      const where = e.locations[0] ?? diffPaths[0];
      const title = VERB[e.kind] && where ? `${VERB[e.kind]} ${fileName(where)}` : e.title;
      if (e.status === 'pending' || e.status === 'in_progress') {
        a.open.tools[e.toolCallId] = { title, kind: e.kind };
        setPhase(a, 'tool', at);
        a.now = title;
      } else if (e.status === 'failed') a.counts.toolsFailed++;
      feed(a, at, e.status === 'failed' ? 'tool-failed' : 'tool', e.title);
      break;
    }
    case 'tool.update': {
      const diffPaths = (e.content ?? []).flatMap((c) => (c.type === 'diff' ? [c.path] : []));
      const open = a.open.tools[e.toolCallId];
      const seen = (a.toolPaths[e.toolCallId] ??= []);
      const fresh = diffPaths.filter((p) => !seen.includes(p));
      if (fresh.length) {
        touch(a, fresh, open?.kind ?? 'edit');
        seen.push(...fresh);
      }
      if (e.status === 'completed' || e.status === 'failed') {
        delete a.open.tools[e.toolCallId];
        if (e.status === 'failed') {
          a.counts.toolsFailed++;
          feed(a, at, 'tool-failed', `Failed: ${e.title ?? open?.title ?? 'tool call'}`);
        }
        if (a.phase === 'tool') settle(a, at);
      } else if (e.status === 'in_progress' && open) {
        setPhase(a, 'tool', at);
        a.now = open.title;
      }
      break;
    }
    case 'command.started':
      a.counts.commands++;
      a.open.commands[e.terminalId] = excerpt(e.command, 60);
      setPhase(a, 'command', at);
      a.now = `Running ${excerpt(e.command, 60)}`;
      feed(a, at, 'command', `$ ${excerpt(e.command, 100)}`);
      break;
    case 'command.output':
      break;
    case 'command.exited': {
      const cmd = a.open.commands[e.terminalId] ?? 'command';
      delete a.open.commands[e.terminalId];
      const failed = e.killed || (e.exitCode !== null && e.exitCode !== 0);
      if (failed) a.counts.commandsFailed++;
      feed(
        a,
        at,
        failed ? 'command-failed' : 'command',
        `${cmd} ${e.killed ? 'was stopped' : `exited ${e.exitCode ?? e.signal ?? '?'}`}`,
      );
      if (a.phase === 'command') settle(a, at);
      break;
    }
    case 'permission.requested':
      a.counts.approvals++;
      setPhase(a, 'waiting', at);
      a.now = `Waiting for you: ${excerpt(e.title, 80)}`;
      feed(a, at, 'approval', `Asks: ${excerpt(e.title, 100)}`);
      break;
    case 'permission.decided':
      feed(
        a,
        at,
        'approval',
        `${e.decision.outcome === 'selected' ? 'Answered' : 'Cancelled'} by ${e.decidedBy}`,
      );
      if (a.phase === 'waiting') settle(a, at);
      break;
    case 'plan.updated': {
      const done = e.entries.filter((p) => p.status === 'completed').length;
      a.plan = { done, total: e.entries.length };
      feed(a, at, 'plan', `Plan: ${done} of ${e.entries.length} done`);
      break;
    }
    case 'session.state_changed':
      if (e.to === 'waiting-on-user') {
        setPhase(a, 'waiting', at);
        a.now ??= 'Waiting for you';
      } else if (e.to === 'ready') {
        setPhase(a, 'idle', at);
        a.now = null;
        a.loop = null;
      } else if (e.to === 'interrupted' || e.to === 'landed' || e.to === 'discarded') {
        a.loop = null;
        setPhase(a, 'stopped', at);
        a.now = null;
        feed(a, at, 'state', `Session ${e.to.replace(/-/g, ' ')}`);
      } else if (
        e.to === 'working' &&
        (a.phase === 'starting' || a.phase === 'idle' || a.phase === 'waiting')
      ) {
        setPhase(a, 'working', at);
        a.now = 'Working';
      }
      break;
    case 'notice':
      feed(a, at, 'notice', excerpt(e.text));
      break;
    case 'loop.detected':
      a.loop = {
        pattern: e.pattern,
        subject: e.subject,
        count: e.count,
        level: e.level,
        detail: e.detail,
        since: a.loop?.since ?? at,
      };
      if (e.level === 'warning') a.counts.loops++;
      feed(a, at, 'loop', excerpt(loopTitle(e)));
      break;
    case 'loop.dismissed':
      a.loop = null;
      feed(a, at, 'loop', 'Loop warning dismissed');
      break;
    default:
      break;
  }
  return a;
}

export const activityFrom = (events: SessionEvent[]): Activity =>
  events.reduce(applyActivity, emptyActivity());

/** Events per bucket over the last `windowMs`, oldest first, for a sparkline that keeps moving with time. */
export function rateBuckets(times: number[], now: number, buckets = 24, windowMs = RATE_WINDOW_MS): number[] {
  const size = windowMs / buckets;
  const out = new Array<number>(buckets).fill(0);
  for (const t of times) {
    const age = now - t;
    if (age < 0 || age >= windowMs) continue;
    out[buckets - 1 - Math.floor(age / size)]!++;
  }
  return out;
}

/** Time spent per phase, closing an open segment at `now`. */
export function phaseTotals(segments: PhaseSegment[], now: number): Partial<Record<ActivityPhase, number>> {
  const totals: Partial<Record<ActivityPhase, number>> = {};
  for (const s of segments) totals[s.phase] = (totals[s.phase] ?? 0) + Math.max(0, (s.end ?? now) - s.start);
  return totals;
}

/** True while the agent is doing something (not idle, waiting or stopped). */
export const isBusy = (phase: ActivityPhase) =>
  phase !== 'idle' && phase !== 'stopped' && phase !== 'waiting';

import type { WatchReason, WatchRule } from '@ade/contracts';
import { stripAnsi } from './parser.ts';

/**
 * SM-19: watching a command. A pure reducer over the output of one smart terminal, fed by the pty process (which sees
 * output while a command runs, even when no window shows the terminal). It decides when a watch fires; it never
 * touches a timer or a pty. `nextWakeAt` says when the caller should send the next `timer` event.
 */

export type WatchEvent =
  /** A command block opened (OSC 133;C): matching starts here, so the typed command line never matches. */
  | { type: 'start'; blockId: string; command: string; at: number }
  /** Raw output of the running command (shell-integration sequences already removed). */
  | { type: 'output'; text: string; at: number }
  | { type: 'end'; exitCode: number | null; at: number }
  | { type: 'timer'; at: number }
  | { type: 'resize'; at: number }
  | { type: 'altScreen'; on: boolean; at: number }
  /** A watch set, replaced or (null) stopped. */
  | { type: 'set'; rule: WatchRule | null; at: number };

export interface WatchFire {
  reason: WatchReason;
  blockId: string;
  command: string;
  exitCode: number | null;
  line: string | null;
  quietSeconds: number | null;
  auto: boolean;
}

export interface WatchState {
  rule: WatchRule | null;
  running: boolean;
  blockId: string | null;
  command: string;
  /** The unfinished last line, ANSI removed. */
  partial: string;
  /** An escape sequence cut at the end of the last chunk. */
  pendingEsc: string;
  lastOutputAt: number;
  resizedAt: number;
  altScreen: boolean;
  quietFired: number;
  /** Output resumed since the last quiet fire. */
  resumed: boolean;
  matched: boolean;
  /** The unfinished line was already tested, so the 300 ms check runs once per pause. */
  partialTested: boolean;
}

/** A quiet watch fires at most this many times per command. */
export const MAX_QUIET_FIRES = 3;
/** Output this soon after a resize is ConPTY repainting the screen, not the command speaking. */
export const RESIZE_SETTLE_MS = 250;
/** An unfinished last line (a `Password:` prompt has no newline) is tested after this pause. */
export const PARTIAL_LINE_MS = 300;
const MAX_PARTIAL = 4000;

export function initialWatch(): WatchState {
  return {
    rule: null,
    running: false,
    blockId: null,
    command: '',
    partial: '',
    pendingEsc: '',
    lastOutputAt: 0,
    resizedAt: Number.NEGATIVE_INFINITY,
    altScreen: false,
    quietFired: 0,
    resumed: false,
    matched: false,
    partialTested: false,
  };
}

// eslint-disable-next-line no-control-regex
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)([hl])/g;
// eslint-disable-next-line no-control-regex
const CUT_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
// eslint-disable-next-line no-control-regex
const PRINTABLE = /[^\s\x00-\x1f\x7f]/;

/** The last alternate-screen switch in a chunk, if any. */
function altScreenSwitch(text: string): boolean | null {
  let on: boolean | null = null;
  for (const m of text.matchAll(ALT_SCREEN)) on = m[1] === 'h';
  return on;
}

/** A line as the user saw it: the text after the last carriage return (progress bars redraw in place). */
function visibleLine(line: string): string {
  const parts = line.split('\r').filter((p) => p !== '');
  return parts[parts.length - 1] ?? '';
}

function fire(state: WatchState, reason: WatchReason, extra: { exitCode?: number | null; line?: string | null } = {}): WatchFire {
  return {
    reason,
    blockId: state.blockId ?? '',
    command: state.command.slice(0, 500),
    exitCode: extra.exitCode ?? null,
    line: extra.line != null ? extra.line.trim().slice(0, 300) : null,
    quietSeconds: reason === 'quiet' ? (state.rule?.quietSeconds ?? null) : null,
    auto: state.rule?.auto ?? false,
  };
}

const lineMatches = (rule: WatchRule | null, line: string) => !!rule?.match && line.toLowerCase().includes(rule.match.toLowerCase());

/** One step: the next state and what fired (usually nothing). */
export function watchStep(state: WatchState, event: WatchEvent): { state: WatchState; fired: WatchFire[] } {
  const fired: WatchFire[] = [];
  switch (event.type) {
    case 'set': {
      // A watch set while a command runs applies to it, counting silence from now; otherwise it waits for the next.
      const next: WatchState = { ...state, rule: event.rule };
      if (event.rule && state.running) {
        next.lastOutputAt = event.at;
        next.quietFired = 0;
        next.resumed = false;
        next.matched = false;
        next.partialTested = false;
      }
      return { state: next, fired };
    }
    case 'start':
      return {
        state: {
          ...state,
          running: true,
          blockId: event.blockId,
          command: event.command,
          partial: '',
          pendingEsc: '',
          lastOutputAt: event.at,
          altScreen: false,
          quietFired: 0,
          resumed: false,
          matched: false,
          partialTested: false,
        },
        fired,
      };
    case 'resize':
      return { state: { ...state, resizedAt: event.at }, fired };
    case 'altScreen':
      return { state: { ...state, altScreen: event.on, lastOutputAt: event.on ? state.lastOutputAt : event.at }, fired };
    case 'output': {
      if (!state.running) return { state, fired };
      const next: WatchState = { ...state };
      const raw = state.pendingEsc + event.text;
      const tail = CUT_ESCAPE.exec(raw);
      const cut = tail && tail[0].length <= 256 ? tail : null;
      next.pendingEsc = cut ? cut[0] : '';
      const complete = cut ? raw.slice(0, cut.index) : raw;
      const alt = altScreenSwitch(complete);
      if (alt !== null) {
        next.altScreen = alt;
        if (!alt) next.lastOutputAt = event.at;
      }
      const text = stripAnsi(complete);
      // ConPTY repaints after a resize with cursor moves and the same text; neither counts as the command speaking.
      if (!PRINTABLE.test(text) || event.at - state.resizedAt < RESIZE_SETTLE_MS) return { state: next, fired };
      next.lastOutputAt = event.at;
      next.partialTested = false;
      if (state.quietFired > 0) next.resumed = true;
      const lines = (state.partial + text).split('\n');
      next.partial = (lines.pop() ?? '').slice(-MAX_PARTIAL);
      if (state.rule?.match && !state.matched) {
        const hit = lines.map(visibleLine).find((l) => lineMatches(state.rule, l));
        if (hit !== undefined) {
          next.matched = true;
          fired.push(fire(state, 'matched', { line: hit }));
        }
      }
      return { state: next, fired };
    }
    case 'timer': {
      if (!state.running || !state.rule) return { state, fired };
      const next: WatchState = { ...state };
      const rule = state.rule;
      if (rule.match && !state.matched && !state.partialTested && state.partial && event.at - state.lastOutputAt >= PARTIAL_LINE_MS) {
        next.partialTested = true;
        const line = visibleLine(state.partial);
        if (lineMatches(rule, line)) {
          next.matched = true;
          fired.push(fire(state, 'matched', { line }));
        }
      }
      if (quietDue(state, event.at)) {
        next.quietFired = state.quietFired + 1;
        next.resumed = false;
        fired.push(fire(state, 'quiet'));
      }
      return { state: next, fired };
    }
    case 'end': {
      if (!state.running) return { state, fired };
      const rule = state.rule;
      if (rule?.match && !state.matched && state.partial && lineMatches(rule, visibleLine(state.partial))) {
        fired.push(fire(state, 'matched', { line: visibleLine(state.partial) }));
      }
      const failed = event.exitCode !== null && event.exitCode !== 0;
      if (rule && (rule.end === 'any' || (rule.end === 'fail' && failed))) fired.push(fire(state, failed ? 'failed' : 'finished', { exitCode: event.exitCode }));
      // A watch belongs to one command: it ends with it.
      return { state: { ...state, running: false, rule: null, partial: '', pendingEsc: '' }, fired };
    }
  }
}

function quietDue(state: WatchState, at: number): boolean {
  const seconds = state.rule?.quietSeconds;
  if (!seconds || !state.running || state.altScreen) return false;
  if (state.quietFired >= MAX_QUIET_FIRES || (state.quietFired > 0 && !state.resumed)) return false;
  return at - state.lastOutputAt >= seconds * 1000;
}

/** When the caller should send the next `timer` event, or null when no timer is needed. */
export function nextWakeAt(state: WatchState): number | null {
  if (!state.running || !state.rule) return null;
  const times: number[] = [];
  if (state.rule.match && !state.matched && !state.partialTested && state.partial) times.push(state.lastOutputAt + PARTIAL_LINE_MS);
  const seconds = state.rule.quietSeconds;
  if (seconds && !state.altScreen && state.quietFired < MAX_QUIET_FIRES && (state.quietFired === 0 || state.resumed)) times.push(state.lastOutputAt + seconds * 1000);
  return times.length ? Math.min(...times) : null;
}

/** The reason in words, as the terminal list and the inbox show it. */
export function watchReasonText(f: Pick<WatchFire, 'reason' | 'exitCode' | 'line' | 'quietSeconds'>): string {
  switch (f.reason) {
    case 'finished':
      return `Finished · exit ${f.exitCode ?? 'unknown'}`;
    case 'failed':
      return `Failed · exit ${f.exitCode ?? 'unknown'}`;
    case 'quiet':
      return `Quiet for ${f.quietSeconds ?? '?'} s · may be waiting for you`;
    case 'matched':
      return `Printed: ${(f.line ?? '').slice(0, 120)}`;
  }
}

/** The reason without any output, for an operating-system notification (nothing printed reaches a lock screen). */
export function watchNotificationText(f: Pick<WatchFire, 'reason' | 'exitCode' | 'quietSeconds'>): string {
  switch (f.reason) {
    case 'finished':
      return `Finished with exit code ${f.exitCode ?? 'unknown'}.`;
    case 'failed':
      return `Failed with exit code ${f.exitCode ?? 'unknown'}.`;
    case 'quiet':
      return `Printed nothing for ${f.quietSeconds ?? '?'} seconds. It may be waiting for you.`;
    case 'matched':
      return 'Printed the text you were watching for.';
  }
}

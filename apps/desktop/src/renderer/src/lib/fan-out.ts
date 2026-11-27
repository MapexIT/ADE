import type { AgentId, CommandBlock } from '@ade/contracts';
import { destructiveReason, isMultiLinePaste } from './terminal-intel.ts';

/**
 * SM-21: running one finished command in other worktrees and comparing the outcomes. Pure: no DOM, no IPC,
 * unit-tested. `comparisons.ts` does the opening, typing and following.
 */

export const FAN_OUT_LIMIT = 6;

export interface FanOutTarget {
  key: string;
  label: string;
  agentId: AgentId | null;
  branch: string | null;
  cwd: string;
  sessionId: string | null;
  /** The worktree the block ran in: listed, never ticked. */
  ranHere: boolean;
  defaultTicked: boolean;
}

interface SessionLike {
  id: string;
  workspaceId: string;
  title: string;
  agentId: AgentId;
  branch: string | null;
  state: string;
  worktreePath: string | null;
  inPlace?: boolean;
  createdAt: string;
}

const live = (s: SessionLike) => !!s.worktreePath && !s.inPlace && s.state !== 'landed' && s.state !== 'discarded';

/**
 * The worktrees a command can run in: the origin first ("Ran here"), then every session of the workspace with a live
 * worktree (newest first, the first six ticked), then the user's checkout, unticked.
 */
export function planFanOut(sessions: SessionLike[], workspace: { id: string; rootPath: string }, origin: { sessionId: string | null }, limit = FAN_OUT_LIMIT): FanOutTarget[] {
  const list = sessions.filter((s) => s.workspaceId === workspace.id && live(s)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out: FanOutTarget[] = [];
  const originSession = origin.sessionId ? list.find((s) => s.id === origin.sessionId) : undefined;
  const checkout: FanOutTarget = { key: 'checkout', label: 'Your checkout', agentId: null, branch: null, cwd: workspace.rootPath, sessionId: null, ranHere: origin.sessionId === null, defaultTicked: false };
  if (originSession) out.push({ key: originSession.id, label: originSession.title, agentId: originSession.agentId, branch: originSession.branch, cwd: originSession.worktreePath!, sessionId: originSession.id, ranHere: true, defaultTicked: false });
  else if (origin.sessionId === null) out.push(checkout);
  let ticked = 0;
  for (const s of list) {
    if (s.id === origin.sessionId) continue;
    const tick = ticked < limit;
    if (tick) ticked++;
    out.push({ key: s.id, label: s.title, agentId: s.agentId, branch: s.branch, cwd: s.worktreePath!, sessionId: s.id, ranHere: false, defaultTicked: tick });
  }
  if (origin.sessionId !== null) out.push(checkout);
  return out;
}

/** Why a command is not offered for other worktrees, or null when it is. */
export function fanOutRefusal(command: string): string | null {
  if (destructiveReason(command)) return 'This command deletes or overwrites things, so ADE runs it in one worktree at a time.';
  if (isMultiLinePaste(command) || /[\r\n]/.test(command.trim())) return 'Run one command at a time in other worktrees.';
  if (!command.trim()) return 'This block has no command to run.';
  if (command.length > 4000) return 'This command is too long to run in other worktrees.';
  return null;
}

export type RowStatus = 'waiting' | 'starting' | 'running' | 'passed' | 'failed' | 'finished' | 'error' | 'stopped';

export interface RowOutcome {
  status: RowStatus;
  text: string;
  exitCode: number | null;
  durationMs: number | null;
}

/** One row's result in words, from what is known about its run. */
export function rowOutcome(row: { started: boolean; error: string | null; stopped: string | null }, block: CommandBlock | null): RowOutcome {
  if (row.error) return { status: 'error', text: `Could not start: ${row.error}`, exitCode: null, durationMs: null };
  if (block && block.endedAt !== null) {
    const durationMs = block.endedAt - block.startedAt;
    if (block.exitCode === 0) return { status: 'passed', text: 'Passed', exitCode: 0, durationMs };
    if (block.exitCode === null) return { status: 'finished', text: 'Finished · exit unknown', exitCode: null, durationMs };
    return { status: 'failed', text: `Failed · exit ${block.exitCode}`, exitCode: block.exitCode, durationMs };
  }
  if (row.stopped) return { status: 'stopped', text: `Stopped: ${row.stopped}`, exitCode: null, durationMs: null };
  if (block) return { status: 'running', text: 'Running…', exitCode: null, durationMs: null };
  if (row.started) return { status: 'starting', text: 'Running…', exitCode: null, durationMs: null };
  return { status: 'waiting', text: 'Waiting', exitCode: null, durationMs: null };
}

export const inFlight = (s: RowStatus) => s === 'starting' || s === 'running';
export const settled = (s: RowStatus) => s !== 'waiting' && !inFlight(s);

/** "41 s", "3.2 s", "800 ms". */
export function shortDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** The problems cell: "none", "3" or "3 · 2 new" (new only when there was an earlier run to compare with). */
export function problemsText(counts: { total: number; new: number } | null, compared: boolean, outcome: RowOutcome): string {
  if (!settled(outcome.status) || outcome.status === 'error' || outcome.status === 'stopped') return '';
  if (!counts || counts.total === 0) return 'none';
  return compared && counts.new > 0 ? `${counts.total} · ${counts.new} new` : `${counts.total}`;
}

export interface CompareRowView {
  label: string;
  ranHere: boolean;
  outcome: RowOutcome;
  problems: string;
}

/** The summary sentence ("1 of 3 passed. Fix login, second try failed with exit 1.") and the text sent to an agent. */
export function compareRuns(command: string, rows: CompareRowView[]): { summary: string; text: string } {
  const passed = rows.filter((r) => r.outcome.status === 'passed').length;
  const busy = rows.filter((r) => !settled(r.outcome.status)).length;
  let summary: string;
  if (busy) {
    summary = `${passed} of ${rows.length} passed so far; ${busy} still to finish.`;
  } else {
    const notes = rows.flatMap((r) => {
      if (r.outcome.status === 'failed') return [`${r.label} failed with exit ${r.outcome.exitCode}.`];
      if (r.outcome.status === 'error') return [`${r.label} could not start.`];
      if (r.outcome.status === 'stopped') return [`${r.label} was stopped.`];
      return [];
    });
    summary = [`${passed} of ${rows.length} passed.`, ...notes].join(' ');
  }
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const table = [
    `Run in other worktrees: \`${command}\``,
    '',
    '| Worktree | Result | Duration | Problems |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.label)}${r.ranHere ? ' (ran here)' : ''} | ${cell(r.outcome.text)} | ${shortDuration(r.outcome.durationMs)} | ${cell(r.problems)} |`),
    '',
    summary,
  ];
  return { summary, text: table.join('\n') };
}

/** The first block of a terminal that was not there before the run was typed: the run itself. */
export function runBlock(blocks: CommandBlock[], known: readonly string[]): CommandBlock | null {
  return blocks.find((b) => !known.includes(b.id)) ?? null;
}

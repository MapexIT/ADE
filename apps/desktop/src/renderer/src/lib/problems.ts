import type { CommandBlock, Problem, TerminalInfo } from '@ade/contracts';
import { commandKey, countRows, diffProblems, extractProblems, problemsAsText, tagProblems, type ProblemCounts, type TaggedRow } from '@ade/shell-integration/problems';
import { create } from 'zustand';
import { host } from './bridge.ts';
import { attachmentText, clock } from './format.ts';
import { sendChecked } from './guards.ts';
import { attempt, useStore } from './store.ts';

/** SM-18: what ADE found in one finished block, compared with the previous run of the same command. */
export interface BlockProblemsState {
  terminalId: string;
  blockId: string;
  command: string;
  exitCode: number | null;
  sessionId: string | null;
  /** Worktree root (session) or workspace root (checkout); rows' paths are relative to it. */
  root: string;
  rows: TaggedRow[];
  fixed: Problem[];
  counts: ProblemCounts;
  /** The earlier run's time as shown ("14:02"), null on a first run. */
  previousAt: string | null;
  previousTurn: number | null;
  turn: number | null;
  /** This output or the earlier one was cut, so nothing is claimed as fixed. */
  partial: boolean;
  newOnly: boolean;
}

interface ProblemsStore {
  byBlock: Record<string, BlockProblemsState>;
  toggleNewOnly(key: string): void;
}

export const problemKey = (terminalId: string, blockId: string) => `${terminalId}:${blockId}`;

export const useProblems = create<ProblemsStore>((set) => ({
  byBlock: {},
  toggleNewOnly(key) {
    set((s) => (s.byBlock[key] ? { byBlock: { ...s.byBlock, [key]: { ...s.byBlock[key]!, newOnly: !s.byBlock[key]!.newOnly } } } : {}));
  },
}));

/** Keys already handled, so a reconnect or a double-mounted effect never records a block twice. */
const seen = new Set<string>();

/**
 * Reads a finished block for problems, records the snapshot and stores the comparison for the block. Called from the
 * one `onBlockFinished` listener in `App.tsx`. Every failure ends in "no problems shown": it never breaks the block list.
 */
export async function recordBlock(terminal: TerminalInfo, block: CommandBlock): Promise<void> {
  const key = problemKey(terminal.id, block.id);
  if (seen.has(key) || !terminal.smart || block.endedAt === null) return;
  seen.add(key);
  try {
    const s = useStore.getState();
    const workspace = s.workspaces.find((w) => w.id === s.workspaceId);
    const session = terminal.sessionId ? s.sessions[terminal.sessionId] : undefined;
    const root = session?.worktreePath ?? workspace?.rootPath ?? null;
    if (!workspace || !root || !block.command.trim()) return;
    const sessionId = session ? session.id : null;
    const { problems, cut } = extractProblems(block.output, { cwd: block.cwd ?? terminal.cwd, root });
    const truncated = block.truncated ?? false;
    const turn = sessionId ? (s.views[sessionId]?.turnCount ?? null) : null;
    const { previous, checkout } = await host.call('problems.record', {
      workspaceId: workspace.id,
      sessionId,
      commandKey: commandKey(block.command),
      exitCode: block.exitCode,
      turnCount: turn,
      cut: cut || truncated,
      problems,
    });
    if (!problems.length && !previous?.problems.length) return;
    let changed = new Set<string>();
    if (sessionId && problems.length) {
      // `FileChange.path` is Git's: relative to the worktree with `/` (docs/DECISIONS.md).
      const files = await host.call('sessions.changes', { sessionId, turnIndex: null }).catch(() => []);
      changed = new Set(files.map((f) => f.path.replace(/\\/g, '/')));
    }
    const diff = diffProblems(previous ? previous.problems : null, problems);
    const rows = tagProblems(diff.rows, { changedPaths: changed, checkout: checkout ? checkout.problems : null });
    const state: BlockProblemsState = {
      terminalId: terminal.id,
      blockId: block.id,
      command: block.command,
      exitCode: block.exitCode,
      sessionId,
      root,
      rows,
      fixed: diff.fixed,
      counts: countRows(diff.rows, diff.fixed),
      previousAt: previous ? clock(Date.parse(previous.at)) : null,
      previousTurn: previous?.turnCount ?? null,
      turn,
      partial: cut || truncated || !!previous?.cut,
      newOnly: false,
    };
    useProblems.setState((st) => ({ byBlock: { ...st.byBlock, [key]: state } }));
  } catch {
    // A failed lookup shows the block as it is today.
  }
}

/** The latest finished block of a terminal that has problems (status bar, palette commands). */
export function latestProblems(byBlock: Record<string, BlockProblemsState>, terminalId: string, blocks: CommandBlock[]): BlockProblemsState | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const found = byBlock[problemKey(terminalId, blocks[i]!.id)];
    if (found && found.rows.length) return found;
  }
  return null;
}

const newProblems = (state: BlockProblemsState) => state.rows.filter((r) => r.state === 'new').map((r) => r.problem);

/** "Fix new problems with agent": a turn with only the new problems attached. Offered with a session and new problems. */
export function fixNewProblems(state: BlockProblemsState) {
  const sessionId = state.sessionId;
  const fresh = newProblems(state);
  if (!sessionId || !fresh.length) return;
  const text = problemsAsText(state.command, state.exitCode, fresh, 'New problems since the previous run');
  const one = fresh.length === 1;
  sendChecked(text, async () => {
    const ok = await attempt(() =>
      host.call('sessions.prompt', {
        sessionId,
        content: [
          { type: 'text', text: `${state.command} shows ${one ? 'a new problem' : `${fresh.length} new problems`} since the previous run. Find the cause and fix ${one ? 'it' : 'them'}.` },
          attachmentText(`New problems: ${state.command}`, text),
        ],
      }),
    );
    if (ok) useStore.getState().toast('Sent to the agent.');
  });
}

/** "Send problems to agent": the visible list goes with the next prompt. */
export function sendProblems(state: BlockProblemsState, rows: TaggedRow[]) {
  const sessionId = state.sessionId;
  if (!sessionId || !rows.length) return;
  const text = problemsAsText(state.command, state.exitCode, rows.map((r) => r.problem), 'Problems');
  sendChecked(text, () => {
    useStore.getState().attach(sessionId, attachmentText(`Problems: ${state.command}`, text));
    useStore.getState().toast('Attached to the next prompt.');
  });
}

/** The rows the block shows: New only when that filter is on. */
export const visibleRows = (state: BlockProblemsState) => (state.newOnly ? state.rows.filter((r) => r.state === 'new') : state.rows);

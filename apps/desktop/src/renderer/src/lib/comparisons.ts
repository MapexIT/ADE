import { ShellKind, type CommandBlock, type TerminalInfo } from '@ade/contracts';
import { create } from 'zustand';
import { pty } from './bridge.ts';
import { inFlight, rowOutcome, runBlock, type FanOutTarget, type RowOutcome } from './fan-out.ts';
import { useStore } from './store.ts';
import { useTerminals } from './terminals.ts';

/** SM-21: one worktree of a comparison. The origin row is the block the user ran. */
export interface CompareRow {
  key: string;
  label: string;
  cwd: string;
  sessionId: string | null;
  ranHere: boolean;
  terminalId: string | null;
  /** Blocks the terminal had before the command was typed; the first other block is the run. */
  known: string[];
  started: boolean;
  error: string | null;
}

export interface Comparison {
  id: string;
  originTerminalId: string;
  originBlockId: string;
  command: string;
  shell: string;
  sequential: boolean;
  rows: CompareRow[];
}

interface ComparisonsStore {
  byOrigin: Record<string, Comparison>;
  /** The dialog's subject: a finished block. */
  dialog: { terminalId: string; blockId: string } | null;
}

export const comparisonKey = (terminalId: string, blockId: string) => `${terminalId}:${blockId}`;

export const useComparisons = create<ComparisonsStore>(() => ({ byOrigin: {}, dialog: null }));

export const openFanOut = (terminalId: string, blockId: string) => useComparisons.setState({ dialog: { terminalId, blockId } });
export const closeFanOut = () => useComparisons.setState({ dialog: null });

function patchRow(id: string, key: string, patch: Partial<CompareRow>) {
  useComparisons.setState((s) => {
    const c = s.byOrigin[id];
    if (!c) return {};
    return { byOrigin: { ...s.byOrigin, [id]: { ...c, rows: c.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } } };
  });
}

/** Why a row's terminal stopped before its run finished, if it did. */
function stoppedReason(row: CompareRow, terminal: (TerminalInfo & { exited: boolean }) | undefined): string | null {
  if (!row.terminalId || row.ranHere) return null;
  if (terminal && !terminal.exited) return null;
  const session = row.sessionId ? useStore.getState().sessions[row.sessionId] : undefined;
  if (session && (session.state === 'landed' || session.state === 'discarded')) return 'the session ended.';
  return 'the terminal closed.';
}

/** A row's run block and outcome from the live terminal store. */
export function rowState(row: CompareRow, terms: { terminals: Record<string, TerminalInfo & { exited: boolean }>; blocks: Record<string, CommandBlock[]> }, originBlockId: string): { block: CommandBlock | null; outcome: RowOutcome } {
  const blocks = row.terminalId ? (terms.blocks[row.terminalId] ?? []) : [];
  const block = row.ranHere ? (blocks.find((b) => b.id === originBlockId) ?? null) : row.started ? runBlock(blocks, row.known) : null;
  const terminal = row.terminalId ? terms.terminals[row.terminalId] : undefined;
  const stopped = row.ranHere ? null : stoppedReason(row, terminal);
  return { block, outcome: rowOutcome({ started: row.started, error: row.error, stopped: block?.endedAt != null ? null : stopped }, block) };
}

const REASONS: Record<'not-smart' | 'timeout' | 'gone', string> = {
  'not-smart': 'shell integration did not start in this worktree.',
  timeout: 'the shell did not show a prompt within 15 seconds.',
  gone: 'the terminal closed before the command could run.',
};

async function startRow(id: string, row: CompareRow) {
  const c = useComparisons.getState().byOrigin[id];
  if (!c) return;
  patchRow(id, row.key, { started: true, error: null });
  let terminalId = row.terminalId;
  const terms = useTerminals.getState();
  if (!terminalId || terms.terminals[terminalId]?.exited !== false) {
    const shell = ShellKind.safeParse(c.shell);
    const known = terms.shells.find((s) => s.id === c.shell);
    if (!shell.success || !known) return patchRow(id, row.key, { error: `${c.shell} was not found.` });
    try {
      // The shell is spawned as for any smart terminal (an argument array); ADE builds no command string.
      const info = await pty.call('pty.create', { kind: 'smart', shell: shell.data, cwd: row.cwd, sessionId: row.sessionId, title: `Compare · ${c.command}`.slice(0, 200), cols: 120, rows: 30 });
      // Added without becoming the active terminal: the user stays where they are.
      useTerminals.setState((s) => ({ terminals: { ...s.terminals, [info.id]: { ...info, exited: false, exitCode: null } } }));
      terminalId = info.id;
      patchRow(id, row.key, { terminalId, known: [] });
    } catch (err) {
      const code = (err as { code?: string }).code;
      return patchRow(id, row.key, { error: code === 'not_found' ? 'the worktree no longer exists.' : (err as Error).message });
    }
  }
  try {
    const res = await pty.call('pty.runWhenReady', { id: terminalId, command: c.command });
    if (!res.started) patchRow(id, row.key, { error: REASONS[res.reason ?? 'gone'] });
  } catch (err) {
    patchRow(id, row.key, { error: (err as Error).message });
  }
}

/** Starts what may start: every waiting row at once, or the next one when nothing is in flight (one after another). */
function advance(id: string) {
  const c = useComparisons.getState().byOrigin[id];
  if (!c) return;
  const terms = useTerminals.getState();
  const states = c.rows.map((r) => ({ row: r, outcome: rowState(r, terms, c.originBlockId).outcome }));
  const waiting = states.filter((s) => s.outcome.status === 'waiting' && !s.row.ranHere);
  if (!waiting.length) return;
  if (!c.sequential) {
    for (const w of waiting) void startRow(id, w.row);
    return;
  }
  if (states.some((s) => !s.row.ranHere && inFlight(s.outcome.status))) return;
  void startRow(id, waiting[0]!.row);
}

/** Opens the comparison under the block and starts the runs. */
export function startComparison(origin: { terminal: TerminalInfo; block: CommandBlock }, targets: FanOutTarget[], sequential: boolean) {
  const id = comparisonKey(origin.terminal.id, origin.block.id);
  const ranHere = targets.find((t) => t.ranHere);
  const rows: CompareRow[] = [
    {
      key: ranHere?.key ?? 'origin',
      label: ranHere?.label ?? origin.terminal.title,
      cwd: origin.block.cwd ?? origin.terminal.cwd,
      sessionId: origin.terminal.sessionId,
      ranHere: true,
      terminalId: origin.terminal.id,
      known: [],
      started: true,
      error: null,
    },
    ...targets.filter((t) => !t.ranHere).map((t) => ({ key: t.key, label: t.label, cwd: t.cwd, sessionId: t.sessionId, ranHere: false, terminalId: null, known: [], started: false, error: null })),
  ];
  useComparisons.setState((s) => ({ byOrigin: { ...s.byOrigin, [id]: { id, originTerminalId: origin.terminal.id, originBlockId: origin.block.id, command: origin.block.command, shell: origin.terminal.shell, sequential, rows } } }));
  advance(id);
}

/** "Run again in all": types the command again into each other worktree's terminal (a new one if it closed). */
export function runAgain(id: string) {
  const c = useComparisons.getState().byOrigin[id];
  if (!c) return;
  const terms = useTerminals.getState();
  useComparisons.setState((s) => ({
    byOrigin: {
      ...s.byOrigin,
      [id]: { ...c, rows: c.rows.map((r) => (r.ranHere ? r : { ...r, started: false, error: null, known: r.terminalId ? (terms.blocks[r.terminalId] ?? []).map((b) => b.id) : [] })) },
    },
  }));
  advance(id);
}

/** Stop writes Ctrl+C, as the running header's Stop does. */
export function stopRow(terminalId: string) {
  void pty.call('pty.write', { id: terminalId, data: '\x03' }).catch(() => undefined);
}

export function closeComparison(id: string) {
  useComparisons.setState((s) => {
    const byOrigin = { ...s.byOrigin };
    delete byOrigin[id];
    return { byOrigin };
  });
}

let wired = false;
/** Follows the terminals: a finished run lets the next one start (one after another). */
export function wireComparisons() {
  if (wired) return;
  wired = true;
  useTerminals.subscribe((s, prev) => {
    if (s.blocks === prev.blocks && s.terminals === prev.terminals) return;
    for (const id of Object.keys(useComparisons.getState().byOrigin)) advance(id);
  });
}

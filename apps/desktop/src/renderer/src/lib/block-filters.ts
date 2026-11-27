import type { CommandBlock } from '@ade/contracts';
import { commandKey } from '@ade/shell-integration/problems';
import { create } from 'zustand';

/** SM-20: a block filter. It belongs to the command in a terminal, not the block, and holds no output. */
export interface FilterState {
  terminalId: string;
  commandKey: string;
  /** The block it is shown on: the latest finished run of the command, so a re-run opens already filtered. */
  blockId: string;
  query: string;
  regex: boolean;
  matchCase: boolean;
  invert: boolean;
  context: number;
  preset: 'errors' | 'changed' | null;
  /** Bumped to move focus to the filter input again (Ctrl+Shift+L on an open filter). */
  focusNonce: number;
}

export const filterKey = (terminalId: string, command: string) => `${terminalId}\u0000${commandKey(command)}`;

interface BlockFiltersStore {
  byCommand: Record<string, FilterState>;
  open(terminalId: string, block: CommandBlock): void;
  update(key: string, patch: Partial<FilterState>): void;
  clear(key: string): void;
}

export const useBlockFilters = create<BlockFiltersStore>((set) => ({
  byCommand: {},
  open(terminalId, block) {
    const key = filterKey(terminalId, block.command);
    set((s) => {
      const cur = s.byCommand[key];
      const next: FilterState = cur
        ? { ...cur, blockId: block.id, focusNonce: cur.focusNonce + 1 }
        : { terminalId, commandKey: commandKey(block.command), blockId: block.id, query: '', regex: false, matchCase: false, invert: false, context: 0, preset: null, focusNonce: 0 };
      return { byCommand: { ...s.byCommand, [key]: next } };
    });
  },
  update(key, patch) {
    set((s) => (s.byCommand[key] ? { byCommand: { ...s.byCommand, [key]: { ...s.byCommand[key]!, ...patch } } } : {}));
  },
  clear(key) {
    set((s) => {
      const byCommand = { ...s.byCommand };
      delete byCommand[key];
      return { byCommand };
    });
  },
}));

/**
 * Moves each of a terminal's filters to the latest finished run of its command. Returns the same object when nothing
 * moved, so a store update can be skipped.
 */
export function followFilters(byCommand: Record<string, FilterState>, terminalId: string, blocks: CommandBlock[]): Record<string, FilterState> {
  let next = byCommand;
  for (const [key, f] of Object.entries(byCommand)) {
    if (f.terminalId !== terminalId) continue;
    const latest = [...blocks].reverse().find((b) => b.endedAt !== null && commandKey(b.command) === f.commandKey);
    if (latest && latest.id !== f.blockId) {
      if (next === byCommand) next = { ...byCommand };
      next[key] = { ...f, blockId: latest.id };
    }
  }
  return next;
}

/** The nearest earlier finished run of the same command in the terminal, for "Changed since last run". */
export function previousRun(blocks: CommandBlock[], block: CommandBlock): CommandBlock | null {
  const key = commandKey(block.command);
  const idx = blocks.findIndex((b) => b.id === block.id);
  for (let i = (idx === -1 ? blocks.length : idx) - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.endedAt !== null && commandKey(b.command) === key) return b;
  }
  return null;
}

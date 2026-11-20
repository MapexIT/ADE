import type { CommandBlock, ShellKind, TerminalInfo, TerminalKind } from '@ade/contracts';
import { create } from 'zustand';
import { pty } from './bridge.ts';

interface TerminalState {
  terminals: Record<string, TerminalInfo & { exited: boolean; exitCode: number | null }>;
  blocks: Record<string, CommandBlock[]>;
  shells: { id: ShellKind; label: string; path: string }[];
  active: string | null;
  setActive(id: string | null): void;
  create(opts: { kind: TerminalKind; cwd: string; sessionId: string | null; shell?: ShellKind; command?: string[]; title?: string }): Promise<TerminalInfo>;
  close(id: string): Promise<void>;
}

const MAX_BUFFER = 400_000;
/** Raw output per terminal, so a terminal mounted later (or remounted) can replay its scrollback. */
const buffers = new Map<string, string>();
const dataListeners = new Map<string, Set<(data: string) => void>>();
const runListeners = new Set<(r: { runId: string; exitCode: number | null; output: string }) => void>();

export const useTerminals = create<TerminalState>((set, get) => ({
  terminals: {},
  blocks: {},
  shells: [],
  active: null,
  setActive(id) {
    set({ active: id });
  },
  async create(opts) {
    const info = await pty.call('pty.create', { cols: 100, rows: 30, ...opts });
    set((s) => ({ terminals: { ...s.terminals, [info.id]: { ...info, exited: false, exitCode: null } }, active: info.id }));
    return info;
  },
  async close(id) {
    await pty.call('pty.kill', { id }).catch(() => undefined);
    buffers.delete(id);
    set((s) => {
      const terminals = { ...s.terminals };
      delete terminals[id];
      const blocks = { ...s.blocks };
      delete blocks[id];
      return { terminals, blocks, active: s.active === id ? (Object.keys(terminals)[0] ?? null) : s.active };
    });
    void get();
  },
}));

export function subscribeData(id: string, listener: (data: string) => void): () => void {
  const set = dataListeners.get(id) ?? new Set();
  set.add(listener);
  dataListeners.set(id, set);
  return () => {
    set.delete(listener);
  };
}

export const scrollback = (id: string) => buffers.get(id) ?? '';

export function onRunFinished(listener: (r: { runId: string; exitCode: number | null; output: string }) => void) {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

let wired = false;
/** Subscribes to the pty process streams once. Safe across reconnects (the bridge re-subscribes). */
export function wireTerminals() {
  if (wired) return;
  wired = true;
  pty.on('pty.data', ({ id, data }) => {
    const next = (buffers.get(id) ?? '') + data;
    buffers.set(id, next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next);
    for (const l of dataListeners.get(id) ?? []) l(data);
  });
  pty.on('pty.block', ({ id, block }) => {
    useTerminals.setState((s) => {
      const list = s.blocks[id] ?? [];
      const idx = list.findIndex((b) => b.id === block.id);
      const next = idx === -1 ? [...list, block] : list.map((b, i) => (i === idx ? block : b));
      return { blocks: { ...s.blocks, [id]: next.slice(-500) } };
    });
  });
  pty.on('pty.changed', (info) => {
    useTerminals.setState((s) => (s.terminals[info.id] ? { terminals: { ...s.terminals, [info.id]: { ...s.terminals[info.id]!, ...info } } } : {}));
  });
  pty.on('pty.exit', ({ id, exitCode }) => {
    useTerminals.setState((s) => (s.terminals[id] ? { terminals: { ...s.terminals, [id]: { ...s.terminals[id]!, exited: true, exitCode } } } : {}));
  });
  pty.on('pty.runFinished', (r) => {
    for (const l of runListeners) l(r);
  });
  void pty.call('pty.shells', {}).then((shells) => useTerminals.setState({ shells }));
  void pty.call('pty.list', {}).then((list) =>
    useTerminals.setState((s) => ({ terminals: { ...Object.fromEntries(list.map((t) => [t.id, { ...t, exited: false, exitCode: null }])), ...s.terminals } })),
  );
}

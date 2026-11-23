import type { ComposerState, PromptBox } from '@ade/contracts';
import { DEFAULT_SETTINGS } from '@ade/reasoning';
import { create } from 'zustand';
import { host } from './bridge.ts';

export const defaultComposer = (): ComposerState => ({ mode: 'chat', reasoning: { ...DEFAULT_SETTINGS } });

const SAVE_DELAY_MS = 400;
/** Pending saves, keyed `composer:<sessionId>` or `board:<workspaceId>`. */
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; save: () => void }>();

function schedule(key: string, save: () => void) {
  clearTimeout(timers.get(key)?.timer);
  const timer = setTimeout(() => {
    timers.delete(key);
    save();
  }, SAVE_DELAY_MS);
  timers.set(key, { timer, save });
}

interface ComposerStore {
  /** Per session: chat or board, and the generation method. */
  states: Record<string, ComposerState>;
  /** Per workspace: the prompt board every session of the workspace shares. */
  boards: Record<string, PromptBox[]>;
  load(sessionId: string): Promise<void>;
  update(sessionId: string, change: (s: ComposerState) => ComposerState): void;
  loadBoard(workspaceId: string): Promise<void>;
  updateBoard(workspaceId: string, change: (boxes: PromptBox[]) => PromptBox[]): void;
}

/**
 * GN-01 / GN-02: the composer's saved state. Each session keeps its own mode and generation method; the prompt
 * board belongs to the workspace, so every session there sees the same boxes. Both are loaded from the host once
 * and saved shortly after every change, so they survive restarts.
 */
export const useComposer = create<ComposerStore>((set, get) => ({
  states: {},
  boards: {},
  async load(sessionId) {
    if (get().states[sessionId]) return;
    const stored = await host.call('composer.get', { sessionId }).catch(() => null);
    // A change made while loading wins over what was stored.
    if (!get().states[sessionId]) set((s) => ({ states: { ...s.states, [sessionId]: stored ?? defaultComposer() } }));
  },
  update(sessionId, change) {
    const next = change(get().states[sessionId] ?? defaultComposer());
    set((s) => ({ states: { ...s.states, [sessionId]: next } }));
    schedule(`composer:${sessionId}`, () => {
      const state = get().states[sessionId];
      if (state) void host.call('composer.save', { sessionId, state }).catch(() => undefined);
    });
  },
  async loadBoard(workspaceId) {
    if (get().boards[workspaceId]) return;
    const stored = await host.call('promptBoard.get', { workspaceId }).catch(() => [] as PromptBox[]);
    if (!get().boards[workspaceId]) set((s) => ({ boards: { ...s.boards, [workspaceId]: stored } }));
  },
  updateBoard(workspaceId, change) {
    const next = change(get().boards[workspaceId] ?? []);
    set((s) => ({ boards: { ...s.boards, [workspaceId]: next } }));
    schedule(`board:${workspaceId}`, () => {
      const boxes = get().boards[workspaceId];
      if (boxes) void host.call('promptBoard.save', { workspaceId, boxes }).catch(() => undefined);
    });
  },
}));

/** Saves pending changes now, e.g. when the window is closing. */
export function flushComposer() {
  for (const [key, { timer, save }] of [...timers]) {
    clearTimeout(timer);
    timers.delete(key);
    save();
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushComposer);

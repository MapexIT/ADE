import type { ComposerState } from '@ade/contracts';
import { DEFAULT_SETTINGS } from '@ade/reasoning';
import { create } from 'zustand';
import { host } from './bridge.ts';

export const defaultComposer = (): ComposerState => ({ mode: 'chat', reasoning: { ...DEFAULT_SETTINGS }, boxes: [] });

const SAVE_DELAY_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

interface ComposerStore {
  states: Record<string, ComposerState>;
  load(sessionId: string): Promise<void>;
  update(sessionId: string, change: (s: ComposerState) => ComposerState): void;
}

function save(sessionId: string) {
  timers.delete(sessionId);
  const state = useComposer.getState().states[sessionId];
  if (state) void host.call('composer.save', { sessionId, state }).catch(() => undefined);
}

/**
 * GN-01 / GN-02: each session's composer (chat or board, reasoning method, board boxes). Loaded from the host once
 * per session and saved shortly after every change, so it survives restarts.
 */
export const useComposer = create<ComposerStore>((set, get) => ({
  states: {},
  async load(sessionId) {
    if (get().states[sessionId]) return;
    const stored = await host.call('composer.get', { sessionId }).catch(() => null);
    // A change made while loading wins over what was stored.
    if (!get().states[sessionId]) set((s) => ({ states: { ...s.states, [sessionId]: stored ?? defaultComposer() } }));
  },
  update(sessionId, change) {
    const current = get().states[sessionId] ?? defaultComposer();
    set((s) => ({ states: { ...s.states, [sessionId]: change(current) } }));
    clearTimeout(timers.get(sessionId));
    timers.set(sessionId, setTimeout(() => save(sessionId), SAVE_DELAY_MS));
  },
}));

/** Saves pending changes now, e.g. when the window is closing. */
export function flushComposer() {
  for (const [sessionId, t] of [...timers]) {
    clearTimeout(t);
    save(sessionId);
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushComposer);

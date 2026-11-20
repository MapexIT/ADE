import type { AgentStatus, NeedsYouItem, PromptBlock, Session, SessionEvent, Turn, WorkItem, Workspace } from '@ade/contracts';
import { applyEvent, emptyView, projectSession, type SessionView } from '@ade/session-core';
import { create } from 'zustand';
import { host } from './bridge.ts';

export type Tab = 'sessions' | 'work-items' | 'workflows' | 'terminals' | 'run' | 'review';

export interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  tone: 'info' | 'danger';
  text: string;
}

export interface NewSessionPrefill {
  prompt?: string;
  title?: string;
  workItem?: WorkItem;
  attachments?: PromptBlock[];
}

interface State {
  workspaces: Workspace[];
  workspaceId: string | null;
  agents: AgentStatus[];
  tab: Tab;
  /** The workflow run the Workflows screen should show (set from Needs you). */
  focusRunId: string | null;
  selectedSessionId: string | null;
  sessions: Record<string, Session>;
  views: Record<string, SessionView>;
  turns: Record<string, Turn[]>;
  queued: Record<string, { id: string; content: PromptBlock[] }[]>;
  inbox: NeedsYouItem[];
  connection: { host: boolean; pty: boolean };
  /** Context waiting to be sent with the next prompt, per session (ST-03, TM-05, CR-04, SM-08). */
  attachments: Record<string, PromptBlock[]>;
  editor: { path: string; sessionId: string | null } | null;
  newSession: NewSessionPrefill | null;
  paletteOpen: boolean;
  inboxOpen: boolean;
  settingsOpen: boolean;
  firstRunOpen: boolean;
  protocolSessionId: string | null;
  confirm: ConfirmSpec | null;
  toasts: Toast[];
}

interface Actions {
  init(): Promise<void>;
  openWorkspace(path: string): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  refreshAgents(refresh?: boolean): Promise<void>;
  selectSession(id: string | null): void;
  loadSession(id: string): Promise<void>;
  onEvent(e: SessionEvent): void;
  upsertSession(s: Session): void;
  setTab(tab: Tab): void;
  attach(sessionId: string, block: PromptBlock): void;
  detach(sessionId: string, index: number): void;
  takeAttachments(sessionId: string): PromptBlock[];
  openEditor(path: string, sessionId: string | null): void;
  set(patch: Partial<State>): void;
  toast(text: string, tone?: Toast['tone']): void;
  ask(spec: ConfirmSpec): void;
}

let toastId = 1;

export const useStore = create<State & Actions>((set, get) => ({
  workspaces: [],
  workspaceId: null,
  agents: [],
  tab: 'sessions',
  focusRunId: null,
  selectedSessionId: null,
  sessions: {},
  views: {},
  turns: {},
  queued: {},
  inbox: [],
  connection: { host: false, pty: false },
  attachments: {},
  editor: null,
  newSession: null,
  paletteOpen: false,
  inboxOpen: false,
  settingsOpen: false,
  firstRunOpen: false,
  protocolSessionId: null,
  confirm: null,
  toasts: [],

  async init() {
    const [workspaces, firstRunDone, lastWorkspace, inbox] = await Promise.all([
      host.call('workspace.list', {}),
      host.call('settings.get', { key: 'firstRunDone' }),
      host.call('settings.get', { key: 'lastWorkspaceId' }),
      host.call('inbox.list', {}),
    ]);
    set({ workspaces, inbox, firstRunOpen: !firstRunDone.value });
    void get().refreshAgents();
    const id = typeof lastWorkspace.value === 'string' && workspaces.some((w) => w.id === lastWorkspace.value) ? lastWorkspace.value : workspaces[0]?.id;
    if (id) await get().selectWorkspace(id);
  },

  async openWorkspace(path) {
    try {
      const ws = await host.call('workspace.open', { path });
      set({ workspaces: await host.call('workspace.list', {}) });
      await get().selectWorkspace(ws.id);
    } catch (err) {
      get().toast((err as Error).message, 'danger');
    }
  },

  async selectWorkspace(id) {
    const list = await host.call('sessions.list', { workspaceId: id });
    void host.call('settings.set', { key: 'lastWorkspaceId', value: id });
    set({ workspaceId: id, sessions: Object.fromEntries(list.map((s) => [s.id, s])), selectedSessionId: list[0]?.id ?? null, views: {}, turns: {}, queued: {} });
    const first = list[0];
    if (first) await get().loadSession(first.id);
  },

  async refreshAgents(refresh = false) {
    set({ agents: await host.call('agents.status', { refresh }) });
  },

  selectSession(id) {
    set({ selectedSessionId: id });
    if (id && !get().views[id]) void get().loadSession(id);
  },

  async loadSession(id) {
    const detail = await host.call('sessions.get', { sessionId: id });
    set((s) => ({
      sessions: { ...s.sessions, [id]: detail.session },
      views: { ...s.views, [id]: projectSession(detail.events) },
      turns: { ...s.turns, [id]: detail.turns },
      queued: { ...s.queued, [id]: detail.queued },
    }));
  },

  onEvent(e) {
    const view = get().views[e.sessionId];
    if (!view && !get().sessions[e.sessionId]) return;
    set((s) => ({ views: { ...s.views, [e.sessionId]: applyEvent(s.views[e.sessionId] ?? emptyView(), e) } }));
    // Turn boundaries change the turn list and the queue; refresh them from the host.
    if (e.type === 'turn.started' || e.type === 'turn.ended' || e.type === 'user.message') {
      void host.call('sessions.get', { sessionId: e.sessionId }).then((d) =>
        set((s) => ({ turns: { ...s.turns, [e.sessionId]: d.turns }, queued: { ...s.queued, [e.sessionId]: d.queued } })),
      );
    }
  },

  upsertSession(session) {
    if (session.workspaceId !== get().workspaceId) return;
    set((s) => ({ sessions: { ...s.sessions, [session.id]: session } }));
    void host.call('sessions.get', { sessionId: session.id }).then((d) => set((s) => ({ queued: { ...s.queued, [session.id]: d.queued } })));
  },

  setTab(tab) {
    set({ tab });
  },

  attach(sessionId, block) {
    set((s) => ({ attachments: { ...s.attachments, [sessionId]: [...(s.attachments[sessionId] ?? []), block] } }));
  },

  detach(sessionId, index) {
    set((s) => ({ attachments: { ...s.attachments, [sessionId]: (s.attachments[sessionId] ?? []).filter((_, i) => i !== index) } }));
  },

  takeAttachments(sessionId) {
    const taken = get().attachments[sessionId] ?? [];
    set((s) => ({ attachments: { ...s.attachments, [sessionId]: [] } }));
    return taken;
  },

  openEditor(path, sessionId) {
    set({ editor: { path, sessionId }, tab: 'sessions' });
  },

  set(patch) {
    set(patch);
  },

  toast(text, tone = 'info') {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts, { id, tone, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'danger' ? 8000 : 4000);
  },

  ask(spec) {
    set({ confirm: spec });
  },
}));

/** Stable empty array for selectors (a fresh `[]` each call would re-render forever). */
export const EMPTY: never[] = [];

export const selectedSession = (s: State) => (s.selectedSessionId ? s.sessions[s.selectedSessionId] ?? null : null);
export const currentWorkspace = (s: State) => s.workspaces.find((w) => w.id === s.workspaceId) ?? null;

/** Runs an async action and turns failures into a toast instead of an unhandled rejection. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    useStore.getState().toast((err as Error).message, 'danger');
    return undefined;
  }
}

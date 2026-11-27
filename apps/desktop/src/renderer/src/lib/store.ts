import type { AgentId, AgentStatus, NeedsYouItem, PromptBlock, RuleAdvice, RuleSuggestion, Session, SessionEvent, Turn, WorkItem, Workspace } from '@ade/contracts';
import { activityFrom, applyActivity, applyEvent, emptyActivity, emptyView, projectSession, type Activity, type SessionView } from '@ade/session-core';
import { create } from 'zustand';
import { host } from './bridge.ts';
import { extractShellCommands } from './terminal-intel.ts';
import type { ActiveRun } from './runs.ts';
import { AGENT_LABELS } from '@ade/contracts';

export type Tab = 'sessions' | 'work-items' | 'workflows' | 'skills' | 'terminals' | 'run' | 'review' | 'observe' | 'git';

/** SM-09, SM-10: a command proposed by an agent, waiting for the user to run or dismiss it. */
export interface Suggestion {
  id: string;
  /** Shown on this terminal (a drafted command) or on every terminal of this session (an agent's reply). */
  terminalId: string | null;
  sessionId: string | null;
  command: string;
  from: string;
}

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
  /** SK-01: skills loaded into the new session only. */
  skills?: string[];
  /** Open with "A workflow" selected (WF-02). */
  mode?: 'agent' | 'workflow';
  /** Seeds the workflow's first hand-off, for example a failed command's output (WF-10). */
  handOff?: { summary?: string; checkOutput?: string };
  /** SR-06: start from this commit (an earlier turn's checkpoint). */
  baseRef?: string;
  /** SR-10: continue this conversation from the agent's own CLI. */
  continueFrom?: { agentId: AgentId; sessionId: string; title: string | null };
  /** Open with "Compare agents" selected (PL-03). */
  compare?: boolean;
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
  /** WA-07: live activity per session, derived from the same events as `views`. */
  activity: Record<string, Activity>;
  turns: Record<string, Turn[]>;
  queued: Record<string, { id: string; content: PromptBlock[] }[]>;
  inbox: NeedsYouItem[];
  connection: { host: boolean; pty: boolean };
  /** Context waiting to be sent with the next prompt, per session (ST-03, TM-05, CR-04, SM-08). */
  attachments: Record<string, PromptBlock[]>;
  /** `rev` changes when the open file should be reloaded (follow mode after the agent edited it). */
  /** `line` (SM-18): reveal and place the cursor on this line once the file is open; `lineSeq` changes per request. */
  editor: { path: string; sessionId: string | null; rev?: number; line?: number; lineSeq?: number } | null;
  suggestions: Suggestion[];
  /** HI-06: the session search dialog. */
  sessionSearchOpen: boolean;
  /** SR-10: the dialog that lists conversations from the agents' CLIs. */
  cliSessionsOpen: boolean;
  /** The run shown in the Run tab (CR-02); see lib/runs.ts. */
  activeRun: ActiveRun | null;
  /** CR-02: a run that was asked for and has not printed anything yet; the Run tab shows a waiting animation. */
  startingRun: { token: string; label: string } | null;
  /** Bumped when a run is recorded, so history views refresh. */
  runsVersion: number;
  /** PL-03: the compare run shown side by side, by its group id. */
  compareGroup: string | null;
  /** SR-07: the session being handed to another agent. */
  handOffSessionId: string | null;
  /** WA-06: the editor follows the file the selected session's agent is working on. */
  follow: boolean;
  /** Set by the editor; follow mode never replaces a file with unsaved changes. */
  editorDirty: boolean;
  newSession: NewSessionPrefill | null;
  paletteOpen: boolean;
  helpOpen: boolean;
  inboxOpen: boolean;
  settingsOpen: boolean;
  /** CO-13: the MCP servers dialog. */
  mcpOpen: boolean;
  firstRunOpen: boolean;
  protocolSessionId: string | null;
  confirm: ConfirmSpec | null;
  toasts: Toast[];
  /** WA-10: text to put in a session's chat box (Redirect the agent); the composer takes it and clears it. */
  composerDraft: { sessionId: string; text: string } | null;
  /** AP-09: rule suggestions and rule usage per workspace, from `rules.advice`. */
  ruleAdvice: Record<string, RuleAdvice>;
  /** AP-09: the suggestion open in the "Rule from your decisions" dialog. */
  ruleSuggestion: { workspaceId: string; suggestion: RuleSuggestion } | null;
  /** A section of the Settings dialog to scroll to when it opens. */
  settingsSection: 'suggested-rules' | null;
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
  openEditor(path: string, sessionId: string | null, line?: number): void;
  set(patch: Partial<State>): void;
  toast(text: string, tone?: Toast['tone']): void;
  ask(spec: ConfirmSpec): void;
  /** AP-09: reloads rule advice for a workspace, after `delayMs` (debounced per workspace). */
  refreshRuleAdvice(workspaceId: string, delayMs?: number): void;
}

let toastId = 1;
const adviceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const adviceSeq = new Map<string, number>();

/** SM-09: shell blocks in an agent's reply become pending suggestions on that session's terminals. */
function suggestFrom(sessionId: string, text: string) {
  const commands = extractShellCommands(text);
  if (!commands.length) return;
  const s = useStore.getState();
  const from = AGENT_LABELS[s.sessions[sessionId]?.agentId ?? 'fake'];
  const fresh = commands
    .filter((c) => !s.suggestions.some((x) => x.sessionId === sessionId && x.command === c))
    .map((command) => ({ id: crypto.randomUUID(), terminalId: null, sessionId, command, from }));
  if (fresh.length) useStore.setState({ suggestions: [...s.suggestions, ...fresh].slice(-20) });
}

/** WA-06: tool calls being followed, by id, so their completion reloads the file. */
const followed = new Map<string, string>();

function followAgent(e: SessionEvent) {
  const s = useStore.getState();
  if (!s.follow || e.sessionId !== s.selectedSessionId) return;
  const session = s.sessions[e.sessionId];
  if (e.type === 'tool.call' && e.locations[0] && session?.worktreePath) {
    const loc = e.locations[0];
    const path = /^([A-Za-z]:[\\/]|\/)/.test(loc) ? loc : `${session.worktreePath.replace(/[\\/]+$/, '')}/${loc}`;
    followed.set(e.toolCallId, path);
    if (s.editorDirty && s.editor?.path !== path) return;
    useStore.setState({ editor: { path, sessionId: session.id, rev: (s.editor?.rev ?? 0) + 1 } });
  } else if (e.type === 'tool.update' && e.status === 'completed') {
    const path = followed.get(e.toolCallId);
    followed.delete(e.toolCallId);
    if (path && s.editor?.path === path && !s.editorDirty) useStore.setState({ editor: { ...s.editor, rev: (s.editor.rev ?? 0) + 1 } });
  }
}

export const useStore = create<State & Actions>((set, get) => ({
  workspaces: [],
  workspaceId: null,
  agents: [],
  tab: 'sessions',
  focusRunId: null,
  selectedSessionId: null,
  sessions: {},
  views: {},
  activity: {},
  turns: {},
  queued: {},
  inbox: [],
  connection: { host: false, pty: false },
  attachments: {},
  editor: null,
  follow: false,
  editorDirty: false,
  compareGroup: null,
  handOffSessionId: null,
  suggestions: [],
  sessionSearchOpen: false,
  cliSessionsOpen: false,
  activeRun: null,
  startingRun: null,
  runsVersion: 0,
  newSession: null,
  paletteOpen: false,
  helpOpen: false,
  inboxOpen: false,
  settingsOpen: false,
  mcpOpen: false,
  firstRunOpen: false,
  protocolSessionId: null,
  confirm: null,
  toasts: [],
  composerDraft: null,
  ruleAdvice: {},
  ruleSuggestion: null,
  settingsSection: null,

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
    set({ workspaceId: id, sessions: Object.fromEntries(list.map((s) => [s.id, s])), selectedSessionId: list[0]?.id ?? null, views: {}, activity: {}, turns: {}, queued: {} });
    get().refreshRuleAdvice(id);
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
      activity: { ...s.activity, [id]: activityFrom(detail.events) },
      turns: { ...s.turns, [id]: detail.turns },
      queued: { ...s.queued, [id]: detail.queued },
    }));
  },

  onEvent(e) {
    const view = get().views[e.sessionId];
    if (!view && !get().sessions[e.sessionId]) return;
    set((s) => ({
      views: { ...s.views, [e.sessionId]: applyEvent(s.views[e.sessionId] ?? emptyView(), e) },
      activity: { ...s.activity, [e.sessionId]: applyActivity(s.activity[e.sessionId] ?? emptyActivity(), e) },
    }));
    followAgent(e);
    if (e.type === 'agent.message') suggestFrom(e.sessionId, e.text);
    // AP-09: a decision of the user's own may make a rule suggestion appear.
    if (e.type === 'permission.decided' && e.decidedBy === 'user') {
      const ws = get().sessions[e.sessionId]?.workspaceId;
      if (ws) get().refreshRuleAdvice(ws, 300);
    }
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

  openEditor(path, sessionId, line) {
    set({ editor: { path, sessionId, ...(line && line > 0 ? { line, lineSeq: ++lineSeq } : {}) }, tab: 'sessions' });
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

  refreshRuleAdvice(workspaceId, delayMs = 0) {
    clearTimeout(adviceTimers.get(workspaceId));
    adviceTimers.set(
      workspaceId,
      setTimeout(() => {
        adviceTimers.delete(workspaceId);
        const seq = (adviceSeq.get(workspaceId) ?? 0) + 1;
        adviceSeq.set(workspaceId, seq);
        void host.call('rules.advice', { workspaceId }).then(
          (advice) => {
            // A slower, older answer never replaces a newer one.
            if (adviceSeq.get(workspaceId) === seq) set((s) => ({ ruleAdvice: { ...s.ruleAdvice, [workspaceId]: advice } }));
          },
          () => undefined,
        );
      }, delayMs),
    );
  },
}));

/** Stable empty array for selectors (a fresh `[]` each call would re-render forever). */
export const EMPTY: never[] = [];
let lineSeq = 0;

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

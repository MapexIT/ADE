import { isLive } from '@ade/session-core';
import { host, main } from './bridge.ts';
import { attempt, useStore, type Tab } from './store.ts';

/** One action the user can take (Command pattern). Every action is reachable from the palette (UI rule). */
export interface Command {
  id: string;
  title: string;
  group: 'Workspace' | 'Session' | 'Navigate' | 'Terminal' | 'App';
  shortcut?: string;
  run: () => void | Promise<void>;
}

const TABS: { tab: Tab; title: string }[] = [
  { tab: 'sessions', title: 'Sessions' },
  { tab: 'work-items', title: 'Work items' },
  { tab: 'workflows', title: 'Workflows' },
  { tab: 'skills', title: 'Skills' },
  { tab: 'terminals', title: 'Terminals' },
  { tab: 'run', title: 'Run' },
  { tab: 'review', title: 'Review' },
];

export async function pickAndOpenWorkspace() {
  const res = await attempt(() => main('main.pickDirectory', { title: 'Open a Git repository' }));
  if (res?.path) await useStore.getState().openWorkspace(res.path);
}

export function buildCommands(): Command[] {
  const s = useStore.getState();
  const session = s.selectedSessionId ? s.sessions[s.selectedSessionId] : null;
  const cmds: Command[] = [
    { id: 'workspace.open', title: 'Open repository', group: 'Workspace', shortcut: 'Ctrl O', run: pickAndOpenWorkspace },
    ...s.workspaces.filter((w) => w.id !== s.workspaceId).map((w) => ({
      id: `workspace.switch.${w.id}`,
      title: `Switch to ${w.name}`,
      group: 'Workspace' as const,
      run: () => s.selectWorkspace(w.id),
    })),
    { id: 'session.new', title: 'New session', group: 'Session', shortcut: 'Ctrl N', run: () => s.set({ newSession: {} }) },
    { id: 'inbox.open', title: 'Open the Needs-you inbox', group: 'Navigate', shortcut: 'Ctrl I', run: () => s.set({ inboxOpen: true }) },
    ...TABS.map((t, i) => ({ id: `nav.${t.tab}`, title: `Go to ${t.title}`, group: 'Navigate' as const, shortcut: `Ctrl ${i + 1}`, run: () => s.setTab(t.tab) })),
    { id: 'app.settings', title: 'Settings', group: 'App', shortcut: 'Ctrl ,', run: () => s.set({ settingsOpen: true }) },
    { id: 'app.setup', title: 'First-run setup', group: 'App', run: () => s.set({ firstRunOpen: true }) },
    { id: 'app.agents', title: 'Check agents again', group: 'App', run: () => s.refreshAgents(true) },
    { id: 'app.restart-host', title: 'Restart the host process', group: 'App', run: () => void main('main.restartProcess', { which: 'host' }) },
    { id: 'app.restart-pty', title: 'Restart the terminal process', group: 'App', run: () => void main('main.restartProcess', { which: 'pty' }) },
  ];
  if (session) {
    if (isLive(session.state)) {
      cmds.push({ id: 'session.cancel', title: 'Cancel the running turn', group: 'Session', shortcut: 'Esc', run: () => void attempt(() => host.call('sessions.cancel', { sessionId: session.id })) });
    }
    cmds.push(
      { id: 'session.review', title: 'Review changes', group: 'Session', run: () => s.setTab('review') },
      { id: 'session.protocol', title: 'Show protocol messages', group: 'Session', run: () => s.set({ protocolSessionId: session.id }) },
    );
    if (session.worktreePath) {
      const path = session.worktreePath;
      cmds.push({ id: 'session.editor', title: 'Open worktree in my editor', group: 'Session', run: () => void attempt(() => main('main.openInEditor', { path })) });
    }
  }
  return cmds;
}

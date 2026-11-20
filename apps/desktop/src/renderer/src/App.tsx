import { motion } from 'motion/react';
import { useEffect } from 'react';
import { ConfirmDialog } from './components/Modal.tsx';
import { CommandPalette, FirstRunDialog, InboxDialog, ProtocolDialog, ReconnectBanner, SettingsDialog, Toasts } from './components/Dialogs.tsx';
import { NewSessionDialog } from './components/NewSessionDialog.tsx';
import { ReviewScreen } from './components/ReviewScreen.tsx';
import { RunScreen } from './components/RunScreen.tsx';
import { SessionsWorkspace } from './components/SessionsWorkspace.tsx';
import { TerminalsScreen } from './components/terminal/TerminalsScreen.tsx';
import { TopBar } from './components/TopBar.tsx';
import { WorkflowsScreen } from './components/workflows/WorkflowsScreen.tsx';
import { SkillsScreen } from './components/SkillsScreen.tsx';
import { WorkItemsScreen } from './components/WorkItemsScreen.tsx';
import { host, onMain, pty } from './lib/bridge.ts';
import { buildCommands } from './lib/commands.ts';
import { useStore, type Tab } from './lib/store.ts';
import { wireTerminals } from './lib/terminals.ts';

const TAB_ORDER: Tab[] = ['sessions', 'work-items', 'workflows', 'terminals', 'run', 'review'];

function useWiring() {
  useEffect(() => {
    const s = useStore.getState();
    const offs = [
      host.onConnection((up) => {
        useStore.setState((st) => ({ connection: { ...st.connection, host: up } }));
        if (up) void useStore.getState().init().catch((err: Error) => s.toast(err.message, 'danger'));
      }),
      pty.onConnection((up) => {
        useStore.setState((st) => ({ connection: { ...st.connection, pty: up } }));
        if (up) wireTerminals();
      }),
      host.on('session.event', (e) => useStore.getState().onEvent(e)),
      host.on('session.changed', ({ session }) => useStore.getState().upsertSession(session)),
      host.on('inbox.changed', (inbox) => useStore.setState({ inbox })),
      onMain('focus.session', ({ sessionId }) => {
        useStore.getState().selectSession(sessionId);
        useStore.getState().setTab('sessions');
      }),
    ];
    if (host.connected) void s.init();
    return () => offs.forEach((off) => off());
  }, []);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const s = useStore.getState();
      if (key === 'k') s.set({ paletteOpen: true });
      else if (key === 'n') s.set({ newSession: {} });
      else if (key === 'i') s.set({ inboxOpen: true });
      else if (key === ',') s.set({ settingsOpen: true });
      else if (key === 'o') void buildCommands().find((c) => c.id === 'workspace.open')?.run();
      else if (/^[1-6]$/.test(key)) s.setTab(TAB_ORDER[Number(key) - 1]!);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useWiring();
  useShortcuts();
  const tab = useStore((s) => s.tab);
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <ReconnectBanner />
      <div className="relative min-h-0 flex-1">
        {/* The sessions workspace stays mounted so its layout, terminals and scroll positions survive tab switches. */}
        <div className="absolute inset-0" hidden={tab !== 'sessions'}>
          <SessionsWorkspace />
        </div>
        {tab !== 'sessions' ? (
          <motion.div key={tab} className="absolute inset-0" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: 'easeOut' }}>
            {tab === 'work-items' ? <WorkItemsScreen /> : null}
            {tab === 'workflows' ? <WorkflowsScreen /> : null}
            {tab === 'skills' ? <SkillsScreen /> : null}
            {tab === 'terminals' ? <TerminalsScreen /> : null}
            {tab === 'run' ? <RunScreen /> : null}
            {tab === 'review' ? <ReviewScreen /> : null}
          </motion.div>
        ) : null}
      </div>
      <NewSessionDialog />
      <CommandPalette />
      <InboxDialog />
      <SettingsDialog />
      <FirstRunDialog />
      <ProtocolDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

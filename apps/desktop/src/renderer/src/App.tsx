import { GitScreen } from './components/GitScreen.tsx';
import { IntegrateScreen } from './components/IntegrateScreen.tsx';
import { McpDialog } from './components/McpDialog.tsx';
import { motion } from 'motion/react';
import { useEffect } from 'react';
import { ConfirmDialog } from './components/Modal.tsx';
import {
  CommandPalette,
  FirstRunDialog,
  InboxDialog,
  ProtocolDialog,
  ReconnectBanner,
  SettingsDialog,
  Toasts,
} from './components/Dialogs.tsx';
import { NewSessionDialog } from './components/NewSessionDialog.tsx';
import { ContinueCliDialog } from './components/ContinueCliDialog.tsx';
import { CompareDialog, HandOffDialog } from './components/ParallelDialogs.tsx';
import { RuleSuggestionDialog } from './components/RuleAdvice.tsx';
import { LessonDialog } from './components/Lessons.tsx';
import { SessionSearchDialog } from './components/HistoryTools.tsx';
import { ReviewScreen } from './components/ReviewScreen.tsx';
import { RunScreen } from './components/RunScreen.tsx';
import { ObserveScreen } from './components/observe/ObserveScreen.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { HelpCenter } from './components/HelpCenter.tsx';
import { SessionsWorkspace } from './components/SessionsWorkspace.tsx';
import { TerminalsScreen } from './components/terminal/TerminalsScreen.tsx';
import { TopBar } from './components/TopBar.tsx';
import { WorkflowsScreen } from './components/workflows/WorkflowsScreen.tsx';
import { SkillsScreen } from './components/SkillsScreen.tsx';
import { WorkItemsScreen } from './components/WorkItemsScreen.tsx';
import { host, onMain, pty } from './lib/bridge.ts';
import { buildCommands } from './lib/commands.ts';
import { pageForKey } from './lib/pages.ts';
import { TooltipProvider } from './components/Tooltip.tsx';
import { useStore } from './lib/store.ts';
import { onBlockFinished, wireTerminals } from './lib/terminals.ts';
import { wireRuns } from './lib/runs.ts';
import { recordBlock } from './lib/problems.ts';

// SM-11: every finished terminal command goes into the searchable history. SM-18: the same (single) listener reads
// the block for problems; a second onBlockFinished registration would replace this one.
onBlockFinished((terminal, block) => {
  const workspaceId = useStore.getState().workspaceId;
  void host
    .call('history.record', {
      workspaceId,
      sessionId: terminal.sessionId,
      command: block.command.slice(0, 10_000),
      cwd: block.cwd ?? terminal.cwd,
      exitCode: block.exitCode,
    })
    .catch(() => undefined);
  void recordBlock(terminal, block);
});


function useWiring() {
  useEffect(() => {
    const s = useStore.getState();
    const offs = [
      host.onConnection((up) => {
        useStore.setState((st) => ({ connection: { ...st.connection, host: up } }));
        if (up)
          void useStore
            .getState()
            .init()
            .catch((err: Error) => s.toast(err.message, 'danger'));
      }),
      pty.onConnection((up) => {
        useStore.setState((st) => ({ connection: { ...st.connection, pty: up } }));
        if (up) {
          wireTerminals();
          wireRuns();
        }
      }),
      host.on('session.event', (e) => useStore.getState().onEvent(e)),
      host.on('session.changed', ({ session }) => useStore.getState().upsertSession(session)),
      host.on('inbox.changed', (inbox) => useStore.setState({ inbox })),
      onMain('focus.inbox', () => useStore.getState().set({ inboxOpen: true })),
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
      if (e.key === 'F1') {
        e.preventDefault();
        useStore.getState().set({ helpOpen: true });
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const s = useStore.getState();
      if (key === 'k') s.set({ paletteOpen: true });
      else if (key === 'n') s.set({ newSession: {} });
      else if (key === 'i') s.set({ inboxOpen: true });
      else if (key === ',') s.set({ settingsOpen: true });
      else if (key === 'o')
        void buildCommands()
          .find((c) => c.id === 'workspace.open')
          ?.run();
      else if (/^[0-9]$/.test(key) && pageForKey(key)) s.setTab(pageForKey(key)!.tab);
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
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
    <div className="flex h-full flex-col">
      <TopBar />
      <ReconnectBanner />
      <div className="relative min-h-0 flex-1">
        {/* The sessions workspace stays mounted so its layout, terminals and scroll positions survive tab switches. */}
        <div className="absolute inset-0" hidden={tab !== 'sessions'}>
          <ErrorBoundary>
            <SessionsWorkspace />
          </ErrorBoundary>
        </div>
        {tab !== 'sessions' ? (
          <motion.div
            key={tab}
            className="absolute inset-0"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <ErrorBoundary>
              {tab === 'work-items' ? <WorkItemsScreen /> : null}
              {tab === 'workflows' ? <WorkflowsScreen /> : null}
              {tab === 'skills' ? <SkillsScreen /> : null}
              {tab === 'terminals' ? <TerminalsScreen /> : null}
              {tab === 'run' ? <RunScreen /> : null}
              {tab === 'review' ? <ReviewScreen /> : null}
            {tab === 'observe' ? <ObserveScreen /> : null}
              {tab === 'git' ? <GitScreen /> : null}
              {tab === 'integrate' ? <IntegrateScreen /> : null}
            </ErrorBoundary>
          </motion.div>
        ) : null}
      </div>
      <NewSessionDialog />
      <ContinueCliDialog />
      <CompareDialog />
      <SessionSearchDialog />
      <HandOffDialog />
      <CommandPalette />
      <HelpCenter />
      <InboxDialog />
      <SettingsDialog />
      <RuleSuggestionDialog />
      <LessonDialog />
      <McpDialog />
      <FirstRunDialog />
      <ProtocolDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
    </TooltipProvider>
  );
}

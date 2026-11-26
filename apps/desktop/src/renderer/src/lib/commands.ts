import { isLive, openItems } from '@ade/session-core';
import { redirectLoop } from './loops.ts';
import { askForProof, receiptsOf } from './receipts.ts';
import { host, main } from './bridge.ts';
import { PAGES } from './pages.ts';
import { defaultLayout, PANELS, showPanel, workspaceLayout } from './layout.ts';
import { reviewActions } from './review.ts';
import { attempt, useStore } from './store.ts';
import { fixNewProblems, latestProblems, problemKey, useProblems } from './problems.ts';
import { useTerminals } from './terminals.ts';

/** One action the user can take (Command pattern). Every action is reachable from the palette (UI rule). */
export interface Command {
  id: string;
  title: string;
  group: 'Workspace' | 'Session' | 'Navigate' | 'Terminal' | 'App';
  shortcut?: string;
  run: () => void | Promise<void>;
}


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
    ...PAGES.map((t, i) => ({ id: `nav.${t.tab}`, title: `Go to ${t.title}`, group: 'Navigate' as const, shortcut: `Ctrl ${i + 1}`, run: () => s.setTab(t.tab) })),
    ...PANELS.map((p) => ({
      id: `panel.${p.id}`,
      title: `Show the ${p.title.toLowerCase()} panel`,
      group: 'Navigate' as const,
      run: () => {
        s.setTab('sessions');
        if (workspaceLayout.api) showPanel(workspaceLayout.api, p.id);
      },
    })),
    {
      id: 'panel.reset',
      title: 'Reset the panel layout',
      group: 'Navigate',
      run: () => {
        s.setTab('sessions');
        if (workspaceLayout.api) defaultLayout(workspaceLayout.api);
      },
    },
    { id: 'app.help', title: 'Open the help centre', group: 'App', shortcut: 'F1', run: () => s.set({ helpOpen: true }) },
    { id: 'app.settings', title: 'Settings', group: 'App', shortcut: 'Ctrl ,', run: () => s.set({ settingsOpen: true }) },
    // AP-09: only while the open workspace has rule suggestions.
    ...(s.workspaceId && s.ruleAdvice[s.workspaceId]?.suggestions.length
      ? [{ id: 'workspace.rules.suggestions', title: 'Review rule suggestions', group: 'Workspace' as const, run: () => s.set({ settingsOpen: true, settingsSection: 'suggested-rules' as const }) }]
      : []),
    { id: 'app.mcp', title: 'MCP servers', group: 'App', run: () => s.set({ mcpOpen: true }) },
    { id: 'sessions.search', title: 'Search sessions', group: 'Session', run: () => s.set({ sessionSearchOpen: true }) },
    { id: 'app.setup', title: 'First-run setup', group: 'App', run: () => s.set({ firstRunOpen: true }) },
    { id: 'app.agents', title: 'Check agents again', group: 'App', run: () => s.refreshAgents(true) },
    { id: 'app.restart-host', title: 'Restart the host process', group: 'App', run: () => void main('main.restartProcess', { which: 'host' }) },
    { id: 'app.restart-pty', title: 'Restart the terminal process', group: 'App', run: () => void main('main.restartProcess', { which: 'pty' }) },
  ];
  // SM-18: on the active terminal's latest block that has problems; absent when there is none.
  const terms = useTerminals.getState();
  const problems = terms.active ? latestProblems(useProblems.getState().byBlock, terms.active, terms.blocks[terms.active] ?? []) : null;
  if (problems && problems.previousAt !== null && problems.counts.new > 0) {
    if (problems.sessionId) cmds.push({ id: 'terminal.problems.fix', title: 'Fix new problems with agent', group: 'Terminal', run: () => fixNewProblems(problems) });
    const key = problemKey(problems.terminalId, problems.blockId);
    cmds.push({
      id: 'terminal.problems.newOnly',
      title: problems.newOnly ? 'Show all problems' : 'Show new problems only',
      group: 'Terminal',
      run: () => {
        useProblems.getState().toggleNewOnly(key);
        s.setTab('terminals');
      },
    });
  }
  if (session) {
    if (isLive(session.state)) {
      cmds.push({ id: 'session.cancel', title: 'Cancel the running turn', group: 'Session', shortcut: 'Esc', run: () => void attempt(() => host.call('sessions.cancel', { sessionId: session.id })) });
    }
    const loop = s.activity[session.id]?.loop;
    if (loop) {
      cmds.push(
        { id: 'session.loop.redirect', title: 'Redirect the looping agent', group: 'Session', run: () => redirectLoop(session.id, loop) },
        { id: 'session.loop.dismiss', title: 'Dismiss the loop warning', group: 'Session', run: () => void attempt(() => host.call('sessions.dismissLoop', { sessionId: session.id })) },
      );
    }
    // RV-16: only while the session's receipts have something to check.
    const receiptOpen = openItems(receiptsOf(s.views[session.id]?.items ?? []));
    const latest = receiptOpen.at(-1);
    if (latest) {
      cmds.push(
        { id: 'session.receipt.proof', title: 'Ask the agent for proof', group: 'Session', run: () => askForProof(session.id, receiptOpen) },
        {
          id: 'session.receipt.checked',
          title: 'Mark the latest receipt as checked',
          group: 'Session',
          run: () => void attempt(() => host.call('sessions.acknowledgeReceipt', { sessionId: session.id, turnId: latest.turnId })),
        },
      );
    }
    cmds.push(
      { id: 'session.review', title: 'Review changes', group: 'Session', run: () => s.setTab('review') },
      { id: 'session.protocol', title: 'Show protocol messages', group: 'Session', run: () => s.set({ protocolSessionId: session.id }) },
    );
    // RV-15: only while the Review screen shows a live session (it registers these actions).
    const { mark, next } = reviewActions;
    if (s.tab === 'review' && mark && next) {
      cmds.push(
        { id: 'review.mark', title: 'Mark file as reviewed', group: 'Session', run: mark },
        { id: 'review.next', title: 'Go to the next unreviewed file', group: 'Session', run: next },
      );
    }
    if (session.worktreePath) {
      const path = session.worktreePath;
      cmds.push({ id: 'session.editor', title: 'Open worktree in my editor', group: 'Session', run: () => void attempt(() => main('main.openInEditor', { path })) });
    }
  }
  return cmds;
}

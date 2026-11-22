import type { Tab } from './store.ts';

/** The app's pages in top-bar order. Ctrl 1 to 8 follow this order everywhere (palette, tooltips, keys). */
export const PAGES: readonly { tab: Tab; title: string; description: string }[] = [
  { tab: 'sessions', title: 'Sessions', description: 'Agents at work, each in its own worktree' },
  { tab: 'work-items', title: 'Work items', description: 'Shortcut stories and GitHub issues assigned to you' },
  { tab: 'workflows', title: 'Workflows', description: 'Multi-step agent workflows with gates' },
  { tab: 'skills', title: 'Skills', description: 'Agent Skills for Codex, Claude Code and OpenCode' },
  { tab: 'terminals', title: 'Terminals', description: 'Smart and plain terminals in your worktrees' },
  { tab: 'run', title: 'Run', description: 'Run, test and build configurations' },
  { tab: 'review', title: 'Review', description: 'Review the changes of a session and land them' },
  { tab: 'observe', title: 'Observe', description: 'Watch every agent work, live, and see what it did' },
];

export const pageShortcut = (tab: Tab) => `Ctrl ${PAGES.findIndex((p) => p.tab === tab) + 1}`;

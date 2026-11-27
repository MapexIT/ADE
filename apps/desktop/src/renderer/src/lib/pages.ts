import type { Tab } from './store.ts';

/** The app's pages in top-bar order. Ctrl 1 to 9 follow this order everywhere (palette, tooltips, keys). */
export const PAGES: readonly { tab: Tab; title: string; description: string }[] = [
  { tab: 'sessions', title: 'Sessions', description: 'Agents at work, each in its own worktree' },
  { tab: 'work-items', title: 'Work items', description: 'Shortcut stories and GitHub issues assigned to you' },
  { tab: 'workflows', title: 'Workflows', description: 'Multi-step agent workflows with gates' },
  { tab: 'skills', title: 'Skills', description: 'Agent Skills for Codex, Claude Code and OpenCode' },
  { tab: 'terminals', title: 'Terminals', description: 'Smart and plain terminals in your worktrees' },
  { tab: 'run', title: 'Run', description: 'Run, test and build configurations' },
  { tab: 'review', title: 'Review', description: 'Review the changes of a session and land them' },
  { tab: 'observe', title: 'Observe', description: 'Watch every agent work, live, and see what it did' },
  { tab: 'git', title: 'Git', description: 'Branches and commits as a graph, with each commit in full' },
  { tab: 'integrate', title: 'Integrate', description: 'See how finished sessions fit together and land them in order' },
];

/** Ctrl 1 to 9 for the first nine pages; the tenth (Integrate) is Ctrl 0, the key after 9. */
export const pageKey = (index: number) => (index === 9 ? '0' : String(index + 1));
export const pageShortcut = (tab: Tab) => `Ctrl ${pageKey(PAGES.findIndex((p) => p.tab === tab))}`;
/** The page a Ctrl digit opens, if any. */
export const pageForKey = (key: string) => PAGES.find((_, i) => pageKey(i) === key);

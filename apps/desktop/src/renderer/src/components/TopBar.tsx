import { Activity, Bell, ChevronDown, CircleHelp, FolderGit2, GitFork, GitPullRequestArrow, ListTodo, MessagesSquare, Play, Search, Send, Settings, Sparkles, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Button, cx, Kbd, Logo } from '@ade/ui';
import { pickAndOpenWorkspace } from '../lib/commands.ts';
import { currentWorkspace, useStore, type Tab } from '../lib/store.ts';
import { PanelsMenu } from './PanelsMenu.tsx';
import { Tooltip } from './Tooltip.tsx';
import { PAGES, pageShortcut } from '../lib/pages.ts';
import { followTelegram, telegramSummary, useTelegram } from '../lib/telegram.ts';
import { useEffect } from 'react';
import { AgentPulse } from './observe/Teams.tsx';
import { CliStatus } from './CliStatus.tsx';

const PAGE_ICONS: Record<Tab, LucideIcon> = {
  sessions: MessagesSquare,
  'work-items': ListTodo,
  workflows: Workflow,
  skills: Sparkles,
  terminals: SquareTerminal,
  run: Play,
  review: GitPullRequestArrow,
  observe: Activity,
  git: GitFork,
};
const TABS = PAGES.map((p) => ({ ...p, label: p.title, Icon: PAGE_ICONS[p.tab] }));

export function TopBar() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const workspace = useStore(currentWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const inboxCount = useStore((s) => s.inbox.length);
  const set = useStore((s) => s.set);
  const telegram = useTelegram((t) => t.status);
  useEffect(() => followTelegram(), []);
  const telegramOn = !!telegram?.enabled && telegram.tokenStored && telegram.passwordSet;
  const telegramText = telegramSummary(telegram);

  return (
    <header className="relative z-10 flex h-13 shrink-0 flex-nowrap items-center gap-3 border-b border-line bg-[var(--surface-glass)] px-4 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-2 font-semibold tracking-[0.12em]" aria-label="ADE">
        <Logo size={24} className="drop-shadow-[0_0_10px_var(--accent-glow)]" />
        <span aria-hidden="true" className="hidden lg:inline">
          ADE
        </span>
      </span>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button size="dense" className="max-w-56 shrink-0 font-semibold" aria-label="Switch workspace" icon={<FolderGit2 className="size-4 shrink-0 text-accent-soft" aria-hidden="true" />}>
            <span className="truncate">{workspace?.name ?? 'No workspace'}</span>
            <ChevronDown className="size-3.5 text-ink-muted" aria-hidden="true" />
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content sideOffset={6} className="z-50 min-w-64 rounded-[var(--radius)] ade-pop border border-line bg-[var(--surface-glass)] p-1 shadow-[var(--shadow-pop)] backdrop-blur-xl">
            {workspaces.map((w) => (
              <Menu.Item
                key={w.id}
                onSelect={() => void selectWorkspace(w.id)}
                className="flex min-h-9 cursor-pointer flex-col justify-center rounded px-3 py-1 outline-none data-[highlighted]:bg-accent-tint"
              >
                <span className={cx(w.id === workspace?.id && 'font-semibold')}>{w.name}</span>
                <span className="font-mono text-[11px] text-ink-muted">{w.rootPath}</span>
              </Menu.Item>
            ))}
            {workspaces.length ? <Menu.Separator className="my-1 h-px bg-line" /> : null}
            <Menu.Item onSelect={() => void pickAndOpenWorkspace()} className="flex min-h-9 cursor-pointer items-center rounded px-3 outline-none data-[highlighted]:bg-accent-tint">
              Open repository…
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>

      <nav aria-label="Main" className="flex min-w-0 shrink gap-1 overflow-x-auto rounded-[var(--radius)] border border-line bg-surface-sunken/70 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <Tooltip key={t.tab} label={t.label} description={t.description} shortcut={pageShortcut(t.tab)}>
          <button
            type="button"
            aria-current={tab === t.tab ? 'page' : undefined}
            aria-label={t.label}
            onClick={() => setTab(t.tab)}
            className={cx(
              'flex min-h-8 shrink-0 items-center gap-2 rounded-[var(--radius-small)] px-2.5 2xl:px-3',
              tab === t.tab
                ? 'bg-accent-tint font-semibold text-ink shadow-[inset_0_0_0_1px_rgb(139_92_246/0.55)]'
                : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
            )}
          >
            <t.Icon className="size-4" aria-hidden="true" />
            <span className="hidden 2xl:inline">{t.label}</span>
          </button>
          </Tooltip>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
        <AgentPulse />
        {tab === 'sessions' ? <PanelsMenu /> : null}
        <Button size="dense" variant={inboxCount ? 'attention' : 'secondary'} onClick={() => set({ inboxOpen: true })} aria-label={`Needs you: ${inboxCount}`} icon={<Bell className="size-4" aria-hidden="true" />}>
          <span className="hidden xl:inline">Needs you:</span> {inboxCount}
        </Button>
        {telegram?.tokenStored ? (
          <Tooltip label="Telegram notifications" description={`${telegramText}. Click to change it in Settings.`}>
            <Button
              size="dense"
              variant={telegramOn ? 'secondary' : 'ghost'}
              className={cx('relative w-9 px-0', telegramOn ? 'text-accent-soft' : 'text-ink-muted')}
              onClick={() => set({ settingsOpen: true })}
              aria-label={`Telegram notifications: ${telegramText}`}
            >
              <Send className="size-4" aria-hidden="true" />
              <span
                aria-hidden="true"
                className={cx('absolute top-1.5 right-1.5 size-2 rounded-full border', telegramOn ? (telegram?.lastError ? 'border-accent bg-transparent' : 'border-accent bg-accent') : 'border-line-strong bg-transparent')}
              />
            </Button>
          </Tooltip>
        ) : null}
        <Tooltip label="Help centre" description="Every feature, with search and shortcuts" shortcut="F1">
          <Button size="dense" variant="ghost" onClick={() => set({ helpOpen: true })} aria-label="Help centre" icon={<CircleHelp className="size-5" aria-hidden="true" />}>
            <span className="hidden lg:inline">Help</span>
          </Button>
        </Tooltip>
        <Tooltip label="Settings" description="Agents, connectors, notifications and more" shortcut="Ctrl ,">
          <Button size="dense" variant="ghost" onClick={() => set({ settingsOpen: true })} aria-label="Settings" icon={<Settings className="size-5" aria-hidden="true" />}>
            <span className="hidden lg:inline">Settings</span>
          </Button>
        </Tooltip>
        <Button size="dense" variant="secondary" className="text-ink-muted" onClick={() => set({ paletteOpen: true })} title="Search and commands (Ctrl K)" icon={<Search className="size-4" aria-hidden="true" />}>
          <span className="sr-only lg:not-sr-only">Search</span>
          <span className="sr-only"> and commands</span>
          <span className="hidden xl:inline">
            <Kbd>Ctrl K</Kbd>
          </span>
        </Button>
        <CliStatus />
      </div>
    </header>
  );
}

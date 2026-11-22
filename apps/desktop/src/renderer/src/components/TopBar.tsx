import { Bell, Bot, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleHelp, FolderGit2, GitPullRequestArrow, ListTodo, MessagesSquare, Play, Search, Sparkles, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Badge, Button, cx, Kbd, Logo } from '@ade/ui';
import { pickAndOpenWorkspace } from '../lib/commands.ts';
import { currentWorkspace, useStore, type Tab } from '../lib/store.ts';
import { PanelsMenu } from './PanelsMenu.tsx';

const TABS: { tab: Tab; label: string; Icon: LucideIcon }[] = [
  { tab: 'sessions', label: 'Sessions', Icon: MessagesSquare },
  { tab: 'work-items', label: 'Work items', Icon: ListTodo },
  { tab: 'workflows', label: 'Workflows', Icon: Workflow },
  { tab: 'skills', label: 'Skills', Icon: Sparkles },
  { tab: 'terminals', label: 'Terminals', Icon: SquareTerminal },
  { tab: 'run', label: 'Run', Icon: Play },
  { tab: 'review', label: 'Review', Icon: GitPullRequestArrow },
];

export function TopBar() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const workspace = useStore(currentWorkspace);
  const workspaces = useStore((s) => s.workspaces);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const inboxCount = useStore((s) => s.inbox.length);
  const agents = useStore((s) => s.agents);
  const set = useStore((s) => s.set);

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

      <nav aria-label="Main" className="flex min-w-0 shrink gap-1 overflow-x-auto rounded-[var(--radius)] border border-line bg-surface-sunken/70 p-1 [scrollbar-width:none]">
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            aria-current={tab === t.tab ? 'page' : undefined}
            aria-label={t.label}
            title={t.label}
            onClick={() => setTab(t.tab)}
            className={cx(
              'flex min-h-8 shrink-0 items-center gap-2 rounded-[var(--radius-small)] px-2.5 xl:px-3',
              tab === t.tab
                ? 'bg-accent-tint font-semibold text-ink shadow-[inset_0_0_0_1px_rgb(139_92_246/0.55)]'
                : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
            )}
          >
            <t.Icon className="size-4" aria-hidden="true" />
            <span className="hidden xl:inline">{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
        {tab === 'sessions' ? <PanelsMenu /> : null}
        <Button size="dense" variant={inboxCount ? 'attention' : 'secondary'} onClick={() => set({ inboxOpen: true })} aria-label={`Needs you: ${inboxCount}`} icon={<Bell className="size-4" aria-hidden="true" />}>
          <span className="hidden xl:inline">Needs you:</span> {inboxCount}
        </Button>
        <Button size="dense" variant="ghost" className="w-9 px-0" onClick={() => set({ helpOpen: true })} aria-label="Help centre" title="Help centre (F1)">
          <CircleHelp className="size-4" aria-hidden="true" />
        </Button>
        <Button size="dense" variant="secondary" className="text-ink-muted" onClick={() => set({ paletteOpen: true })} title="Search and commands (Ctrl K)" icon={<Search className="size-4" aria-hidden="true" />}>
          <span className="sr-only lg:not-sr-only">Search</span>
          <span className="sr-only"> and commands</span>
          <span className="hidden xl:inline">
            <Kbd>Ctrl K</Kbd>
          </span>
        </Button>
        {(() => {
          // Below 2xl one summary keeps the bar on a single row; the full list is in its tooltip.
          const real = agents.filter((a) => a.id !== 'fake');
          const ready = real.filter((a) => a.health === 'ready').length;
          const detail = real.map((a) => `${a.label}: ${a.health === 'ready' ? 'ready' : a.health === 'needs-sign-in' ? 'needs sign-in' : 'not installed'}`).join('\n');
          return real.length ? (
            <Badge tone={ready ? 'ok' : 'neutral'} className="hidden lg:inline-flex 2xl:hidden" title={detail} aria-label={detail}>
              <Bot className="size-3.5" aria-hidden="true" />
              {ready}/{real.length} agents ready
            </Badge>
          ) : null;
        })()}
        <div className="hidden flex-wrap gap-1.5 2xl:flex" aria-label="Agents">
          {agents
            .filter((a) => a.id !== 'fake')
            .map((a) => (
              <Badge key={a.id} tone={a.health === 'ready' ? 'ok' : a.health === 'needs-sign-in' ? 'attention' : 'neutral'} title={a.reason ?? a.version ?? undefined}>
                {a.health === 'ready' ? <CircleCheck className="size-3.5" aria-hidden="true" /> : a.health === 'needs-sign-in' ? <CircleAlert className="size-3.5" aria-hidden="true" /> : <CircleDashed className="size-3.5" aria-hidden="true" />}
                {a.label} {a.health === 'ready' ? 'ready' : a.health === 'needs-sign-in' ? 'needs sign-in' : 'not installed'}
              </Badge>
            ))}
        </div>
      </div>
    </header>
  );
}

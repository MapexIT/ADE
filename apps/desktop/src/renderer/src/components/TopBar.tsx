import * as Menu from '@radix-ui/react-dropdown-menu';
import { Badge, Button, cx, Kbd } from '@ade/ui';
import { pickAndOpenWorkspace } from '../lib/commands.ts';
import { currentWorkspace, useStore, type Tab } from '../lib/store.ts';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'sessions', label: 'Sessions' },
  { tab: 'work-items', label: 'Work items' },
  { tab: 'workflows', label: 'Workflows' },
  { tab: 'terminals', label: 'Terminals' },
  { tab: 'run', label: 'Run' },
  { tab: 'review', label: 'Review' },
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
    <header className="flex min-h-12 flex-wrap items-center gap-3 border-b border-line bg-surface px-4">
      <span className="font-semibold tracking-[0.08em]" aria-label="ADE">
        ADE
      </span>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button size="dense" className="font-semibold" aria-label="Switch workspace">
            {workspace?.name ?? 'No workspace'}
            <span aria-hidden="true" className="text-ink-muted">
              ▾
            </span>
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content sideOffset={6} className="z-50 min-w-64 rounded-[var(--radius)] border border-line bg-surface p-1 shadow-xl">
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

      <nav aria-label="Main" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.tab}
            type="button"
            aria-current={tab === t.tab ? 'page' : undefined}
            onClick={() => setTab(t.tab)}
            className={cx(
              'flex min-h-12 items-center border-b-2 px-3',
              tab === t.tab ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button size="dense" variant={inboxCount ? 'attention' : 'secondary'} onClick={() => set({ inboxOpen: true })} aria-label={`Needs you: ${inboxCount}`}>
          Needs you: {inboxCount}
        </Button>
        <Button size="dense" variant="secondary" className="text-ink-muted" onClick={() => set({ paletteOpen: true })}>
          Search and commands <Kbd>Ctrl K</Kbd>
        </Button>
        <div className="hidden flex-wrap gap-1.5 xl:flex" aria-label="Agents">
          {agents
            .filter((a) => a.id !== 'fake')
            .map((a) => (
              <Badge key={a.id} tone={a.health === 'ready' ? 'ok' : a.health === 'needs-sign-in' ? 'attention' : 'neutral'} title={a.reason ?? a.version ?? undefined}>
                {a.label} {a.health === 'ready' ? 'ready' : a.health === 'needs-sign-in' ? 'needs sign-in' : 'not installed'}
              </Badge>
            ))}
        </div>
      </div>
    </header>
  );
}

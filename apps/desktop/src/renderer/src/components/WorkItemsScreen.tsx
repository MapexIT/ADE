import { ExternalLink, FolderGit2, Play } from 'lucide-react';
import { Badge, Button, cx, EmptyState, Tabs, Waiting } from '@ade/ui';
import type { WorkItem, WorkItemRole } from '@ade/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';
import { BoardView } from './BoardView.tsx';
import { ConnectionGuide } from './ConnectionGuide.tsx';

type Column = { items: WorkItem[] | null; error: string | null };
const ROLES: { role: WorkItemRole; title: string; empty: string }[] = [
  { role: 'owner', title: 'I own', empty: 'Nothing open that you own.' },
  { role: 'requester', title: 'I requested', empty: 'Nothing open that you requested.' },
  { role: 'team', title: 'My teams', empty: 'Nothing open in your teams.' },
];
const IDLE: Column = { items: null, error: null };

/** The repository of a GitHub ref (`owner/name#12`). */
const repoOf = (i: WorkItem) => (i.source === 'github' ? (i.ref.split('#')[0] ?? null) : null);

/**
 * Screen 5 (CO-01 to CO-04): Assigned to me shows three columns, the items the user owns, the ones they requested,
 * and their teams' items grouped by team, from Shortcut or GitHub. Board is the CO-09 board. Read scope only.
 */
export function WorkItemsScreen() {
  const [source, setSource] = useState<WorkItem['source']>('shortcut');
  const [query, setQuery] = useState('');
  const [columns, setColumns] = useState<Record<WorkItemRole, Column>>({ owner: IDLE, requester: IDLE, team: IDLE });
  const [connected, setConnected] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'board'>('list');
  /** GitHub items can be narrowed to one repository. */
  const [repo, setRepo] = useState<string>('');
  const workspaceId = useStore((s) => s.workspaceId);
  const sessions = useStore((s) => s.sessions);

  const [checked, setChecked] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  useEffect(() => {
    void host
      .call('workItems.sources', {})
      .then(
        (s) => setConnected(s.filter((x) => x.connected).map((x) => x.source)),
        () => setConnected([]),
      )
      .finally(() => setChecked(true));
  }, [epoch]);

  const sourceConnected = connected.includes(source);
  useEffect(() => {
    setColumns({ owner: IDLE, requester: IDLE, team: IDLE });
    // An unconnected source shows the connection guide; asking it for items would only fail.
    if (!checked || !sourceConnected || view !== 'list') return;
    let live = true;
    const t = setTimeout(() => {
      for (const { role } of ROLES) {
        host.call('workItems.list', { source, query, role }).then(
          (items) => live && setColumns((c) => ({ ...c, [role]: { items, error: null } })),
          (err: Error) => live && setColumns((c) => ({ ...c, [role]: { items: [], error: err.message } })),
        );
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, query, epoch, checked, sourceConnected, view]);

  const linked = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of Object.values(sessions)) if (s.workItemRef) m.set(s.workItemRef, (m.get(s.workItemRef) ?? 0) + 1);
    return m;
  }, [sessions]);

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const c of Object.values(columns)) for (const i of c.items ?? []) if (repoOf(i)) set.add(repoOf(i)!);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [columns]);
  const filter = (items: WorkItem[]) => (source === 'github' && repo ? items.filter((i) => repoOf(i) === repo) : items);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 pt-2">
        <Tabs
          label="View"
          value={view}
          onChange={setView}
          items={[
            { value: 'list', label: 'Assigned to me' },
            { value: 'board', label: 'Board' },
          ]}
        />
      </div>
      {view === 'list' ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
          <Segmented
            label="Source"
            value={source}
            onChange={(v) => {
              setSource(v);
              setRepo('');
            }}
            items={[
              { value: 'shortcut', label: 'Shortcut' },
              { value: 'github', label: 'GitHub' },
            ]}
          />
          {source === 'github' && sourceConnected ? (
            <>
              <label htmlFor="wi-repo" className="sr-only">
                Repository
              </label>
              <select id="wi-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={cx(inputClass, 'min-h-9 w-64')}>
                <option value="">All repositories</option>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <label htmlFor="wi-search" className="sr-only">
            Search work items
          </label>
          <input
            id="wi-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or id"
            className={`${inputClass} ml-auto w-72 max-w-full`}
          />
        </div>
      ) : null}
      <div className={cx('min-h-0 min-w-0 flex-1 p-4', view === 'board' ? 'flex flex-col overflow-hidden' : 'overflow-auto lg:overflow-hidden')}>
        {view === 'board' ? (
          workspaceId ? (
            <BoardView workspaceId={workspaceId} />
          ) : (
            <EmptyState icon={<FolderGit2 className="size-5" />} title="Open a repository" body="The board shows which items have sessions in this repository." />
          )
        ) : checked && !sourceConnected ? (
          <ConnectionGuide key={source} source={source} onChecked={refresh} />
        ) : (
          <div className="grid gap-4 lg:h-full lg:grid-cols-3">
            {ROLES.map(({ role, title, empty }) => (
              <RoleColumn key={role} title={title} empty={empty} column={columns[role]} filter={filter} byTeam={role === 'team'} linked={linked} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One of the three columns. Owner and requester items are grouped by state; team items by team. */
function RoleColumn({
  title,
  empty,
  column,
  filter,
  byTeam,
  linked,
}: {
  title: string;
  empty: string;
  column: Column;
  filter: (items: WorkItem[]) => WorkItem[];
  byTeam: boolean;
  linked: Map<string, number>;
}) {
  const items = column.items ? filter(column.items) : null;
  const groups = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const i of items ?? []) {
      const key = byTeam ? (i.group ?? 'No team') : i.state;
      m.set(key, [...(m.get(key) ?? []), i]);
    }
    return [...m.entries()];
  }, [items, byTeam]);

  return (
    <section aria-label={title} className="flex min-h-0 flex-col gap-3 rounded-[var(--radius)] bg-surface-sunken p-3">
      <h2 className="m-0 text-[14px] font-semibold">
        {title}
        {items ? <span className="font-normal text-ink-muted"> · {items.length}</span> : null}
      </h2>
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:overflow-y-auto">
        {items === null ? (
          <Waiting>Loading…</Waiting>
        ) : column.error ? (
          <p role="alert" className="m-0 text-ink-muted">
            {column.error}
          </p>
        ) : items.length === 0 ? (
          <p className="m-0 text-ink-muted">{empty}</p>
        ) : (
          groups.map(([name, list]) => (
            <section key={name} aria-label={name} className="flex flex-col gap-2">
              <h3 className="m-0 text-[12px] font-semibold text-ink-muted">
                {name} · {list.length}
              </h3>
              {list.map((i) => (
                <ItemCard key={i.ref} item={i} sessions={linked.get(i.ref) ?? 0} detail={byTeam ? i.state : (i.source === 'github' ? repoOf(i) : i.group)} />
              ))}
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function ItemCard({ item, sessions, detail }: { item: WorkItem; sessions: number; detail: string | null }) {
  const set = useStore((s) => s.set);
  return (
    <article className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-ink-muted">{item.ref}</span>
        {sessions ? <Badge tone="accent">{sessions} session(s)</Badge> : null}
      </div>
      <span className="font-semibold">{item.title}</span>
      {detail ? <span className="text-[12px] text-ink-muted">{detail}</span> : null}
      <div className="flex flex-wrap gap-2">
        <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" variant="primary" onClick={() => set({ newSession: { workItem: item } })}>
          Start a session
        </Button>
        {item.url ? (
          <Button icon={<ExternalLink className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => void attempt(() => main('main.openExternal', { url: item.url! }))}>
            Open
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** A small single-choice switch, used for the source under "Assigned to me". Arrow keys move the choice. */
function Segmented<T extends string>({ label, value, onChange, items }: { label: string; value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  const move = (dir: number) => {
    const i = items.findIndex((it) => it.value === value);
    const next = items[(i + dir + items.length) % items.length]!;
    onChange(next.value);
    requestAnimationFrame(() => document.getElementById(`seg-${label}-${next.value}`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-[var(--radius)] border border-line bg-surface-sunken p-0.5">
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            id={`seg-${label}-${it.value}`}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!dir) return;
              e.preventDefault();
              move(dir);
            }}
            className={cx(
              'min-h-8 rounded-[var(--radius-small)] px-3 text-[13px] transition-colors duration-[var(--motion)]',
              on ? 'bg-accent-tint font-semibold text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

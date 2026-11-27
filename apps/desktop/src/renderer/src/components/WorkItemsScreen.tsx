import { ArrowLeft, ChevronRight, ExternalLink, FolderGit2, Inbox, Play } from 'lucide-react';
import { Badge, Button, cx, EmptyState, Tabs, Waiting } from '@ade/ui';
import type { WorkItem } from '@ade/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';
import { BoardView } from './BoardView.tsx';
import { ConnectionGuide } from './ConnectionGuide.tsx';

/** Screen 5: Shortcut stories and GitHub issues, start a session from one (CO-01 to CO-04). Read scope only. */
export function WorkItemsScreen() {
  const [source, setSource] = useState<WorkItem['source']>('shortcut');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'board'>('list');
  /** CO-02: GitHub items are picked by repository first. */
  const [repo, setRepo] = useState<string | null>(null);
  const workspaceId = useStore((s) => s.workspaceId);
  const sessions = useStore((s) => s.sessions);
  const set = useStore((s) => s.set);

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
    setItems(null);
    if (!checked) return;
    // An unconnected source shows the connection guide; asking it for items would only raise an error toast.
    if (!sourceConnected) return setItems([]);
    const t = setTimeout(
      () => void attempt(() => host.call('workItems.list', { source, query })).then((i) => setItems(i ?? [])),
      200,
    );
    return () => clearTimeout(t);
  }, [source, query, epoch, checked, sourceConnected]);

  const linked = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of Object.values(sessions))
      if (s.workItemRef) m.set(s.workItemRef, (m.get(s.workItemRef) ?? 0) + 1);
    return m;
  }, [sessions]);

  const byRepo = source === 'github';
  const repos = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items ?? []) if (i.group) m.set(i.group, (m.get(i.group) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  const shown = useMemo(
    () => (byRepo ? (items ?? []).filter((i) => i.group === repo) : (items ?? [])),
    [items, byRepo, repo],
  );

  const groups = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const i of shown) m.set(i.state, [...(m.get(i.state) ?? []), i]);
    return [...m.entries()];
  }, [shown]);

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
              setRepo(null);
            }}
            items={[
              { value: 'shortcut', label: 'Shortcut' },
              { value: 'github', label: 'GitHub' },
            ]}
          />
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
      <div className={cx('min-h-0 min-w-0 flex-1 p-4', view === 'board' ? 'flex flex-col overflow-hidden' : 'overflow-auto')}>
        {view === 'board' ? (
          workspaceId ? (
            <BoardView workspaceId={workspaceId} />
          ) : (
            <EmptyState
              icon={<FolderGit2 className="size-5" />}
              title="Open a repository"
              body="The board shows which items have sessions in this repository."
            />
          )
        ) : checked && !sourceConnected ? (
          <ConnectionGuide key={source} source={source} onChecked={refresh} />
        ) : items === null ? (
          <Waiting>Loading…</Waiting>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title="Nothing assigned to you"
            body="Work items assigned to you appear here, grouped by state."
          />
        ) : byRepo && !repo ? (
          <section aria-label="Repositories" className="flex max-w-2xl flex-col gap-2">
            <h2 className="m-0 text-[13px] font-semibold text-ink-muted">
              Choose a repository · {repos.length}
            </h2>
            {repos.map(([name, count]) => (
              <button
                key={name}
                type="button"
                onClick={() => setRepo(name)}
                className="flex items-center gap-3 rounded-[var(--radius)] border border-line bg-surface px-3 py-2.5 text-left transition-colors duration-[var(--motion)] hover:border-accent"
              >
                <FolderGit2 className="size-4 shrink-0 text-accent-soft" aria-hidden="true" />
                <span className="flex-1 font-semibold">{name}</span>
                <Badge>{count} assigned</Badge>
                <ChevronRight className="size-4 text-ink-muted" aria-hidden="true" />
              </button>
            ))}
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {byRepo ? (
              <div className="flex items-center gap-2">
                <Button
                  size="dense"
                  variant="ghost"
                  icon={<ArrowLeft className="size-4" aria-hidden="true" />}
                  onClick={() => setRepo(null)}
                >
                  All repositories
                </Button>
                <h2 className="m-0 text-[14px] font-semibold">{repo}</h2>
              </div>
            ) : null}
            {shown.length === 0 ? (
              <p className="m-0 text-ink-muted">Nothing here matches the search.</p>
            ) : null}
            <div className="grid gap-4 xl:grid-cols-3">
              {groups.map(([state, list]) => (
                <section key={state} className="flex flex-col gap-2" aria-label={state}>
                  <h2 className="m-0 text-[13px] font-semibold text-ink-muted">
                    {state} · {list.length}
                  </h2>
                  {list.map((i) => (
                    <article
                      key={i.ref}
                      className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px] text-ink-muted">{i.ref}</span>
                        {linked.get(i.ref) ? (
                          <Badge tone="accent">{linked.get(i.ref)} session(s)</Badge>
                        ) : null}
                      </div>
                      <span className="font-semibold">{i.title}</span>
                      {i.group && !byRepo ? (
                        <span className="text-[12px] text-ink-muted">{i.group}</span>
                      ) : null}
                      <div className="flex gap-2">
                        <Button
                          icon={<Play className="size-4" aria-hidden="true" />}
                          size="dense"
                          variant="primary"
                          onClick={() => set({ newSession: { workItem: i } })}
                        >
                          Start a session
                        </Button>
                        {i.url ? (
                          <Button
                            icon={<ExternalLink className="size-4" aria-hidden="true" />}
                            size="dense"
                            variant="ghost"
                            onClick={() => void attempt(() => main('main.openExternal', { url: i.url! }))}
                          >
                            Open
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
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

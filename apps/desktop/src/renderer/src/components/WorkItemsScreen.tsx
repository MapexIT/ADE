import { Badge, Button, EmptyState, Tabs } from '@ade/ui';
import type { WorkItem } from '@ade/contracts';
import { useEffect, useMemo, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';
import { BoardView } from './BoardView.tsx';

/** Screen 5: Shortcut stories and GitHub issues, start a session from one (CO-01 to CO-04). Read scope only. */
export function WorkItemsScreen() {
  const [source, setSource] = useState<WorkItem['source']>('shortcut');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'board'>('list');
  const workspaceId = useStore((s) => s.workspaceId);
  const sessions = useStore((s) => s.sessions);
  const set = useStore((s) => s.set);

  useEffect(() => {
    void host.call('workItems.sources', {}).then((s) => setConnected(s.filter((x) => x.connected).map((x) => x.source)), () => setConnected([]));
  }, []);

  useEffect(() => {
    setItems(null);
    const t = setTimeout(() => void attempt(() => host.call('workItems.list', { source, query })).then((i) => setItems(i ?? [])), 200);
    return () => clearTimeout(t);
  }, [source, query]);

  const linked = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of Object.values(sessions)) if (s.workItemRef) m.set(s.workItemRef, (m.get(s.workItemRef) ?? 0) + 1);
    return m;
  }, [sessions]);

  const groups = useMemo(() => {
    const m = new Map<string, WorkItem[]>();
    for (const i of items ?? []) m.set(i.state, [...(m.get(i.state) ?? []), i]);
    return [...m.entries()];
  }, [items]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 pt-2">
        <Tabs
          label="Source"
          value={source}
          onChange={setSource}
          items={[
            { value: 'shortcut', label: 'Shortcut' },
            { value: 'github', label: 'GitHub' },
          ]}
        />
        <Tabs
          label="View"
          value={view}
          onChange={setView}
          items={[
            { value: 'list', label: 'Assigned to me' },
            { value: 'board', label: 'Board' },
          ]}
        />
        <label htmlFor="wi-search" className="sr-only">
          Search work items
        </label>
        <input id="wi-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by title or id" className={`${inputClass} mb-2 ml-auto min-w-72`} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {view === 'board' ? (
          workspaceId ? <BoardView workspaceId={workspaceId} /> : <EmptyState title="Open a repository" body="The board shows which items have sessions in this repository." />
        ) : !connected.includes(source) && (items?.length ?? 0) === 0 ? (
          <EmptyState
            title={`${source === 'shortcut' ? 'Shortcut' : 'GitHub'} is not connected`}
            body="Connect it in settings to browse the stories and issues assigned to you. ADE asks for read scope only, and the token stays in your system's credential store."
            action={<Button onClick={() => set({ settingsOpen: true })}>Open settings</Button>}
          />
        ) : items === null ? (
          <p className="text-ink-muted">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing assigned to you" body="Work items assigned to you appear here, grouped by state." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            {groups.map(([state, list]) => (
              <section key={state} className="flex flex-col gap-2" aria-label={state}>
                <h2 className="m-0 text-[13px] font-semibold text-ink-muted">
                  {state} · {list.length}
                </h2>
                {list.map((i) => (
                  <article key={i.ref} className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12px] text-ink-muted">{i.ref}</span>
                      {linked.get(i.ref) ? <Badge tone="accent">{linked.get(i.ref)} session(s)</Badge> : null}
                    </div>
                    <span className="font-semibold">{i.title}</span>
                    {i.group ? <span className="text-[12px] text-ink-muted">{i.group}</span> : null}
                    <div className="flex gap-2">
                      <Button size="dense" variant="primary" onClick={() => set({ newSession: { workItem: i } })}>
                        Start a session
                      </Button>
                      {i.url ? (
                        <Button size="dense" variant="ghost" onClick={() => void attempt(() => main('main.openExternal', { url: i.url! }))}>
                          Open
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

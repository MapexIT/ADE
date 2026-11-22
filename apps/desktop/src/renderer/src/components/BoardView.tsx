import { CircleAlert } from 'lucide-react';
import { Badge, Button, cx, EmptyState } from '@ade/ui';
import type { Board, BoardSettings } from '@ade/contracts';
import { STATE_LABELS } from '@ade/session-core';
import { useCallback, useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';

/** CO-09: the current Shortcut iteration or a GitHub Projects board, with a badge for every session on an item. */
export function BoardView({ workspaceId }: { workspaceId: string }) {
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      setBoard(await host.call('board.get', { workspaceId }));
    } catch (err) {
      setBoard(null);
      setProblem((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void host.call('board.settings', { workspaceId }).then(setSettings);
    void load();
  }, [workspaceId, load]);

  const save = async (next: BoardSettings) => {
    setSettings(next);
    if (await attempt(() => host.call('board.save', { workspaceId, settings: next }))) void load();
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {settings ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
            Board
            <select value={settings.source} onChange={(e) => void save({ ...settings, source: e.target.value as BoardSettings['source'] })} className={cx(inputClass, 'min-h-9')}>
              <option value="shortcut">Current Shortcut iteration</option>
              <option value="github">GitHub project</option>
            </select>
          </label>
          {settings.source === 'github' ? (
            <>
              <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
                Owner
                <input defaultValue={settings.githubOwner ?? ''} placeholder="@me or an organisation" onBlur={(e) => void save({ ...settings, githubOwner: e.target.value.trim() || null })} className={cx(inputClass, 'min-h-9 w-48')} />
              </label>
              <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
                Project number
                <input type="number" min={1} defaultValue={settings.githubProject ?? ''} onBlur={(e) => void save({ ...settings, githubProject: Number(e.target.value) || null })} className={cx(inputClass, 'min-h-9 w-28')} />
              </label>
            </>
          ) : null}
          <Button size="dense" disabled={loading} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      ) : null}
      {problem ? (
        <EmptyState icon={<CircleAlert className="size-5" />} title="The board could not be loaded" body={problem} action={<Button onClick={() => set({ settingsOpen: true })}>Open settings</Button>} />
      ) : board ? (
        <>
          <h2 className="m-0 text-[14px] font-semibold">{board.title}</h2>
          {board.columns.length === 0 ? <p className="m-0 text-ink-muted">No items on this board.</p> : null}
          <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
            {board.columns.map((col) => (
              <section key={col.name} aria-label={col.name} className="flex w-72 shrink-0 flex-col gap-2 rounded-[var(--radius)] bg-surface-sunken p-2">
                <h3 className="m-0 px-1 text-[12px] font-semibold text-ink-muted">
                  {col.name} · {col.items.length}
                </h3>
                {col.items.map((item) => (
                  <article key={item.ref} className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-line bg-surface p-2.5">
                    <span className="font-mono text-[11.5px] text-ink-muted">{item.ref}</span>
                    <span className="font-semibold">{item.title}</span>
                    <div className="flex flex-wrap gap-1">
                      {item.sessions.map((s) => (
                        <button key={s.id} type="button" onClick={() => { selectSession(s.id); set({ tab: 'sessions' }); }} className="rounded-full">
                          <Badge tone="accent" title={s.title}>
                            {STATE_LABELS[s.state as keyof typeof STATE_LABELS] ?? s.state}
                          </Badge>
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button size="dense" onClick={() => set({ newSession: { workItem: { ref: item.ref, source: item.ref.startsWith('sc-') ? 'shortcut' : 'github', title: item.title, description: '', state: col.name, url: item.url, group: board.title } } })}>
                        Start a session
                      </Button>
                      {item.url ? (
                        <Button size="dense" variant="ghost" onClick={() => void attempt(() => main('main.openExternal', { url: item.url! }))}>
                          Open
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="m-0 text-ink-muted">Loading…</p>
      )}
    </div>
  );
}

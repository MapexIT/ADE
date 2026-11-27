import { CircleAlert, ExternalLink, FolderGit2, Play, RefreshCw, Settings } from 'lucide-react';
import { Badge, Button, cx, EmptyState, Waiting } from '@ade/ui';
import type { Board, BoardSettings } from '@ade/contracts';
import { STATE_LABELS } from '@ade/session-core';
import { useCallback, useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { ConnectionGuide } from './ConnectionGuide.tsx';
import { inputClass } from './Modal.tsx';

/** CO-09: the Shortcut stories the user owns or a GitHub board, with a badge for every session on an item. */
export function BoardView({ workspaceId }: { workspaceId: string }) {
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [repos, setRepos] = useState<{ current: string | null; repos: string[] } | null>(null);
  const [projects, setProjects] = useState<{ projects: { owner: string; number: number; title: string }[]; problem: string | null } | null>(null);
  const github = settings?.source === 'github';
  const repo = settings?.githubRepo ?? null;
  // CO-09: a GitHub board needs a repository first; nothing loads until one is chosen.
  const needsRepo = github && !repo;

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
  }, [workspaceId]);

  useEffect(() => {
    if (settings && !needsRepo) void load();
  }, [settings?.source, repo, settings?.githubProject, needsRepo, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!github || repos) return;
    void host.call('board.repositories', { workspaceId }).then(setRepos, () => setRepos({ current: null, repos: [] }));
  }, [github, repos, workspaceId]);

  useEffect(() => {
    setProjects(null);
    if (!github || !repo) return;
    void host.call('board.projects', { repo }).then(setProjects, (err: Error) => setProjects({ projects: [], problem: err.message }));
  }, [github, repo]);

  const save = async (next: BoardSettings) => {
    if (next.source === 'github' && !next.githubRepo) setBoard(null);
    setSettings(next);
    await attempt(() => host.call('board.save', { workspaceId, settings: next }));
  };

  const chooseRepo = (value: string) => {
    const next = value.trim();
    if (!settings || next === (settings.githubRepo ?? '')) return;
    if (next && !/^[\w.-]+\/[\w.-]+$/.test(next)) return void useStore.getState().toast('Write the repository as owner/name.', 'danger');
    setBoard(null);
    void save({ ...settings, githubRepo: next || null, githubOwner: null, githubProject: null });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      {settings ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
            Board
            <select value={settings.source} onChange={(e) => void save({ ...settings, source: e.target.value as BoardSettings['source'] })} className={inputClass}>
              <option value="shortcut">My Shortcut stories</option>
              <option value="github">GitHub project</option>
            </select>
          </label>
          {settings.source === 'github' ? (
            <>
              <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
                Repository
                <input
                  key={repo ?? ''}
                  list="ade-board-repos"
                  defaultValue={repo ?? ''}
                  placeholder={repos?.current ?? 'owner/name'}
                  onBlur={(e) => chooseRepo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') chooseRepo(e.currentTarget.value);
                  }}
                  // Wide enough for the longest repository name offered (a text field does not size itself).
                  style={{ width: `calc(${Math.max(16, ...[repo ?? '', repos?.current ?? '', ...(repos?.repos ?? [])].map((r) => r.length))}ch + 2rem)` }}
                  className={cx(inputClass, 'max-w-full')}
                />
                <datalist id="ade-board-repos">
                  {(repos?.repos ?? []).map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </label>
              {repo ? (
                <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
                  Project
                  <select
                    value={settings.githubOwner && settings.githubProject ? `${settings.githubOwner}/${settings.githubProject}` : ''}
                    onChange={(e) => {
                      const hit = projects?.projects.find((p) => `${p.owner}/${p.number}` === e.target.value);
                      void save({ ...settings, githubOwner: hit?.owner ?? null, githubProject: hit?.number ?? null });
                    }}
                    // No fixed width: a select is as wide as its longest option.
                    className={cx(inputClass, 'max-w-full')}
                  >
                    <option value="">Open issues and pull requests</option>
                    {(projects?.projects ?? []).map((p) => (
                      <option key={`${p.owner}/${p.number}`} value={`${p.owner}/${p.number}`}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          <Button busy={loading} icon={<RefreshCw className="size-4" aria-hidden="true" />} disabled={loading || needsRepo} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      ) : null}
      {github && repo && projects?.problem ? <p className="m-0 text-[12px] text-ink-muted">{projects.problem}</p> : null}
      {needsRepo ? (
        <EmptyState
          icon={<FolderGit2 className="size-5" />}
          title="Choose a repository"
          body={repos?.current ? `Pick a repository above to see its board. This workspace is ${repos.current}.` : 'Pick a repository above to see its board.'}
          action={repos?.current ? <Button onClick={() => chooseRepo(repos.current!)}>Use {repos.current}</Button> : undefined}
        />
      ) : problem ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState icon={<CircleAlert className="size-5" />} title="The board could not be loaded" body={problem} action={<Button icon={<Settings className="size-4" aria-hidden="true" />} onClick={() => set({ settingsOpen: true })}>Open settings</Button>} />
          {settings ? <ConnectionGuide key={settings.source} source={settings.source} onChecked={() => void load()} /> : null}
        </div>
      ) : board ? (
        <>
          <h2 className="m-0 text-[14px] font-semibold">{board.title}</h2>
          {board.columns.length === 0 ? <p className="m-0 text-ink-muted">No items on this board.</p> : null}
          {/* Columns that do not fit scroll sideways; each column scrolls its own cards, so the sideways scrollbar stays in view. */}
          <div className="flex min-h-0 min-w-0 flex-1 items-start gap-3 overflow-x-auto overflow-y-hidden pb-2" tabIndex={0} aria-label="Board columns">
            {board.columns.map((col) => (
              <section key={col.name} aria-label={col.name} className="flex max-h-full w-72 shrink-0 flex-col gap-2 overflow-y-auto rounded-[var(--radius)] bg-surface-sunken p-2">
                <h3 className="sticky -top-2 z-10 m-0 -mx-2 -mt-2 bg-surface-sunken px-3 pb-1 pt-2 text-[12px] font-semibold text-ink-muted">
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
                      <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" onClick={() => set({ newSession: { workItem: { ref: item.ref, source: item.ref.startsWith('sc-') ? 'shortcut' : 'github', title: item.title, description: '', state: col.name, url: item.url, group: board.title } } })}>
                        Start a session
                      </Button>
                      {item.url ? (
                        <Button icon={<ExternalLink className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => void attempt(() => main('main.openExternal', { url: item.url! }))}>
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
        <Waiting>Loading…</Waiting>
      )}
    </div>
  );
}

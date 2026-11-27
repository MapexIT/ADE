import { BranchGraph } from './BranchGraph.tsx';
import { ExternalLink, GitCompareArrows, GitFork, History, PanelRight, Undo2 } from 'lucide-react';
import { Button, cx, EmptyState, SectionLabel, Tabs } from '@ade/ui';
import type { FileChange } from '@ade/contracts';
import { isLive } from '@ade/session-core';
import { useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, currentWorkspace, selectedSession, useStore, EMPTY } from '../lib/store.ts';
import { FileTree } from './FileTree.tsx';
import { liveWorktree } from '../lib/format.ts';

export function TurnPicker({ sessionId, value, onChange }: { sessionId: string; value: number | null; onChange: (v: number | null) => void }) {
  const turns = useStore((s) => s.turns[sessionId] ?? EMPTY);
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Turn">
      {[null, ...turns.map((t) => t.index)].map((idx) => (
        <Button key={String(idx)} size="dense" variant={value === idx ? 'primary' : 'secondary'} className={cx(value === idx && 'border-accent bg-accent-tint text-accent-soft')} aria-pressed={value === idx} onClick={() => onChange(idx)}>
          {idx === null ? 'All turns' : `Turn ${idx + 1}`}
        </Button>
      ))}
    </div>
  );
}

export function useChanges(sessionId: string | null, turnIndex: number | null) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const items = useStore((s) => (sessionId ? s.views[sessionId]?.lastSeq : 0));
  const state = useStore((s) => (sessionId ? s.sessions[sessionId]?.state : undefined));
  useEffect(() => {
    if (!sessionId || state === 'landed' || state === 'discarded') {
      setChanges([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void host.call('sessions.changes', { sessionId, turnIndex }).then((c) => live && setChanges(c), () => live && setChanges([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sessionId, turnIndex, items, state]);
  return changes;
}

export function ChangeRow({ c }: { c: FileChange }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-small)] border border-line px-2 py-1.5 font-mono text-[12px]">
      <span className="min-w-0 flex-1 break-all">{c.path}</span>
      <span className="text-ink-muted">{c.status === 'binary' ? 'binary' : c.status}</span>
      <span className="text-accent-soft">+{c.additions}</span>
      <span className="text-danger">-{c.deletions}</span>
    </div>
  );
}

/** Right-hand inspector: changes, checkpoints and files for the selected session. */
export function Inspector() {
  const session = useStore(selectedSession);
  const workspace = useStore(currentWorkspace);
  const turns = useStore((s) => (session ? (s.turns[session.id] ?? EMPTY) : EMPTY));
  const setTab = useStore((s) => s.setTab);
  const ask = useStore((s) => s.ask);
  const set = useStore((s) => s.set);
  const [tab, setInspectorTab] = useState<'changes' | 'files' | 'branches'>('changes');
  const [repoTab, setRepoTab] = useState<'files' | 'branches'>('files');
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const changes = useChanges(session?.id ?? null, turnIndex);

  if (!session) {
    return workspace ? (
      <div className="flex h-full flex-col gap-2 bg-surface p-3">
        <Tabs
          label="Inspector"
          value={repoTab}
          onChange={setRepoTab}
          size="dense"
          items={[
            { value: 'files', label: 'Files' },
            { value: 'branches', label: 'Branches' },
          ]}
        />
        {repoTab === 'files' ? (
          <>
            <SectionLabel>Files · {workspace.name}</SectionLabel>
            <FileTree root={workspace.rootPath} sessionId={null} />
          </>
        ) : (
          <BranchGraph workspaceId={workspace.id} />
        )}
      </div>
    ) : (
      <EmptyState icon={<PanelRight className="size-5" />} title="Inspector" body="Details for the selected session appear here." />
    );
  }

  const root = liveWorktree(session) ?? workspace?.rootPath ?? '';
  const ended = session.state === 'landed' || session.state === 'discarded';
  return (
    <aside aria-label="Inspector" className="flex h-full flex-col gap-3 overflow-hidden bg-surface p-3">
      <Tabs
        label="Inspector"
        value={tab}
        onChange={setInspectorTab}
        size="dense"
        items={[
          { value: 'changes', label: 'Changes' },
          { value: 'files', label: 'Files' },
          { value: 'branches', label: 'Branches' },
        ]}
      />
      {tab === 'branches' ? <BranchGraph workspaceId={session.workspaceId} highlight={session.branch} /> : null}
      {tab === 'changes' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          {ended ? (
            <p className="m-0 text-ink-muted">The worktree is gone; the audit log keeps what landed.</p>
          ) : (
            <>
              <TurnPicker sessionId={session.id} value={turnIndex} onChange={setTurnIndex} />
              <div className="flex flex-col gap-1.5">
                {changes.length ? changes.map((c) => <ChangeRow key={c.path} c={c} />) : <span className="text-ink-muted">No changes yet.</span>}
              </div>
              <Button variant="secondary" className="border-accent font-semibold text-accent" onClick={() => setTab('review')} disabled={!changes.length} icon={<GitCompareArrows className="size-4" aria-hidden="true" />}>
                Review changes
              </Button>
              {session.worktreePath ? (
                <Button onClick={() => void attempt(() => main('main.openInEditor', { path: session.worktreePath! }))} icon={<ExternalLink className="size-4" aria-hidden="true" />}>Open worktree in my editor</Button>
              ) : null}
              <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-line p-2.5 text-ink-muted">
                <span className="flex items-center gap-2 font-semibold text-ink">
                  <History className="size-4 text-accent-soft" aria-hidden="true" />
                  Checkpoints
                </span>
                {turns.length === 0 ? <span>A snapshot is saved at the start and end of every turn.</span> : null}
                {turns.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <span className="flex-1">
                      Turn {t.index + 1} · {t.endedAt ? 'snapshot saved' : 'in progress'}
                    </span>
                    {t.endCheckpoint ? (
                      <Button icon={<GitFork className="size-4" aria-hidden="true" />}
                        size="dense"
                        variant="ghost"
                        title={`SR-06: a new session and worktree starting from the end of turn ${t.index + 1}`}
                        onClick={() => set({ newSession: { title: `Fork of ${session.title}`, baseRef: t.endCheckpoint! } })}
                      >
                        Fork
                      </Button>
                    ) : null}
                    {t.startCheckpoint && !isLive(session.state) ? (
                      <Button icon={<Undo2 className="size-4" aria-hidden="true" />}
                        size="dense"
                        variant="ghost"
                        onClick={() =>
                          ask({
                            title: `Undo turn ${t.index + 1}?`,
                            body: `The worktree goes back to how it was before turn ${t.index + 1}. Every change from that turn and later turns is lost, including files they created.`,
                            confirmLabel: 'Undo turn',
                            danger: true,
                            onConfirm: () => void attempt(() => host.call('sessions.undoTurn', { sessionId: session.id, turnIndex: t.index })),
                          })
                        }
                      >
                        Undo
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : tab === 'files' && root ? (
        <FileTree root={root} sessionId={session.worktreePath ? session.id : null} changes={changes} />
      ) : null}
    </aside>
  );
}

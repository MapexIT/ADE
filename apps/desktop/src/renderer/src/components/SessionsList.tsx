import { ClearHistoryButton, DeleteEntryButton } from './ClearHistoryButton.tsx';
import { History, MessagesSquare, Plus, Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { Session } from '@ade/contracts';
import { groupOf, STATE_LABELS, type SessionGroup } from '@ade/session-core';
import { useEffect, useMemo, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { useTerminals } from '../lib/terminals.ts';

const GROUPS: { id: SessionGroup; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'ready', label: 'Ready for review' },
  { id: 'done', label: 'Done' },
];

/** PL-01: every session grouped by what it needs from the user; updates live. */
export function SessionsList() {
  const sessions = useStore((s) => s.sessions);
  const selected = useStore((s) => s.selectedSessionId);
  const select = useStore((s) => s.selectSession);
  const inbox = useStore((s) => s.inbox);
  const set = useStore((s) => s.set);
  const waitingTerminals = useTerminals(
    useShallow((t) => Object.values(t.terminals).filter((x) => x.agentState === 'waiting')),
  );
  const [showDone, setShowDone] = useState(false);
  const workspaceId = useStore((s) => s.workspaceId);
  /** HI-13: deletes ended sessions (one, or every ended one) with their stored history. */
  const deleteEnded = async (sessionIds?: string[]) => {
    if (!workspaceId) return;
    const res = await attempt(() => host.call('sessions.deleteEnded', sessionIds ? { workspaceId, sessionIds } : { workspaceId }));
    if (!res) return;
    useStore.getState().removeSessions(res.deleted);
    if (!sessionIds) useStore.getState().toast(res.deleted.length === 1 ? 'Deleted 1 session.' : `Deleted ${res.deleted.length} sessions.`);
  };
  // PL-04: refreshed whenever a session's state changes (overlaps are computed after each turn).
  const [overlaps, setOverlaps] = useState<{ sessionId: string; otherSessionId: string; files: string[] }[]>(
    [],
  );
  const stateKey = Object.values(sessions)
    .map((s) => `${s.id}:${s.state}`)
    .join('|');
  useEffect(() => {
    if (!workspaceId) return;
    void host
      .call('sessions.overlaps', { workspaceId })
      .then(setOverlaps)
      .catch(() => undefined);
  }, [workspaceId, stateKey]);
  const overlapOf = (id: string) => {
    const hits = overlaps.filter((o) => o.sessionId === id || o.otherSessionId === id);
    return hits.length ? [...new Set(hits.flatMap((o) => o.files))] : null;
  };

  const grouped = useMemo(() => {
    const out: Record<SessionGroup, Session[]> = { 'needs-you': [], working: [], ready: [], done: [] };
    for (const s of Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const terminalWaiting = waitingTerminals.some((t) => t.sessionId === s.id);
      out[terminalWaiting && groupOf(s.state) !== 'done' ? 'needs-you' : groupOf(s.state)].push(s);
    }
    return out;
  }, [sessions, waitingTerminals]);

  const detail = (s: Session) => {
    // WA-10: a loop warning is shown only when nothing else needs the user; the session stays under Working.
    const pending = inbox
      .filter((i) => i.sessionId === s.id)
      .sort((a, b) => Number(a.kind === 'loop') - Number(b.kind === 'loop'));
    if (pending[0]?.kind === 'loop') return { text: 'May be looping', attention: true };
    if (pending[0])
      return {
        text:
          pending[0].kind === 'question'
            ? 'Has a question'
            : pending[0].kind === 'permission'
              ? 'Asks for approval'
              : pending[0].title,
        attention: true,
      };
    if (waitingTerminals.some((t) => t.sessionId === s.id))
      return { text: 'Agent terminal is waiting', attention: true };
    return { text: STATE_LABELS[s.state], attention: false };
  };

  return (
    <aside aria-label="Sessions" className="flex h-full flex-col gap-3 overflow-auto bg-surface p-3">
      <Button
        variant="primary"
        onClick={() => set({ newSession: {} })}
        icon={<Plus className="size-4" aria-hidden="true" />}
      >
        New session
      </Button>
      <Button
        variant="ghost"
        onClick={() => set({ sessionSearchOpen: true })}
        icon={<Search className="size-4" aria-hidden="true" />}
      >
        Search sessions
      </Button>
      <Button
        variant="ghost"
        onClick={() => set({ cliSessionsOpen: true })}
        icon={<History className="size-4" aria-hidden="true" />}
      >
        Continue from a CLI
      </Button>
      {Object.keys(sessions).length === 0 ? (
        // Bottom padding equals the three buttons above (3 × 44 px + 2 × 12 px gaps) plus the gap below them, so the empty state
        // sits at the same height as the Inspector's on the other side.
        <div
          className="flex min-h-0 flex-1 pb-[168px] [&>*]:w-full [&>*]:px-2 [&_p]:max-w-none"
          data-testid="sessions-empty"
        >
          <EmptyState
            icon={<MessagesSquare className="size-5" />}
            title="No sessions yet"
            body="Start one to give an agent a task in its own worktree."
          />
        </div>
      ) : null}
      {GROUPS.map((g) => {
        const list = grouped[g.id];
        if (!list.length) return null;
        if (g.id === 'done' && !showDone) {
          return (
            <Button
              key={g.id}
              className="justify-start border-dashed text-ink-muted"
              onClick={() => setShowDone(true)}
            >
              Done · show {list.length}
            </Button>
          );
        }
        return (
          <section key={g.id} className="flex flex-col gap-2" aria-label={g.label}>
            <div className="flex items-center gap-2">
              <SectionLabel className={cx(g.id === 'needs-you' && 'text-attention')}>
                {g.label} · {list.length}
              </SectionLabel>
              {g.id === 'done' ? <ClearHistoryButton className="ml-auto" label="Delete all" confirmLabel="Delete all ended sessions" onConfirm={() => deleteEnded()} /> : null}
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((s) => {
                const d = detail(s);
                const isSel = s.id === selected;
                return (
                  <li key={s.id} className="relative">
                    <button
                      type="button"
                      onClick={() => select(s.id)}
                      aria-current={isSel ? 'true' : undefined}
                      className={cx(
                        // A card per session: violet edge and tint so each stands apart from the panel background.
                        'flex min-h-11 w-full flex-col gap-1 rounded-[var(--radius)] border border-l-[3px] px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] duration-[var(--motion-fast)]',
                        d.attention
                          ? 'border-attention-line border-l-attention'
                          : 'border-accent/35 border-l-accent',
                        isSel
                          ? d.attention
                            ? 'bg-attention-tint'
                            : 'border-accent bg-accent-tint shadow-[0_6px_18px_-8px_var(--accent-glow)]'
                          : 'bg-accent-tint/45 hover:border-accent/70 hover:bg-accent-tint',
                      )}
                    >
                      <span className="font-semibold">{s.title}</span>
                      <span className="text-ink-muted">
                        {agentLabel(s.agentId)}
                        {s.workItemRef ? ` · ${s.workItemRef}` : ''}
                      </span>
                      <span className={d.attention ? 'text-attention' : 'text-ink-muted'}>{d.text}</span>
                      {overlapOf(s.id) ? (
                        <span className="text-attention" title={overlapOf(s.id)!.join(', ')}>
                          Overlaps another session · {overlapOf(s.id)!.length} file(s)
                        </span>
                      ) : null}
                    </button>
                    {g.id === 'done' ? (
                      <div className="absolute right-2 top-2">
                        <DeleteEntryButton label={`Delete session ${s.title}`} onDelete={() => void deleteEnded([s.id])} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}

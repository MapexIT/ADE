import { ChevronRight, History, RefreshCw } from 'lucide-react';
import { Button, EmptyState, Waiting } from '@ade/ui';
import { AGENT_LABELS, type CliSession } from '@ade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { useStore } from '../lib/store.ts';
import { Modal } from './Modal.tsx';

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * SR-10: lists the conversations Claude Code, Codex and OpenCode keep for this repository (ACP `session/list`).
 * Choosing one opens New session with that agent, where the user writes the next message.
 */
export function ContinueCliDialog() {
  const open = useStore((s) => s.cliSessionsOpen);
  const workspaceId = useStore((s) => s.workspaceId);
  const set = useStore((s) => s.set);
  const [result, setResult] = useState<{ sessions: CliSession[]; problems: { agentId: string; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setResult(null);
    setError(null);
    host.call('sessions.cliList', { workspaceId }).then(setResult, (err: Error) => setError(err.message));
  }, [workspaceId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const close = () => set({ cliSessionsOpen: false });
  const choose = (s: CliSession) =>
    set({ cliSessionsOpen: false, newSession: { continueFrom: { agentId: s.agentId, sessionId: s.sessionId, title: s.title }, ...(s.title ? { title: s.title } : {}) } });

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Continue from a CLI"
      description="Conversations you started in Claude Code, Codex or OpenCode in this repository. The one you choose continues in its own worktree."
      wide
      footer={
        <>
          <Button icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={load} disabled={!result && !error}>
            Check again
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      {!workspaceId ? (
        <EmptyState icon={<History className="size-5" />} title="Open a repository" body="CLI conversations are listed for the repository they were started in." />
      ) : error ? (
        <p role="alert" className="m-0 text-ink-muted">
          {error}
        </p>
      ) : !result ? (
        <Waiting>Asking the agents for their conversations…</Waiting>
      ) : (
        <div className="flex flex-col gap-3">
          {result.sessions.length === 0 ? (
            <p className="m-0 text-ink-muted">No conversations found for this repository. A conversation counts when it was started in the repository folder itself.</p>
          ) : (
            <ul className="m-0 flex max-h-[50vh] list-none flex-col gap-2 overflow-y-auto p-0" aria-label="CLI conversations">
              {result.sessions.map((s) => (
                <li key={`${s.agentId}:${s.sessionId}`}>
                  <button
                    type="button"
                    onClick={() => choose(s)}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-line bg-surface px-3 py-2.5 text-left transition-colors duration-[var(--motion)] hover:border-accent"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-semibold">{s.title ?? 'Untitled conversation'}</span>
                      <span className="text-[12px] text-ink-muted">
                        {AGENT_LABELS[s.agentId]}
                        {when(s.updatedAt) ? ` · ${when(s.updatedAt)}` : ''}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {result.problems.map((p) => (
            <p key={p.agentId} className="m-0 text-[12px] text-ink-muted">
              {AGENT_LABELS[p.agentId as keyof typeof AGENT_LABELS] ?? p.agentId}: {p.message}
            </p>
          ))}
        </div>
      )}
    </Modal>
  );
}

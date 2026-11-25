import { ArrowRightLeft, GitCompareArrows, MessagesSquare } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import type { AgentId, FileChange, Session } from '@ade/contracts';
import { isLive, STATE_LABELS } from '@ade/session-core';
import { useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

/**
 * PL-03: the sessions of one compare run side by side: state, changed files with line counts and the last
 * message, with a way into each session's review.
 */
export function CompareDialog() {
  const group = useStore((s) => s.compareGroup);
  const sessions = useStore((s) => s.sessions);
  const set = useStore((s) => s.set);
  const selectSession = useStore((s) => s.selectSession);
  const members = Object.values(sessions)
    .filter((s) => group && s.compareGroup === group)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [changes, setChanges] = useState<Record<string, FileChange[] | null>>({});
  const [lastMessage, setLastMessage] = useState<Record<string, string>>({});
  const stateKey = members.map((m) => `${m.id}:${m.state}`).join('|');

  useEffect(() => {
    if (!group) return;
    for (const m of members) {
      void host
        .call('sessions.get', { sessionId: m.id })
        .then((d) => {
          const text = d.events.flatMap((e) => (e.type === 'agent.message' ? [e.text] : [])).at(-1);
          if (text) setLastMessage((cur) => ({ ...cur, [m.id]: text }));
        })
        .catch(() => undefined);
      if (m.state === 'landed' || m.state === 'discarded') continue;
      void host
        .call('sessions.changes', { sessionId: m.id, turnIndex: null })
        .then((c) => setChanges((cur) => ({ ...cur, [m.id]: c })))
        .catch(() => setChanges((cur) => ({ ...cur, [m.id]: null })));
    }
    // Refresh whenever a member changes state (a turn ends).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, stateKey]);

  const open = (s: Session, tab: 'sessions' | 'review') => {
    selectSession(s.id);
    set({ compareGroup: null, tab });
  };

  return (
    <Modal open={!!group} onOpenChange={(o) => !o && set({ compareGroup: null })} title="Compare agents" description="The same prompt, each agent in its own worktree. Land the one you like and discard the others." wide>
      <div className={cx('grid gap-3', members.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
        {members.map((s) => {
          const files = changes[s.id];
          const added = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
          const removed = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;
          return (
            <section key={s.id} aria-label={agentLabel(s.agentId)} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{agentLabel(s.agentId)}</span>
                <Badge tone={isLive(s.state) ? 'accent' : s.state === 'ready' ? 'ok' : 'neutral'}>{STATE_LABELS[s.state]}</Badge>
              </div>
              <span className="text-[12px] text-ink-muted">
                {files ? `${files.length} file(s) · +${added} −${removed}` : files === null ? 'Changes unavailable' : 'Loading changes…'}
              </span>
              <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-auto p-0 font-mono text-[12px]">
                {(files ?? []).map((f) => (
                  <li key={f.path} className="truncate" title={f.path}>
                    {f.path} <span className="text-ink-muted">+{f.additions} −{f.deletions}</span>
                  </li>
                ))}
              </ul>
              <p className="m-0 line-clamp-6 text-ink-muted whitespace-pre-wrap">{lastMessage[s.id] ?? 'No message yet.'}</p>
              <div className="mt-auto flex gap-2">
                <Button icon={<MessagesSquare className="size-4" aria-hidden="true" />} size="dense" onClick={() => open(s, 'sessions')}>
                  Open session
                </Button>
                <Button icon={<GitCompareArrows className="size-4" aria-hidden="true" />} size="dense" variant="primary" disabled={!files?.length} onClick={() => open(s, 'review')}>
                  Review
                </Button>
              </div>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

/** SR-07: continue in the same worktree with another agent. */
export function HandOffDialog() {
  const sessionId = useStore((s) => s.handOffSessionId);
  const session = useStore((s) => (sessionId ? s.sessions[sessionId] : null));
  const agents = useStore((s) => s.agents);
  const set = useStore((s) => s.set);
  const upsert = useStore((s) => s.upsertSession);
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = agents.filter((a) => a.health === 'ready' && a.id !== session?.agentId);

  useEffect(() => {
    if (!sessionId) return;
    setNote('');
    setAgentId(choices[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const go = async () => {
    if (!sessionId || !agentId) return;
    setBusy(true);
    const updated = await attempt(() => host.call('sessions.handOff', { sessionId, agentId, ...(note.trim() ? { note: note.trim() } : {}) }));
    setBusy(false);
    if (updated) {
      upsert(updated);
      set({ handOffSessionId: null });
    }
  };

  return (
    <Modal
      open={!!session}
      onOpenChange={(o) => !o && set({ handOffSessionId: null })}
      title="Hand off to another agent"
      description="The same worktree and branch continue with another agent. It gets the last message and the diff so far; the timeline keeps both."
      footer={
        <>
          <Button onClick={() => set({ handOffSessionId: null })}>Cancel</Button>
          <Button busy={busy} icon={<ArrowRightLeft className="size-4" aria-hidden="true" />} variant="primary" disabled={!agentId || busy} onClick={() => void go()}>
            {busy ? 'Handing off…' : 'Hand off'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Agent" htmlFor="handoff-agent">
          <select id="handoff-agent" value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)} className={inputClass}>
            {choices.length === 0 ? <option value="">No other agent is ready</option> : null}
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note for the new agent (optional)" htmlFor="handoff-note">
          <textarea id="handoff-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={cx(inputClass, 'py-2')} />
        </Field>
      </div>
    </Modal>
  );
}

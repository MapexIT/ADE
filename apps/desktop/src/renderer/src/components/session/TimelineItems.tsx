import { Badge, Button, cx } from '@ade/ui';
import type { PermissionOption, ToolContent } from '@ade/contracts';
import type { TimelineItem } from '@ade/session-core';
import { memo, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { agentLabel, promptPreview, TOOL_STATUS_LABELS } from '../../lib/format.ts';
import { attempt, useStore, EMPTY } from '../../lib/store.ts';

const TOOL_KIND_LABELS: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Think',
  fetch: 'Fetch',
  switch_mode: 'Switch mode',
  other: 'Tool',
};

/** WA-02: an inline unified diff for edit tool calls. */
export function InlineDiff({ oldText, newText }: { oldText: string | null; newText: string }) {
  const oldLines = (oldText ?? '').split('\n');
  const newLines = newText.split('\n');
  // Trim the common prefix and suffix so the card shows only what changed.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = oldText === null ? [] : oldLines.slice(start, endOld + 1);
  const added = newLines.slice(start, endNew + 1);
  const shown = 40;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-small)] border border-line font-mono text-[12px]">
      {removed.slice(0, shown).map((l, i) => (
        <div key={`r${i}`} className="bg-danger-tint px-2 py-px whitespace-pre text-danger">
          - {l}
        </div>
      ))}
      {added.slice(0, shown).map((l, i) => (
        <div key={`a${i}`} className="bg-accent-tint px-2 py-px whitespace-pre text-accent-soft">
          + {l}
        </div>
      ))}
      {removed.length + added.length > shown * 2 ? <div className="px-2 py-1 text-ink-muted">More changes in the review view.</div> : null}
      {removed.length + added.length === 0 ? <div className="px-2 py-1 text-ink-muted">No textual change.</div> : null}
    </div>
  );
}

function ToolContentView({ content }: { content: ToolContent }) {
  if (content.type === 'diff') return <InlineDiff oldText={content.oldText} newText={content.newText} />;
  if (content.type === 'terminal') return <div className="font-mono text-[12px] text-ink-muted">Command output · terminal {content.terminalId.slice(0, 8)}</div>;
  return <pre className="m-0 max-h-60 overflow-auto rounded-[var(--radius-small)] bg-surface-sunken p-2 font-mono text-[12px] whitespace-pre-wrap text-ink">{content.text}</pre>;
}

/** WA-02 / AP-02 helpers. */
function statusTone(status: string) {
  return status === 'failed' ? 'danger' : status === 'completed' ? 'ok' : status === 'in_progress' ? 'accent' : 'neutral';
}

export function ApprovalCard({ item, sessionId }: { item: Extract<TimelineItem, { kind: 'permission' }>; sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const [noteFor, setNoteFor] = useState<PermissionOption | null>(null);
  const [note, setNote] = useState('');
  const pending = item.decision === null;
  const isQuestion = item.toolKind === 'think';

  const answer = (optionId: string | null, withNote?: string) =>
    attempt(() => host.call('sessions.answerPermission', { sessionId, requestId: item.requestId, optionId, ...(withNote ? { note: withNote } : {}) }));

  if (!pending) {
    const chosen = item.decision?.outcome === 'selected' ? item.options.find((o) => o.optionId === (item.decision as { optionId: string }).optionId) : null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-line bg-surface px-3 py-2">
        <span className="font-semibold">{isQuestion ? 'Question' : 'Approval'}</span>
        <span className="min-w-0 truncate">{item.title}</span>
        <span className="ml-auto text-ink-muted">
          {chosen ? chosen.name : 'Cancelled'} · {item.decidedBy === 'user' ? 'by you' : item.decidedBy?.startsWith('profile:') ? `by the ${item.decidedBy.slice(8)} profile` : item.decidedBy?.startsWith('rule:') ? 'by a workspace rule' : 'automatically'}
        </span>
        {item.note ? <span className="w-full text-ink-muted">Note: {item.note}</span> : null}
      </div>
    );
  }

  const rejectOptions = item.options.filter((o) => o.kind.startsWith('reject'));
  return (
    <section aria-label={isQuestion ? 'Question from the agent' : 'Approval request'} className="flex flex-col gap-2.5 rounded-[var(--radius)] border-2 border-attention-line bg-attention-tint p-3">
      <div className="font-semibold text-attention">
        {session ? agentLabel(session.agentId) : 'The agent'} {isQuestion ? 'asks' : 'asks to'}: {item.title}
      </div>
      {item.detail ? <div className="rounded-[var(--radius-small)] bg-surface-sunken px-2.5 py-2 font-mono text-[12px] text-ink">{item.detail}</div> : null}
      {!isQuestion && session?.worktreePath ? (
        <div className="text-ink-muted">
          Runs in {session.inPlace ? 'your checkout' : 'the session worktree'}. This session is {session.sandboxState === 'not-sandboxed' ? 'not sandboxed' : session.sandboxState === 'sandboxed' ? 'sandboxed' : 'commands sandboxed'}.
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {item.options.map((o, i) => (
          <Button
            key={o.optionId}
            variant={i === 0 && o.kind.startsWith('allow') ? 'primary' : o.kind.startsWith('allow') ? 'secondary' : 'secondary'}
            className={cx(o.kind === 'allow_always' && 'border-accent text-accent')}
            onClick={() => void answer(o.optionId)}
          >
            {o.name}
          </Button>
        ))}
        {rejectOptions[0] ? (
          <Button onClick={() => setNoteFor(rejectOptions[0]!)} aria-expanded={!!noteFor}>
            Reject with a note
          </Button>
        ) : null}
      </div>
      {noteFor ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`note-${item.requestId}`} className="text-[12px] font-semibold text-ink-muted">
            Tell the agent what to do instead. It is sent when the turn ends.
          </label>
          <textarea
            id={`note-${item.requestId}`}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-[var(--radius)] border border-line bg-bg p-2.5 text-ink focus:border-accent focus:outline-none"
          />
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void answer(noteFor.optionId, note)}>
              Reject and send the note
            </Button>
            <Button variant="ghost" onClick={() => setNoteFor(null)}>
              Never mind
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export const TimelineRow = memo(function TimelineRow({ item, sessionId }: { item: TimelineItem; sessionId: string }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ml-auto max-w-[75%] rounded-[var(--radius)] bg-accent-tint px-3 py-2.5 whitespace-pre-wrap">
          {item.content.map((b, i) =>
            b.type === 'text' ? (
              <span key={i}>{b.text}</span>
            ) : (
              <Badge key={i} tone="accent" className="mr-1">
                {b.type === 'resource' ? b.name : 'Image'}
              </Badge>
            ),
          )}
        </div>
      );
    case 'agent-message':
      return <div className="max-w-[85%] whitespace-pre-wrap">{item.text}</div>;
    case 'agent-thought':
      return (
        <details className="max-w-[85%] text-ink-muted">
          <summary className="cursor-pointer">Thinking{item.streaming ? '…' : ''}</summary>
          <div className="mt-1 whitespace-pre-wrap">{item.text}</div>
        </details>
      );
    case 'tool-call':
      return (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{TOOL_KIND_LABELS[item.toolKind] ?? 'Tool'}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.locations[0] ?? item.title}</span>
            <Badge tone={statusTone(item.status)}>{TOOL_STATUS_LABELS[item.status]}</Badge>
          </div>
          {item.locations.length === 0 || item.title !== `${TOOL_KIND_LABELS[item.toolKind]} ${item.locations[0]}` ? <div className="text-ink-muted">{item.title}</div> : null}
          {item.content.map((c, i) => (
            <ToolContentView key={i} content={c} />
          ))}
        </div>
      );
    case 'permission':
      return <ApprovalCard item={item} sessionId={sessionId} />;
    case 'turn':
      return (
        <div className="flex items-center gap-3 text-[12px] text-ink-muted" role="separator">
          <span className="h-px flex-1 bg-line" />
          Turn {item.index + 1}
          {item.stopReason ? ` · ${item.stopReason === 'end_turn' ? 'finished' : item.stopReason}` : ' · running'}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case 'notice':
      return (
        <div className={cx('rounded-[var(--radius)] border px-3 py-2 whitespace-pre-wrap', item.level === 'error' ? 'border-danger-line bg-danger-tint text-danger' : item.level === 'warning' ? 'border-attention-line text-attention' : 'border-line text-ink-muted')}>
          {item.level === 'error' ? 'Error: ' : item.level === 'warning' ? 'Warning: ' : ''}
          {item.text}
        </div>
      );
  }
});

export function QueuedMessages({ sessionId }: { sessionId: string }) {
  const queued = useStore((s) => s.queued[sessionId] ?? EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (!queued.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Queued messages">
      {queued.map((q) => (
        <div key={q.id} className="ml-auto flex max-w-[75%] flex-col gap-2 rounded-[var(--radius)] border border-dashed border-accent px-3 py-2">
          <span className="text-[12px] text-accent-soft">Queued · sent when the turn ends</span>
          {editing === q.id ? (
            <>
              <label htmlFor={`q-${q.id}`} className="sr-only">
                Edit queued message
              </label>
              <textarea id={`q-${q.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className="rounded border border-line bg-bg p-2 text-ink" />
              <div className="flex gap-2">
                <Button
                  size="dense"
                  variant="primary"
                  onClick={() =>
                    void attempt(() => host.call('sessions.editQueued', { sessionId, id: q.id, content: [{ type: 'text', text: draft }] })).then(() => setEditing(null))
                  }
                >
                  Save
                </Button>
                <Button size="dense" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="whitespace-pre-wrap">{promptPreview(q.content)}</span>
              <div className="flex gap-2">
                <Button
                  size="dense"
                  variant="ghost"
                  onClick={() => {
                    setDraft(q.content.find((b) => b.type === 'text')?.text ?? '');
                    setEditing(q.id);
                  }}
                >
                  Edit
                </Button>
                <Button size="dense" variant="ghost" onClick={() => void attempt(() => host.call('sessions.unqueue', { sessionId, id: q.id }))}>
                  Remove
                </Button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

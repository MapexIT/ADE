import { ListTree, MessageSquarePlus, ScrollText, X } from 'lucide-react';
import { Badge, Button, cx, SectionLabel, Waiting } from '@ade/ui';
import type { ChangesByPrompt, FileChange, Session, TraceDetail, TraceLine } from '@ade/contracts';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { host } from '../lib/bridge.ts';
import { TOOL_STATUS_LABELS } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import { excerpt, groupTitle, traceLabel } from '../lib/trace.ts';

const time = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** RV-17: the prompt of a turn, cut at 300 characters with a way to read all of it. */
function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const short = excerpt(text);
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 rounded-[var(--radius-small)] bg-surface-sunken p-2 text-[12.5px] break-words whitespace-pre-wrap">{open ? text : short.text}</p>
      {short.more ? (
        <button type="button" className="self-start text-[12px] text-accent-soft underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show the whole prompt'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * RV-17: the Trace card in the Review inspector: where the selected line came from. Escape closes it and gives focus
 * back to the diff.
 */
export function TraceCard({
  session,
  path,
  line,
  side,
  origin,
  loading,
  onComment,
  onClose,
}: {
  session: Session;
  path: string;
  line: number;
  side: 'new' | 'old';
  /** Null when the line is unchanged since the base commit. */
  origin: TraceLine | null;
  loading: boolean;
  onComment: (origin: TraceLine | null, prompt: string | null) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const set = useStore((s) => s.set);
  const turnIndex = origin?.turnIndex ?? null;
  const toolCallId = origin?.toolCallId ?? null;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    if (turnIndex === null) return;
    let live = true;
    host.call('sessions.traceDetail', { sessionId: session.id, turnIndex, toolCallId }).then(
      (d) => live && setDetail(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [session.id, turnIndex, toolCallId]);

  useEffect(() => {
    ref.current?.focus();
  }, [path, line, side]);

  const label = origin ? traceLabel(origin) : null;
  const where = `${side === 'old' ? 'Old line' : 'Line'} ${line}`;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label="Trace"
      onKeyDown={onKeyDown}
      className="flex min-h-0 w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-line bg-surface p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-center gap-2">
        <ListTree className="size-4 text-accent-soft" aria-hidden="true" />
        <h2 className="m-0 flex-1 text-[14px] font-semibold">Trace</h2>
        <Button size="dense" variant="ghost" icon={<X className="size-4" aria-hidden="true" />} onClick={onClose} aria-label="Close trace">
          Close
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px] break-all text-ink-muted">
          {path} · {where}
        </span>
        {label ? <Badge tone={origin?.kind === 'unreported' ? 'attention' : origin?.kind === 'agent' ? 'accent' : 'neutral'}>{label}</Badge> : null}
        {origin?.kind === 'unreported' && origin.turnIndex !== null ? <Badge tone="accent">Turn {origin.turnIndex + 1}</Badge> : null}
      </div>

      {loading ? <Waiting>Tracing the file…</Waiting> : null}
      {!loading && !origin ? <p className="m-0 text-ink-muted">This line is unchanged since the base commit, so no turn wrote it.</p> : null}
      {origin?.kind === 'user' ? <p className="m-0">You changed this line in ADE while the agent was idle.</p> : null}
      {origin?.kind === 'unknown' ? (
        <p className="m-0">ADE cannot tell which turn {side === 'old' ? 'removed' : 'wrote'} this line: a checkpoint is missing, or it changed between turns outside ADE. It does not guess.</p>
      ) : null}
      {origin?.kind === 'unreported' ? (
        <div className="rounded-[var(--radius)] border border-attention-line bg-attention-tint p-2.5 text-attention">
          <p className="m-0 font-semibold">Not reported as an edit</p>
          <p className="m-0 mt-1 text-[12.5px]">This turn changed the line, but none of its reported edits explains it. A command it ran may have written it.</p>
        </div>
      ) : null}

      {turnIndex !== null && !detail && !failed ? <Waiting>Reading the turn…</Waiting> : null}
      {failed ? <p className="m-0 text-ink-muted">The turn's events could not be read.</p> : null}
      {detail ? (
        <>
          <section aria-label="Prompt" className="flex flex-col gap-1">
            <SectionLabel>
              Turn {detail.turnIndex + 1}
              {detail.startedAt ? ` · ${time(detail.startedAt)}` : ''}
            </SectionLabel>
            {detail.prompt ? <Prompt text={detail.prompt} /> : <p className="m-0 text-ink-muted">No prompt recorded for this turn.</p>}
          </section>
          {detail.toolCall ? (
            <section aria-label="Tool call" className="flex flex-col gap-1">
              <SectionLabel>Tool call</SectionLabel>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[12px] break-all">{detail.toolCall.title}</span>
                <Badge>{TOOL_STATUS_LABELS[detail.toolCall.status]}</Badge>
              </div>
            </section>
          ) : null}
          {origin?.kind === 'unreported' ? (
            <section aria-label="Commands in this turn" className="flex flex-col gap-1">
              <SectionLabel>Commands in this turn</SectionLabel>
              {detail.commands.length ? (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {detail.commands.map((c, i) => (
                    <li key={i} className="font-mono text-[12px] break-all">
                      {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-ink-muted">ADE saw no commands in this turn.</p>
              )}
            </section>
          ) : null}
          {detail.preceding ? (
            <section aria-label="Before it" className="flex flex-col gap-1">
              <SectionLabel>{detail.preceding.kind === 'thought' ? 'The agent was thinking' : 'The agent said'}</SectionLabel>
              <p className="m-0 max-h-40 overflow-auto text-[12.5px] whitespace-pre-wrap text-ink-muted">{detail.preceding.text}</p>
            </section>
          ) : null}
          {detail.permissions.length ? (
            <section aria-label="Approvals" className="flex flex-col gap-1">
              <SectionLabel>{detail.permissions[0]!.forToolCall ? 'Approval' : 'Approvals earlier in this turn'}</SectionLabel>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {detail.permissions.map((p, i) => (
                  <li key={i} className="text-[12.5px]">
                    <span className="font-mono text-[12px]">{p.title}</span>: {p.decision}, decided by {p.decidedBy}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
        {detail?.toolCall ? (
          <Button
            size="dense"
            icon={<ScrollText className="size-4" aria-hidden="true" />}
            onClick={() => set({ tab: 'sessions', timelineFocus: { sessionId: session.id, key: `tool:${detail.toolCall!.toolCallId}`, seq: Date.now() } })}
          >
            Open in timeline
          </Button>
        ) : null}
        {!loading ? (
          <Button size="dense" icon={<MessageSquarePlus className="size-4" aria-hidden="true" />} onClick={() => onComment(origin, detail?.prompt ?? null)}>
            Comment to agent
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

/** RV-17: the changed-files list read by prompt: every hunk under the turn that wrote it. */
export function PromptsList({ sessionId, changes, onOpen }: { sessionId: string; changes: FileChange[]; onOpen: (path: string, line: number, side: 'new' | 'old') => void }) {
  const [data, setData] = useState<ChangesByPrompt | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    host.call('sessions.changesByPrompt', { sessionId }).then(
      (d) => live && setData(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [sessionId, changes]);
  if (failed) return <p className="m-0 text-ink-muted">The changes could not be grouped by prompt.</p>;
  if (!data) return <Waiting>Grouping changes by prompt…</Waiting>;
  if (!data.groups.length && !data.binary.length) return <p className="m-0 text-ink-muted">No changes in this session yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-ink-muted">
        <span className="text-accent-soft">+{data.additions}</span> <span className="text-danger">-{data.deletions}</span> across {data.groups.length} {data.groups.length === 1 ? 'group' : 'groups'}
      </span>
      {data.groups.map((g) => {
        const title = groupTitle(g);
        return (
          <section
            key={`${g.kind}-${g.turnIndex ?? ''}`}
            aria-label={title}
            className={cx('flex flex-col gap-1.5 rounded-[var(--radius)] border p-2.5', g.kind === 'unreported' ? 'border-attention-line bg-attention-tint' : 'border-line')}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className={cx('m-0 text-[13px] font-semibold', g.kind === 'unreported' && 'text-attention')}>{title}</h3>
              <span className="text-[12px] text-accent-soft">+{g.additions}</span>
              <span className="text-[12px] text-danger">-{g.deletions}</span>
            </div>
            {g.prompt ? <p className="m-0 line-clamp-3 text-[12px] break-words text-ink-muted">{excerpt(g.prompt, 200).text}</p> : null}
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {g.hunks.map((h, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onOpen(h.path, h.line, h.side)}
                    className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-small)] px-1.5 text-left font-mono text-[12px] hover:bg-surface-raised"
                  >
                    <span className="min-w-0 flex-1 break-all">
                      {h.path}:{h.side === 'old' ? `old ${h.line}` : h.line}
                    </span>
                    <span className="text-accent-soft">+{h.additions}</span>
                    <span className="text-danger">-{h.deletions}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {data.binary.length ? <p className="m-0 text-[12px] text-ink-muted">Binary files have no lines to trace: {data.binary.join(', ')}</p> : null}
    </div>
  );
}

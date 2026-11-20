import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { PromptBlock, Session } from '@ade/contracts';
import { isLive, STATE_LABELS } from '@ade/session-core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { host } from '../../lib/bridge.ts';
import { agentLabel, attachmentText, elapsed, joinPath, PROFILE_LABELS, SANDBOX_LABELS, textPrompt } from '../../lib/format.ts';
import { attempt, selectedSession, useStore, EMPTY } from '../../lib/store.ts';
import { FilePicker } from '../FilePicker.tsx';
import { QueuedMessages, TimelineRow } from './TimelineItems.tsx';

function stateTone(s: Session['state']) {
  return s === 'waiting-on-user' || s === 'interrupted' ? 'attention' : s === 'working' || s === 'starting' ? 'accent' : s === 'ready' ? 'ok' : 'neutral';
}

/** WA-04: state, agent and version, branch, sandbox badge, elapsed time, usage or "not reported". */
export function SessionHeader({ session }: { session: Session }) {
  const view = useStore((s) => s.views[session.id]);
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agentId));
  const set = useStore((s) => s.set);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isLive(session.state)) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [session.state]);
  const usage = view?.usage;
  const usageText =
    usage && (usage.inputTokens !== null || usage.costUsd !== null)
      ? [usage.inputTokens !== null ? `${usage.inputTokens.toLocaleString('en-GB')} tokens` : null, usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)}` : null].filter(Boolean).join(' · ')
      : 'usage not reported';
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
      <h1 className="m-0 text-[16px] font-semibold">{session.title}</h1>
      <Badge tone={stateTone(session.state)} className="font-semibold">
        {STATE_LABELS[session.state]}
      </Badge>
      <Badge>
        {agentLabel(session.agentId)}
        {agent?.version ? ` ${agent.version.replace(/^[^\d]*/, '').split(' ')[0]}` : ''}
      </Badge>
      {session.branch ? <Badge className="font-mono text-[12px]">{session.branch}</Badge> : null}
      <Badge tone={session.sandboxState === 'sandboxed' ? 'ok' : session.sandboxState === 'commands-sandboxed' ? 'accent' : 'attention'} title="Derived from the agent and this platform, never assumed">
        {SANDBOX_LABELS[session.sandboxState]}
      </Badge>
      <Badge>{PROFILE_LABELS[session.permissionProfile]}</Badge>
      {session.workItemRef ? <Badge tone="accent">{session.workItemRef}</Badge> : null}
      <span className="ml-auto text-ink-muted">
        Turn {Math.max(1, view?.turnCount ?? 0)} · {elapsed(session.createdAt, session.endedAt)} · {usageText}
      </span>
      <Button size="dense" variant="ghost" onClick={() => set({ protocolSessionId: session.id })}>
        Protocol
      </Button>
    </div>
  );
}

/** WA-03: the agent's plan, live. Hidden when no plan was sent. */
function PlanPanel({ sessionId }: { sessionId: string }) {
  const plan = useStore((s) => s.views[sessionId]?.plan ?? EMPTY);
  if (!plan.length) return null;
  return (
    <section aria-label="Plan" className="mx-4 mt-3 flex flex-col gap-1.5 rounded-[var(--radius)] border border-line bg-surface p-3">
      <SectionLabel>Plan</SectionLabel>
      {plan.map((p, i) => (
        <div key={i} className={cx(p.status === 'completed' && 'text-ink-muted line-through', p.status === 'in_progress' && 'font-semibold')}>
          {p.content}
          {p.status === 'in_progress' ? ' · in progress' : p.status === 'completed' ? ' · done' : ''}
        </div>
      ))}
    </section>
  );
}

/** WA-01: virtualised, streaming appends only touch the last row. */
function Timeline({ sessionId }: { sessionId: string }) {
  const items = useStore((s) => s.views[sessionId]?.items ?? EMPTY);
  const parentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (i) => items[i]?.key ?? i,
  });
  const lastText = items.at(-1)?.kind === 'agent-message' ? (items.at(-1) as { text: string }).text.length : 0;
  useEffect(() => {
    if (stick.current && items.length) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items.length, lastText, virtualizer]);

  if (!items.length) {
    return (
      <div className="flex-1">
        <EmptyState title="Waiting for the agent" body="The worktree is being prepared. Messages, tool calls and approvals appear here." />
      </div>
    );
  }
  return (
    <div
      ref={parentRef}
      className="min-h-0 flex-1 overflow-auto px-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute left-0 w-full py-1.5" style={{ transform: `translateY(${v.start}px)` }}>
            <TimelineRow item={items[v.index]!} sessionId={sessionId} />
          </div>
        ))}
      </div>
      <div className="pb-3">
        <QueuedMessages sessionId={sessionId} />
      </div>
    </div>
  );
}

/** ST-03 chips, ST-04 slash commands, SR-01..SR-05 steering. */
export function Composer({ session }: { session: Session }) {
  const view = useStore((s) => s.views[session.id]);
  const attachments = useStore((s) => s.attachments[session.id] ?? EMPTY);
  const detach = useStore((s) => s.detach);
  const attach = useStore((s) => s.attach);
  const takeAttachments = useStore((s) => s.takeAttachments);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const busy = isLive(session.state) || session.state === 'queued';
  const ended = session.state === 'landed' || session.state === 'discarded';
  const slash = text.startsWith('/') && !text.includes(' ') ? (view?.commands ?? []).filter((c) => `/${c.name}`.startsWith(text)) : [];
  const label = `Message ${agentLabel(session.agentId)}`;

  const send = async (mode: 'send' | 'interrupt') => {
    const content: PromptBlock[] = textPrompt(text, attachments);
    if (!content.length) return;
    const ok = await attempt(() =>
      mode === 'interrupt' ? host.call('sessions.interrupt', { sessionId: session.id, content }) : host.call('sessions.prompt', { sessionId: session.id, content }),
    );
    if (ok) {
      setText('');
      takeAttachments(session.id);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (slash[0] && text !== `/${slash[0].name}`) setText(`/${slash[0].name} `);
      else void send('send');
    }
    if (e.key === 'Escape' && busy) void attempt(() => host.call('sessions.cancel', { sessionId: session.id }));
  };

  if (ended) {
    return <div className="border-t border-line bg-surface px-4 py-3 text-ink-muted">This session has {session.state === 'landed' ? 'landed' : 'been discarded'}. Its history stays here, read-only.</div>;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-surface px-4 py-3">
      <label htmlFor={`composer-${session.id}`} className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
        {label}
      </label>
      {attachments.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent-tint py-0.5 pr-1 pl-2.5 text-[12px] text-accent-soft">
              {a.type === 'resource' ? a.name : a.type === 'image' ? 'Image' : 'Text'}
              <button type="button" aria-label={`Remove ${a.type === 'resource' ? a.name : 'attachment'}`} onClick={() => detach(session.id, i)} className="min-h-6 min-w-6 rounded-full hover:bg-surface">
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <textarea
          id={`composer-${session.id}`}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={busy ? 'Type a follow-up. It is queued until the turn ends.' : 'Ask for a change, or type / for commands.'}
          className="w-full resize-y rounded-[var(--radius)] border border-line bg-bg p-2.5 text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none"
        />
        {slash.length ? (
          <ul role="listbox" aria-label="Slash commands" className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-80 overflow-auto rounded-[var(--radius)] border border-line bg-surface p-1 shadow-xl">
            {slash.map((c) => (
              <li key={c.name} role="option" aria-selected={false}>
                <button type="button" className="flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent-tint" onClick={() => setText(`/${c.name} `)}>
                  <span className="font-mono">/{c.name}</span>
                  <span className="text-[12px] text-ink-muted">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="dense" onClick={() => setPicker(true)} disabled={!session.worktreePath}>
          Attach file
        </Button>
        {view?.modes.length ? (
          <>
            <label htmlFor={`mode-${session.id}`} className="sr-only">
              Mode
            </label>
            <select
              id={`mode-${session.id}`}
              value={view.modeId ?? ''}
              onChange={(e) => void attempt(() => host.call('sessions.setMode', { sessionId: session.id, modeId: e.target.value }))}
              className="min-h-9 rounded-[var(--radius)] border border-line bg-surface px-2 text-ink"
            >
              {view.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  Mode: {m.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-[12px] text-ink-muted">Modes: not supported</span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {busy ? (
            <>
              <Button size="dense" variant="ghost" onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId: session.id }))}>
                Cancel turn
              </Button>
              <Button size="dense" onClick={() => void send('interrupt')} disabled={!text.trim() && !attachments.length}>
                Interrupt and send
              </Button>
              <Button size="dense" variant="primary" onClick={() => void send('send')} disabled={!text.trim() && !attachments.length}>
                Queue message
              </Button>
            </>
          ) : (
            <Button size="dense" variant="primary" onClick={() => void send('send')} disabled={!text.trim() && !attachments.length}>
              Send
            </Button>
          )}
        </div>
      </div>
      {picker && session.worktreePath ? (
        <FilePicker
          root={session.worktreePath}
          onClose={() => setPicker(false)}
          onPick={async (rel) => {
            const file = await attempt(() => host.call('files.read', { path: joinPath(session.worktreePath!, rel) }));
            if (file) attach(session.id, attachmentText(rel, file.content, `file:///${rel}`));
            setPicker(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function SessionView() {
  const session = useStore(selectedSession);
  const set = useStore((s) => s.set);
  const hasWorkspace = useStore((s) => !!s.workspaceId);
  const memoSession = useMemo(() => session, [session]);
  if (!memoSession) {
    return (
      <EmptyState
        title={hasWorkspace ? 'No session selected' : 'Open a repository to begin'}
        body={hasWorkspace ? 'A session is one conversation with one agent in its own Git worktree.' : 'ADE works on Git repositories. Each session gets its own worktree, so your checkout is never touched.'}
        action={hasWorkspace ? <Button variant="primary" onClick={() => set({ newSession: {} })}>New session</Button> : undefined}
      />
    );
  }
  return (
    <main className="flex h-full min-w-0 flex-col" aria-label="Session">
      <SessionHeader session={memoSession} />
      <PlanPanel sessionId={memoSession.id} />
      <Timeline sessionId={memoSession.id} />
      <Composer session={memoSession} />
    </main>
  );
}

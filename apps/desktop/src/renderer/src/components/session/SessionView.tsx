import { ArrowRightLeft, CircleStop, Columns2, ExternalLink, LayoutGrid, ListPlus, LoaderCircle, MessageSquareText, MessagesSquare, Paperclip, Plus, ReceiptText, Repeat2, ScrollText, SendHorizontal, Zap } from 'lucide-react';
import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { PromptBlock, Session } from '@ade/contracts';
import { intensity, isBusy, isLive, loopTitle, STATE_LABELS } from '@ade/session-core';
import { ActivityWave } from '../observe/Teams.tsx';
import { useTick } from '../../lib/teams.ts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { host } from '../../lib/bridge.ts';
import { agentLabel, attachmentText, elapsed, joinPath, PROFILE_LABELS, SANDBOX_LABELS, textPrompt } from '../../lib/format.ts';
import { attempt, selectedSession, useStore, EMPTY } from '../../lib/store.ts';
import { agentUiCommand } from '../../lib/agent-ui.ts';
import { useTerminals } from '../../lib/terminals.ts';
import { useReceipts } from '../../lib/receipts.ts';
import { sendChecked } from '../../lib/guards.ts';
import { FilePicker } from '../FilePicker.tsx';
import { defaultComposer, useComposer } from '../../lib/composer.ts';
import { boardPrompt } from '../../lib/prompt-board.ts';
import { PromptBoard } from './PromptBoard.tsx';
import { ReasoningPicker } from './ReasoningPicker.tsx';
import { QueuedMessages, TimelineRow } from './TimelineItems.tsx';

function stateTone(s: Session['state']) {
  return s === 'waiting-on-user' || s === 'interrupted' ? 'attention' : s === 'working' || s === 'starting' ? 'accent' : s === 'ready' ? 'ok' : 'neutral';
}

/** WA-04: state, agent and version, branch, sandbox badge, elapsed time, usage or "not reported". */
export function SessionHeader({ session }: { session: Session }) {
  const view = useStore((s) => s.views[session.id]);
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agentId));
  const loop = useStore((s) => s.activity[session.id]?.loop ?? null);
  const { open: receiptOpen } = useReceipts(session.id);
  const set = useStore((s) => s.set);
  const ended = session.state === 'landed' || session.state === 'discarded';
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
      {loop ? (
        <Badge tone="attention" title={loopTitle(loop)}>
          <Repeat2 className="size-3.5" aria-hidden="true" />
          May be looping
        </Badge>
      ) : null}
      {receiptOpen.length ? (
        <Badge tone="attention" title={receiptOpen.map((i) => `Turn ${i.turnIndex + 1}: ${i.text}`).join('\n')}>
          <ReceiptText className="size-3.5" aria-hidden="true" />
          {receiptOpen.length} to check
        </Badge>
      ) : null}
      <Badge>
        {agentLabel(session.agentId)}
        {agent?.version ? ` ${agent.version.replace(/^[^\d]*/, '').split(' ')[0]}` : ''}
      </Badge>
      {session.branch ? <Badge className="font-mono text-[12px]">{session.branch}</Badge> : null}
      <Badge
        tone={session.sandboxState === 'sandboxed' ? 'ok' : session.sandboxState === 'commands-sandboxed' ? 'accent' : 'attention'}
        title={
          session.containment === 'none'
            ? 'Derived from the agent and this platform, never assumed'
            : `${session.containment === 'wsl' ? 'Inside WSL2 and bubblewrap' : 'Inside bubblewrap'}: writes are limited to the worktree, its Git data and the agent's own folders. Reads and the network are not limited.`
        }
      >
        {SANDBOX_LABELS[session.sandboxState]}
        {session.containment === 'wsl' ? ' in WSL' : ''}
      </Badge>
      {session.inPlace ? (
        <Badge tone="attention" title="Works in your checkout; Discard restores the snapshot taken when it started">
          In your checkout
        </Badge>
      ) : null}
      <Badge>{PROFILE_LABELS[session.permissionProfile]}</Badge>
      {session.workItemRef ? <Badge tone="accent">{session.workItemRef}</Badge> : null}
      <span className="ml-auto text-ink-muted">
        Turn {Math.max(1, view?.turnCount ?? 0)} · {elapsed(session.createdAt, session.endedAt)} · {usageText}
      </span>
      {session.compareGroup ? (
        <Button size="dense" variant="ghost" onClick={() => set({ compareGroup: session.compareGroup })} icon={<Columns2 className="size-4" aria-hidden="true" />}>
          Compare
        </Button>
      ) : null}
      <Button size="dense" variant="ghost" disabled={ended || isLive(session.state)} title={isLive(session.state) ? 'Wait for the turn to finish' : undefined} onClick={() => set({ handOffSessionId: session.id })} icon={<ArrowRightLeft className="size-4" aria-hidden="true" />}>
        Hand off
      </Button>
      <OpenInAgentUi session={session} ended={ended} />
      <Button size="dense" variant="ghost" onClick={() => set({ protocolSessionId: session.id })} icon={<ScrollText className="size-4" aria-hidden="true" />}>
        Protocol
      </Button>
    </div>
  );
}

/** SR-08: continue the conversation in the agent's own terminal UI. ADE's connection stops first. */
function OpenInAgentUi({ session, ended }: { session: Session; ended: boolean }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === session.agentId));
  const ask = useStore((s) => s.ask);
  const set = useStore((s) => s.set);
  const createTerminal = useTerminals((t) => t.create);
  const ui = agentUiCommand(session.agentId, session.agentSessionId);
  if (!ui || !agent?.path || ended || !session.worktreePath) return null;
  const wsl = session.containment === 'wsl';
  return (
    <Button icon={<ExternalLink className="size-4" aria-hidden="true" />}
      size="dense"
      variant="ghost"
      disabled={wsl || isLive(session.state)}
      title={wsl ? 'This session runs inside WSL; open the agent from a WSL shell.' : isLive(session.state) ? 'Wait for the turn to finish' : undefined}
      onClick={() =>
        ask({
          title: `Open in ${agent.label}'s own UI?`,
          body: `${ui.resumes ? `${agent.label} resumes this conversation` : `${agent.label} cannot resume this conversation from ADE, so its UI starts a new one`} in the session worktree. ADE stops its own connection first; sending a message here later reconnects.${session.containment !== 'none' ? " The agent's own UI runs outside ADE's sandbox." : ''}`,
          confirmLabel: 'Open',
          onConfirm: () =>
            void attempt(async () => {
              await host.call('sessions.detach', { sessionId: session.id });
              await createTerminal({ kind: 'agent-ui', cwd: session.worktreePath!, sessionId: session.id, command: ui.command, title: `${agent.label} UI` });
              set({ tab: 'terminals' });
              return true;
            }),
        })
      }
    >
      Open in {agent.label}
    </Button>
  );
}

/** WA-03: the agent's plan, live. Hidden when no plan was sent. */
function PlanPanel({ sessionId }: { sessionId: string }) {
  const plan = useStore((s) => s.views[sessionId]?.plan ?? EMPTY);
  if (!plan.length) return null;
  return (
    <section aria-label="Plan" className="mx-4 mt-3 flex max-h-32 shrink-0 flex-col gap-1.5 overflow-auto rounded-[var(--radius)] border border-line bg-surface p-3">
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
        <EmptyState icon={<LoaderCircle className="size-5" />} title="Waiting for the agent" body="The worktree is being prepared. Messages, tool calls and approvals appear here." />
      </div>
    );
  }
  return (
    <div
      ref={parentRef}
      className="min-h-40 flex-1 overflow-auto px-4"
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

/** ST-03 chips, ST-04 slash commands, SR-01..SR-05 steering, GN-01 generation method, GN-02 prompt board. */
export function Composer({ session }: { session: Session }) {
  const view = useStore((s) => s.views[session.id]);
  const attachments = useStore((s) => s.attachments[session.id] ?? EMPTY);
  const detach = useStore((s) => s.detach);
  const attach = useStore((s) => s.attach);
  const takeAttachments = useStore((s) => s.takeAttachments);
  const stored = useComposer((c) => c.states[session.id]);
  const composer = stored ?? defaultComposer();
  const loadComposer = useComposer((c) => c.load);
  const updateComposer = useComposer((c) => c.update);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const busy = isLive(session.state) || session.state === 'queued';
  const ended = session.state === 'landed' || session.state === 'discarded';
  const board = composer.mode === 'board';
  const reasoning = !!view?.reasoningRunId;
  const method = composer.reasoning.method;
  const slash = !board && text.startsWith('/') && !text.includes(' ') ? (view?.commands ?? []).filter((c) => `/${c.name}`.startsWith(text)) : [];
  const label = `Message ${agentLabel(session.agentId)}`;
  const boxes = useComposer((c) => c.boards[session.workspaceId]);
  const draft = board ? boardPrompt(boxes ?? []) : text;
  const empty = !draft.trim() && !attachments.length;
  const waitForReasoning = reasoning && method !== 'io';

  useEffect(() => {
    void loadComposer(session.id);
  }, [session.id, loadComposer]);

  // WA-10: "Redirect the agent" leaves a draft for this session. It is read from the store, not from the render, so
  // StrictMode's second run of the effect finds it already taken and does nothing; the focus is never cancelled.
  const composerDraft = useStore((s) => s.composerDraft);
  useEffect(() => {
    const pending = useStore.getState().composerDraft;
    if (!pending || pending.sessionId !== session.id) return;
    useStore.getState().set({ composerDraft: null });
    setText(pending.text);
    if (useComposer.getState().states[session.id]?.mode === 'board') updateComposer(session.id, (s) => ({ ...s, mode: 'chat' }));
    requestAnimationFrame(() => {
      const box = document.getElementById(`composer-${session.id}`);
      if (box instanceof HTMLTextAreaElement) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    });
  }, [composerDraft, session.id, updateComposer]);

  const send = async (mode: 'send' | 'interrupt') => {
    const content: PromptBlock[] = textPrompt(draft, attachments);
    if (!content.length) return;
    const all = content.map((b) => ('text' in b ? b.text : '')).join('\n');
    sendChecked(all, async () => {
      // Interrupting sends the words as written: reasoning first would leave the agent idle meanwhile.
      const ok = await attempt<unknown>(() =>
        mode === 'interrupt'
          ? host.call('sessions.interrupt', { sessionId: session.id, content })
          : method === 'io'
            ? host.call('sessions.prompt', { sessionId: session.id, content })
            : host.call('sessions.promptReasoned', { sessionId: session.id, content, settings: composer.reasoning }),
      );
      if (ok) {
        // The board stays as it is so it can be reused; the chat box is cleared.
        if (!board) setText('');
        takeAttachments(session.id);
      }
    });
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
      <div className="flex flex-wrap items-center gap-2">
        {board ? (
          <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">{label}</span>
        ) : (
          <label htmlFor={`composer-${session.id}`} className="text-[11px] font-semibold tracking-[0.06em] text-ink-muted uppercase">
            {label}
          </label>
        )}
        <div role="radiogroup" aria-label="Prompt style" className="ml-auto flex gap-0.5 rounded-[var(--radius)] border border-line bg-surface-sunken p-0.5">
          {(
            [
              ['chat', 'Chat', MessageSquareText],
              ['board', 'Board', LayoutGrid],
            ] as const
          ).map(([mode, name, Icon]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={composer.mode === mode}
              onClick={() => updateComposer(session.id, (s) => ({ ...s, mode }))}
              className={cx(
                'flex min-h-7 items-center gap-1.5 rounded-[var(--radius-small)] px-2.5 text-[12px]',
                composer.mode === mode ? 'bg-accent-tint font-semibold text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {name}
            </button>
          ))}
        </div>
      </div>
      {attachments.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Attachments">
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-[var(--radius-small)] border border-accent bg-accent-tint px-2 py-0.5 text-[12px] text-accent-soft">
              {a.type === 'resource' ? a.name : a.type === 'image' ? 'Image' : 'Text'}
              <button type="button" aria-label={`Remove ${a.type === 'resource' ? a.name : 'attachment'}`} onClick={() => detach(session.id, i)} className="min-h-6 min-w-6 rounded-full hover:bg-surface">
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {board ? (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!empty && !waitForReasoning) void send('send');
            }
          }}
        >
          <PromptBoard workspaceId={session.workspaceId} />
        </div>
      ) : (
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
          <ul role="listbox" aria-label="Slash commands" className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-80 overflow-auto rounded-[var(--radius)] ade-pop border border-line bg-[var(--surface-glass)] p-1 shadow-[var(--shadow-pop)] backdrop-blur-xl">
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
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="dense" onClick={() => setPicker(true)} disabled={!session.worktreePath} icon={<Paperclip className="size-4" aria-hidden="true" />}>
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
              className="min-h-9 rounded-[var(--radius)] border border-line bg-surface px-3 text-ink"
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
        <ReasoningPicker sessionId={session.id} agent={agentLabel(session.agentId)} />
        <div className="ml-auto flex flex-wrap gap-2">
          {reasoning ? (
            <Button size="dense" variant="ghost" onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId: session.id }))} icon={<CircleStop className="size-4" aria-hidden="true" />}>
              Cancel reasoning
            </Button>
          ) : null}
          {busy ? (
            <>
              <Button size="dense" variant="ghost" onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId: session.id }))} icon={<CircleStop className="size-4" aria-hidden="true" />}>
                Cancel turn
              </Button>
              <Button size="dense" onClick={() => void send('interrupt')} disabled={empty} title={method !== 'io' ? 'Sends your words as written, without reasoning first' : undefined} icon={<Zap className="size-4" aria-hidden="true" />}>
                Interrupt and send
              </Button>
              <Button size="dense" variant="primary" onClick={() => void send('send')} disabled={empty || waitForReasoning} icon={<ListPlus className="size-4" aria-hidden="true" />}>
                Queue message
              </Button>
            </>
          ) : (
            <Button
              size="dense"
              variant="primary"
              onClick={() => void send('send')}
              disabled={empty || waitForReasoning}
              title={waitForReasoning ? 'Wait for reasoning to finish, or cancel it' : board ? 'Send the selected boxes (Ctrl Enter)' : undefined}
              icon={<SendHorizontal className="size-4" aria-hidden="true" />}
            >
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

/** WA-08: the header's activity wave, in its own component so its ticks do not re-render the timeline. */
function SessionWave({ session }: { session: Session }) {
  const now = useTick(500);
  const activity = useStore((s) => s.activity[session.id]);
  // Reasoning agents work for the session before its turn starts (GN-01), so they move the wave too.
  const reasoning = useStore((s) => !!s.views[session.id]?.reasoningRunId);
  const busy = session.state === 'working' && !!activity && isBusy(activity.phase);
  const level = busy && activity ? Math.max(0.12, intensity(activity.times, now)) : reasoning ? 0.6 : 0;
  return <ActivityWave active={busy || reasoning} level={level} />;
}

export function SessionView() {
  const session = useStore(selectedSession);
  const set = useStore((s) => s.set);
  const hasWorkspace = useStore((s) => !!s.workspaceId);
  const memoSession = useMemo(() => session, [session]);
  if (!memoSession) {
    return (
      <EmptyState icon={<MessagesSquare className="size-5" />}
        title={hasWorkspace ? 'No session selected' : 'Open a repository to begin'}
        body={hasWorkspace ? 'A session is one conversation with one agent in its own Git worktree.' : 'ADE works on Git repositories. Each session gets its own worktree, so your checkout is never touched.'}
        action={hasWorkspace ? <Button icon={<Plus className="size-4" aria-hidden="true" />} variant="primary" onClick={() => set({ newSession: {} })}>New session</Button> : undefined}
      />
    );
  }
  return (
    <main className="flex h-full min-w-0 flex-col overflow-y-auto" aria-label="Session">
      <SessionHeader session={memoSession} />
      <SessionWave session={memoSession} />
      <PlanPanel sessionId={memoSession.id} />
      <Timeline sessionId={memoSession.id} />
      <Composer session={memoSession} />
    </main>
  );
}

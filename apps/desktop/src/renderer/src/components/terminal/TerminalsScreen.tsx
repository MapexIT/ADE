import * as Menu from '@radix-ui/react-dropdown-menu';
import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { AgentId, ShellKind, TerminalInfo } from '@ade/contracts';
import { STATE_LABELS } from '@ade/session-core';
import { useMemo, useState } from 'react';
import { agentLabel, basename } from '../../lib/format.ts';
import { attempt, currentWorkspace, selectedSession, useStore, EMPTY } from '../../lib/store.ts';
import { useTerminals } from '../../lib/terminals.ts';
import { SavedCommands } from './SavedCommands.tsx';
import { AskBar, HistoryDialog, SuggestionsBar, useTerminalLayout } from './TerminalExtras.tsx';
import { SmartBlocks } from './SmartBlocks.tsx';
import { TerminalView } from './TerminalView.tsx';

import { AGENT_COMMANDS } from '../../lib/agent-ui.ts';

/** SM-03: each segment hides when it has no data. */
export function StatusBar({ terminal }: { terminal: TerminalInfo }) {
  const session = useStore((s) => (terminal.sessionId ? s.sessions[terminal.sessionId] : null));
  const workspace = useStore(currentWorkspace);
  const usage = useStore((s) => (terminal.sessionId ? s.views[terminal.sessionId]?.usage : null));
  const blocks = useTerminals((t) => t.blocks[terminal.id] ?? EMPTY);
  const lastDone = [...blocks].reverse().find((b) => b.endedAt !== null);
  const running = blocks.find((b) => b.endedAt === null);
  const segments: { key: string; text: string; tone?: string }[] = [];
  segments.push({ key: 'loc', text: `${workspace?.name ?? ''} / ${basename(terminal.cwd)}` });
  if (session?.branch) segments.push({ key: 'git', text: session.branch });
  if (session) segments.push({ key: 'session', text: `${agentLabel(session.agentId)} · ${STATE_LABELS[session.state].toLowerCase()} · ${session.sandboxState.replace('-', ' ')}`, tone: session.state === 'waiting-on-user' ? 'text-attention' : undefined });
  if (running) segments.push({ key: 'proc', text: running.command });
  if (lastDone) segments.push({ key: 'exit', text: `last exit ${lastDone.exitCode}`, tone: lastDone.exitCode ? 'text-danger' : undefined });
  if (terminal.agentState !== 'none') segments.push({ key: 'agent', text: `agent ${terminal.agentState}`, tone: terminal.agentState === 'waiting' ? 'text-attention' : undefined });
  if (session) segments.push({ key: 'usage', text: usage?.inputTokens != null ? `${usage.inputTokens.toLocaleString('en-GB')} tokens` : 'usage not reported', tone: 'text-ink-muted' });
  if (session?.workItemRef) segments.push({ key: 'wi', text: session.workItemRef });
  return (
    <div aria-label="Status bar" className="flex flex-wrap border-t border-line bg-[#131922] font-mono text-[12px]">
      {segments.map((s) => (
        <span key={s.key} className={cx('border-r border-line px-3 py-1.5', s.tone)}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

export function NewTerminalMenu({ cwd, sessionId, compact }: { cwd: string | null; sessionId: string | null; compact?: boolean }) {
  const shells = useTerminals((t) => t.shells);
  const createTerminal = useTerminals((t) => t.create);
  const agents = useStore((s) => s.agents);
  if (!cwd) return null;
  const make = (kind: 'smart' | 'plain', shell?: ShellKind) => void attempt(() => createTerminal({ kind, cwd, sessionId, ...(shell ? { shell } : {}) }));
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size="dense" variant={compact ? 'ghost' : 'primary'} aria-label="New terminal">
          {compact ? '+' : 'New terminal'}
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content sideOffset={6} className="z-50 min-w-56 rounded-[var(--radius)] border border-line bg-surface p-1 shadow-xl">
          {shells.map((s) => (
            <Menu.Item key={`smart-${s.id}`} onSelect={() => make('smart', s.id)} className="flex min-h-9 cursor-pointer items-center rounded px-3 outline-none data-[highlighted]:bg-accent-tint">
              Smart · {s.label}
            </Menu.Item>
          ))}
          <Menu.Separator className="my-1 h-px bg-line" />
          {shells.map((s) => (
            <Menu.Item key={`plain-${s.id}`} onSelect={() => make('plain', s.id)} className="flex min-h-9 cursor-pointer items-center rounded px-3 outline-none data-[highlighted]:bg-accent-tint">
              Plain · {s.label}
            </Menu.Item>
          ))}
          {sessionId ? <Menu.Separator className="my-1 h-px bg-line" /> : null}
          {sessionId
            ? agents
                .filter((a) => a.id !== 'fake' && a.path)
                .map((a) => (
                  <Menu.Item
                    key={a.id}
                    onSelect={() => void attempt(() => createTerminal({ kind: 'agent-ui', cwd, sessionId, command: [AGENT_COMMANDS[a.id as Exclude<AgentId, 'fake'>]], title: `${a.label} UI` }))}
                    className="flex min-h-9 cursor-pointer items-center rounded px-3 outline-none data-[highlighted]:bg-accent-tint"
                  >
                    Start {a.label} UI
                  </Menu.Item>
                ))
            : null}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function TerminalBody({ terminal }: { terminal: TerminalInfo & { exited: boolean } }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cx('flex min-h-0 flex-1', terminal.kind === 'agent-ui' && terminal.agentState === 'waiting' && 'attention-ring border-2')}>
        <div className="min-h-0 min-w-0 flex-1">
          <TerminalView id={terminal.id} autoFocus />
        </div>
        {terminal.smart ? (
          <div className="hidden min-h-0 w-[42%] max-w-xl border-l border-line lg:block">
            <SmartBlocks terminalId={terminal.id} />
          </div>
        ) : null}
      </div>
      {terminal.smart ? <StatusBar terminal={terminal} /> : null}
    </div>
  );
}

/** Screen 2: terminal list by worktree, the active terminal and its blocks. */
export function TerminalsScreen() {
  const terminals = useTerminals((t) => t.terminals);
  const active = useTerminals((t) => t.active);
  const setActive = useTerminals((t) => t.setActive);
  const close = useTerminals((t) => t.close);
  const sessions = useStore((s) => s.sessions);
  const session = useStore(selectedSession);
  const workspace = useStore(currentWorkspace);
  const cwd = session?.worktreePath ?? workspace?.rootPath ?? null;
  const [history, setHistory] = useState(false);
  const layout = useTerminalLayout();

  const groups = useMemo(() => {
    const map = new Map<string, (TerminalInfo & { exited: boolean })[]>();
    for (const t of Object.values(terminals)) {
      const key = t.sessionId ? (sessions[t.sessionId]?.title ?? 'Session') : 'Your checkout';
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return [...map.entries()];
  }, [terminals, sessions]);

  const current = active ? terminals[active] : undefined;
  return (
    <div className="flex h-full min-h-0">
      <aside aria-label="Terminals" className="flex w-64 flex-col gap-2 overflow-auto border-r border-line bg-surface p-3">
        {groups.map(([label, list]) => (
          <section key={label} className="flex flex-col gap-2">
            <SectionLabel>{label}</SectionLabel>
            {list.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                className={cx(
                  'flex min-h-11 flex-col gap-0.5 rounded-[var(--radius)] border px-3 py-2 text-left',
                  t.agentState === 'waiting' ? 'border-2 border-attention-line bg-attention-tint' : t.id === active ? 'border-2 border-accent bg-accent-tint' : 'border-line',
                )}
              >
                <span className="font-semibold">{t.title}</span>
                <span className="text-ink-muted">
                  {t.exited ? 'Exited' : t.agentState === 'waiting' ? 'Waiting for you' : t.agentState === 'working' ? 'Working' : t.smart ? 'Smart' : 'Plain'}
                </span>
              </button>
            ))}
          </section>
        ))}
        <div className="mt-auto flex flex-col gap-2">
          {layout.offer ? (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-accent p-2" role="status">
              <span className="text-[12px]">
                {layout.offer.terminals.length} terminal(s) from your last session, with their scrollback.
              </span>
              <div className="flex gap-2">
                <Button size="dense" variant="primary" onClick={() => void layout.restore()}>
                  Restore terminals
                </Button>
                <Button size="dense" variant="ghost" onClick={layout.dismiss}>
                  Not now
                </Button>
              </div>
            </div>
          ) : null}
          <Button size="dense" variant="ghost" onClick={() => setHistory(true)}>
            Command history
          </Button>
          <NewTerminalMenu cwd={cwd} sessionId={session?.worktreePath ? session.id : null} />
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
              <span className="font-semibold">{current.title}</span>
              <Badge>{current.smart ? 'Smart' : current.kind === 'agent-ui' ? 'Agent UI' : 'Plain · no blocks, no status bar'}</Badge>
              <span className="truncate font-mono text-[12px] text-ink-muted">{current.cwd}</span>
              <span className="ml-auto" />
              <SavedCommands terminalId={current.id} disabled={current.exited || current.kind === 'agent-ui'} />
              <Button size="dense" variant="ghost" onClick={() => void close(current.id)}>
                Close terminal
              </Button>
            </div>
            <SuggestionsBar terminal={current} />
            <AskBar terminal={current} />
            <div className="min-h-0 flex-1">
              <TerminalBody key={current.id} terminal={current} />
            </div>
          </>
        ) : (
          <EmptyState title="No terminal open" body="Smart terminals turn every command into a block with its exit code. Plain terminals are just a shell." action={<NewTerminalMenu cwd={cwd} sessionId={session?.worktreePath ? session.id : null} />} />
        )}
      </main>
      <HistoryDialog open={history} onClose={() => setHistory(false)} terminalId={current && !current.exited ? current.id : null} />
    </div>
  );
}

/** Bottom strip in the sessions layout: the selected session's terminals (TM-02). */
export function TerminalPanel() {
  const session = useStore(selectedSession);
  const workspace = useStore(currentWorkspace);
  const terminals = useTerminals((t) => t.terminals);
  const active = useTerminals((t) => t.active);
  const setActive = useTerminals((t) => t.setActive);
  const close = useTerminals((t) => t.close);
  const sessionId = session?.worktreePath ? session.id : null;
  const list = Object.values(terminals).filter((t) => t.sessionId === sessionId);
  const current = list.find((t) => t.id === active) ?? list[0];
  const cwd = session?.worktreePath ?? workspace?.rootPath ?? null;
  return (
    <section aria-label="Terminal" className="flex h-full min-h-0 flex-col bg-surface-sunken">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2">
        {list.map((t) => (
          <span key={t.id} className="flex items-center">
            <button type="button" onClick={() => setActive(t.id)} className={cx('min-h-9 border-b-2 px-3 text-[12.5px]', current?.id === t.id ? 'border-accent text-ink' : 'border-transparent text-ink-muted', t.agentState === 'waiting' && 'text-attention')}>
              {t.title}
              {t.agentState === 'waiting' ? ' · waiting' : ''}
            </button>
            <button type="button" aria-label={`Close ${t.title}`} onClick={() => void close(t.id)} className="min-h-9 min-w-7 text-ink-muted hover:text-ink">
              ×
            </button>
          </span>
        ))}
        <NewTerminalMenu cwd={cwd} sessionId={sessionId} compact />
      </div>
      <div className="min-h-0 flex-1">
        {current ? <TerminalBody key={current.id} terminal={current} /> : <p className="m-0 p-3 text-ink-muted">{cwd ? 'No terminals in this worktree yet. Use + to open one.' : 'Open a repository to use terminals.'}</p>}
      </div>
    </section>
  );
}

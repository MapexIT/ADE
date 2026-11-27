import { ClearHistoryButton } from '../ClearHistoryButton.tsx';
import { copyText } from '../../lib/clipboard.ts';
import { CircleStop, Copy, ListFilter, Play, RotateCcw, SendHorizontal, Wrench } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { CommandBlock } from '@ade/contracts';
import { useEffect, useRef, useState } from 'react';
import { host, pty } from '../../lib/bridge.ts';
import { attachmentText, clock, duration } from '../../lib/format.ts';
import { attempt, useStore, EMPTY } from '../../lib/store.ts';
import { clearBlocks, useTerminals } from '../../lib/terminals.ts';
import { runInTerminal, sendChecked } from '../../lib/guards.ts';
import { InlineViewer } from './InlineViewer.tsx';
import { BlockProblems } from './BlockProblems.tsx';
import { BlockFilter } from './BlockFilter.tsx';
import { Linkified } from './Linkified.tsx';
import { WatchControl } from './WatchControl.tsx';
import { filterKey, followFilters, useBlockFilters } from '../../lib/block-filters.ts';

export function blockAsText(b: CommandBlock) {
  return `$ ${b.command}\n${b.output.trimEnd()}\n[exit ${b.exitCode ?? 'unknown'}]`;
}

/** SM-01, SM-06, SM-08, TM-05: command blocks with exit code, duration, re-run, copy and agent actions. */
export function SmartBlocks({ terminalId }: { terminalId: string }) {
  const blocks = useTerminals((t) => t.blocks[terminalId] ?? EMPTY);
  const terminal = useTerminals((t) => t.terminals[terminalId]);
  const attach = useStore((s) => s.attach);
  const toast = useStore((s) => s.toast);
  const setStore = useStore((s) => s.set);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const running = blocks.find((b) => b.endedAt === null);
  const sessionId = terminal?.sessionId ?? null;
  const filters = useBlockFilters((s) => s.byCommand);
  const openFilter = useBlockFilters((s) => s.open);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [blocks.length]);

  // SM-20: a filter follows its command, so a re-run opens already filtered.
  useEffect(() => {
    const cur = useBlockFilters.getState().byCommand;
    const next = followFilters(cur, terminalId, blocks);
    if (next !== cur) useBlockFilters.setState({ byCommand: next });
  }, [blocks, terminalId]);

  const fixWithAgent = async (b: CommandBlock) => {
    if (!sessionId) return toast('Open this terminal in a session worktree to send it to an agent.', 'danger');
    sendChecked(blockAsText(b), async () => {
      const ok = await attempt(() =>
        host.call('sessions.prompt', {
          sessionId,
          content: [{ type: 'text', text: `This command failed with exit code ${b.exitCode}. Find the cause and fix it.` }, attachmentText(`Command: ${b.command}`, blockAsText(b))],
        }),
      );
      if (ok) toast('Sent to the agent.');
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-sunken font-mono text-[12.5px] text-ink">
      {running ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-3 py-2">
          <span className="text-ink-muted">Running</span>
          <span>{running.command}</span>
          <span className="text-ink-muted">since {clock(running.startedAt)}</span>
          <div className="ml-auto flex gap-2 font-sans">
            {terminal ? <WatchControl terminal={terminal} running /> : null}
            <Button icon={<CircleStop className="size-4" aria-hidden="true" />} size="dense" onClick={() => void pty.call('pty.write', { id: terminalId, data: '\x03' })}>
              Stop
            </Button>
          </div>
        </div>
      ) : null}
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3"
        data-blocks-for={terminalId}
        tabIndex={0}
        aria-label="Command blocks. Alt and arrow keys jump between blocks."
        onKeyDown={(e) => {
          if (!e.altKey) return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = Math.max(0, Math.min(blocks.length - 1, (focus === -1 ? blocks.length : focus) + (e.key === 'ArrowUp' ? -1 : 1)));
            setFocus(next);
            listRef.current?.querySelector(`[data-block="${next}"]`)?.scrollIntoView({ block: 'nearest' });
          }
        }}
      >
        {blocks.length === 0 ? <p className="m-0 font-sans text-ink-muted">Commands you run appear here as blocks with their exit code and duration.</p> : null}
        {blocks.some((b) => b.endedAt !== null) ? (
          <div className="flex justify-end font-sans">
            <ClearHistoryButton label="Clear blocks" confirmLabel="Clear finished blocks" onConfirm={() => clearBlocks(terminalId)} />
          </div>
        ) : null}
        {blocks.map((b, i) => {
          const failed = b.exitCode !== null && b.exitCode !== 0;
          const done = b.endedAt !== null;
          const isCollapsed = collapsed.has(b.id);
          const filter = done ? filters[filterKey(terminalId, b.command)] : undefined;
          const filtered = filter?.blockId === b.id;
          return (
            <section
              key={b.id}
              data-block={i}
              data-block-id={b.id}
              data-focused={focus === i || undefined}
              aria-label={`Command block, ${done ? (failed ? 'failed' : 'succeeded') : 'running'}`}
              className={cx('flex flex-col gap-1.5 rounded-[var(--radius-small)] border border-l-[3px] border-line px-3 py-2', failed ? 'border-l-danger bg-danger-tint' : done ? 'border-l-accent' : 'border-l-attention', focus === i && 'outline outline-accent')}
            >
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="text-left" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
                  {b.command || '(command)'}
                </button>
                <span className={cx('ml-auto', failed ? 'text-danger' : done ? 'text-accent-soft' : 'text-attention')}>
                  {done ? `exit ${b.exitCode ?? '?'} · ${duration((b.endedAt ?? 0) - b.startedAt)} · ${clock(b.startedAt)}` : 'running'}
                </span>
              </div>
              {!isCollapsed && filtered ? <BlockFilter terminalId={terminalId} block={b} blocks={blocks} cwd={b.cwd ?? terminal?.cwd ?? null} sessionId={sessionId} /> : null}
              {!isCollapsed && !filtered && b.output.trim() ? (
                <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap text-ink-muted">
                  <Linkified text={b.output.trimEnd()} cwd={b.cwd ?? terminal?.cwd ?? null} sessionId={sessionId} />
                </pre>
              ) : null}
              {!isCollapsed && done ? <InlineViewer block={b} cwd={b.cwd ?? terminal?.cwd ?? null} /> : null}
              {!isCollapsed && done ? <BlockProblems terminalId={terminalId} blockId={b.id} /> : null}
              {done ? (
                <div className="flex flex-wrap gap-2 font-sans text-[13px]">
                  {failed ? (
                    <Button icon={<Wrench className="size-4" aria-hidden="true" />} size="dense" variant="primary" onClick={() => void fixWithAgent(b)}>
                      Fix with agent
                    </Button>
                  ) : null}
                  {failed ? (
                    <Button icon={<Play className="size-4" aria-hidden="true" />}
                      size="dense"
                      onClick={() =>
                        setStore({
                          newSession: {
                            mode: 'workflow',
                            title: `Fix: ${b.command}`,
                            prompt: `The command ${b.command} failed with exit code ${b.exitCode}.`,
                            handOff: { checkOutput: blockAsText(b) },
                          },
                        })
                      }
                    >
                      Run a workflow
                    </Button>
                  ) : null}
                  <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />} size="dense" onClick={() => (sessionId ? sendChecked(blockAsText(b), () => (attach(sessionId, attachmentText(`Command: ${b.command}`, blockAsText(b))), toast('Attached to the next prompt.'))) : toast('This terminal is not linked to a session.', 'danger'))}>
                    Send to agent
                  </Button>
                  <Button icon={<RotateCcw className="size-4" aria-hidden="true" />} size="dense" onClick={() => runInTerminal(terminalId, b.command)}>
                    Re-run
                  </Button>
                  <Button icon={<Copy className="size-4" aria-hidden="true" />} size="dense" onClick={() => void copyText(blockAsText(b))}>
                    Copy output
                  </Button>
                  <Button
                    icon={<ListFilter className="size-4" aria-hidden="true" />}
                    size="dense"
                    data-action="filter"
                    aria-pressed={filtered}
                    title="Filter this block's output (Ctrl+Shift+L)"
                    onClick={() => {
                      if (isCollapsed) setCollapsed((c) => { const n = new Set(c); n.delete(b.id); return n; });
                      openFilter(terminalId, b);
                    }}
                  >
                    Filter
                  </Button>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

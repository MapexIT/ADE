import { copyText } from '../../lib/clipboard.ts';
import { CircleStop, Copy, Play, RotateCcw, SendHorizontal, Wrench } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { CommandBlock } from '@ade/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { host, main, pty } from '../../lib/bridge.ts';
import { attachmentText, clock, duration, joinPath } from '../../lib/format.ts';
import { attempt, useStore, EMPTY } from '../../lib/store.ts';
import { useTerminals } from '../../lib/terminals.ts';
import { runInTerminal, sendChecked } from '../../lib/guards.ts';
import { InlineViewer } from './InlineViewer.tsx';
import { BlockProblems } from './BlockProblems.tsx';

const LINK = /(https?:\/\/[^\s'"<>]+)|((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z0-9]{1,8}):(\d+)(?::(\d+))?/g;

/** SM-07: file paths with line numbers open in the editor; links open in the browser. */
function Linkified({ text, cwd, sessionId }: { text: string; cwd: string | null; sessionId: string | null }) {
  const openEditor = useStore((s) => s.openEditor);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const idx = m.index ?? 0;
    out.push(text.slice(last, idx));
    if (m[1]) {
      const url = m[1];
      out.push(
        <a key={idx} href={url} className="text-accent underline" onClick={(e) => (e.preventDefault(), void attempt(() => main('main.openExternal', { url })))}>
          {url}
        </a>,
      );
    } else if (m[2] && cwd) {
      const path = /^([A-Za-z]:|\/)/.test(m[2]) ? m[2] : joinPath(cwd, m[2]);
      out.push(
        <button key={idx} type="button" className="text-accent underline" onClick={() => openEditor(path, sessionId, Number(m[3]))}>
          {m[0]}
        </button>,
      );
    } else out.push(m[0]);
    last = idx + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

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

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [blocks.length]);

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
          <Button icon={<CircleStop className="size-4" aria-hidden="true" />} size="dense" className="ml-auto" onClick={() => void pty.call('pty.write', { id: terminalId, data: '\x03' })}>
            Stop
          </Button>
        </div>
      ) : null}
      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3"
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
        {blocks.map((b, i) => {
          const failed = b.exitCode !== null && b.exitCode !== 0;
          const done = b.endedAt !== null;
          const isCollapsed = collapsed.has(b.id);
          return (
            <section
              key={b.id}
              data-block={i}
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
              {!isCollapsed && b.output.trim() ? (
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
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

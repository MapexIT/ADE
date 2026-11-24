import { CircleStop, Maximize2 } from 'lucide-react';
import { Badge, Button } from '@ade/ui';
import type { TimelineItem } from '@ade/session-core';
import { useEffect, useRef, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { attempt } from '../../lib/store.ts';
import { Modal } from '../Modal.tsx';

type Command = Extract<TimelineItem, { kind: 'command' }>;

/** Removes terminal colour and cursor sequences so output reads as plain text in the card. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const plainOutput = (s: string) => s.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export function commandStatus(c: Pick<Command, 'running' | 'killed' | 'exitCode' | 'signal'>): { label: string; tone: 'accent' | 'ok' | 'danger' | 'neutral' } {
  if (c.running) return { label: 'Running', tone: 'accent' };
  if (c.killed) return { label: 'Stopped', tone: 'neutral' };
  if (c.exitCode === 0) return { label: 'Exit 0', tone: 'ok' };
  if (c.exitCode !== null) return { label: `Exit ${c.exitCode}`, tone: 'danger' };
  return { label: c.signal ? `Ended (${c.signal})` : 'Ended', tone: 'danger' };
}

const PREVIEW_LINES = 12;

function Output({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // Follow the end of the output while it grows, like a terminal.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <pre ref={ref} className={className} tabIndex={0}>
      {text || ' '}
    </pre>
  );
}

/** TM-04: a command the agent runs through ADE, live in the timeline; it can be opened and stopped. */
export function CommandItem({ item, sessionId }: { item: Command; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const status = commandStatus(item);
  const text = plainOutput(item.output);
  const lines = text.replace(/\n$/, '').split('\n');
  const preview = lines.slice(-PREVIEW_LINES).join('\n');
  const stop = () => void attempt(() => host.call('sessions.killCommand', { sessionId, terminalId: item.terminalId }));
  const outputClass = 'm-0 overflow-auto rounded-[var(--radius-small)] bg-surface-sunken p-2 font-mono text-[12px] whitespace-pre-wrap text-ink';

  return (
    <section aria-label={`Agent command ${item.command}`} className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Command</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px]" title={item.command}>
          {item.command}
        </code>
        <Badge tone={status.tone}>{status.label}</Badge>
        <Button icon={<Maximize2 className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => setOpen(true)}>
          Open
        </Button>
        {item.running ? (
          <Button icon={<CircleStop className="size-4" aria-hidden="true" />} size="dense" variant="danger" onClick={stop}>
            Stop
          </Button>
        ) : null}
      </div>
      {text ? <Output text={preview} className={`${outputClass} max-h-60`} /> : <div className="text-[12px] text-ink-muted">{item.running ? 'Waiting for output…' : 'No output.'}</div>}
      {lines.length > PREVIEW_LINES ? <div className="text-[12px] text-ink-muted">Showing the last {PREVIEW_LINES} of {lines.length} lines.</div> : null}
      <Modal
        open={open}
        onOpenChange={setOpen}
        wide
        title={item.command}
        description={`Run by the agent in ${item.cwd} · ${status.label}${item.truncated ? ' · earlier output was cut off' : ''}`}
        footer={
          <>
            {item.running ? (
              <Button icon={<CircleStop className="size-4" aria-hidden="true" />} variant="danger" onClick={stop}>
                Stop the command
              </Button>
            ) : null}
            <Button onClick={() => setOpen(false)}>Close</Button>
          </>
        }
      >
        <Output text={text} className={`${outputClass} max-h-[60vh] min-h-40`} />
      </Modal>
    </section>
  );
}

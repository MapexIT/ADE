import * as Popover from '@radix-ui/react-popover';
import { Bell, BellRing } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { TerminalInfo, WatchRule } from '@ade/contracts';
import { useState } from 'react';
import { pty } from '../../lib/bridge.ts';
import { attempt } from '../../lib/store.ts';

const END_OPTIONS: { id: WatchRule['end']; label: string }[] = [
  { id: 'any', label: 'Finishes' },
  { id: 'fail', label: 'Fails' },
  { id: 'none', label: 'Do not tell me when it ends' },
];

const inputClass = 'min-h-9 rounded border border-line bg-bg px-2 text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-45';

/**
 * SM-19: the Watch button and its popover. On a running command it watches that command; with nothing running it
 * arms the next one. Not offered for agent terminal interfaces; disabled on a plain terminal.
 */
export function WatchControl({ terminal, running }: { terminal: TerminalInfo & { exited?: boolean }; running: boolean }) {
  const [open, setOpen] = useState(false);
  const watching = terminal.watch !== null;
  const [end, setEnd] = useState<WatchRule['end']>('any');
  const [quietOn, setQuietOn] = useState(false);
  const [quiet, setQuiet] = useState(30);
  const [matchOn, setMatchOn] = useState(false);
  const [match, setMatch] = useState('');
  if (terminal.kind === 'agent-ui') return null;
  const id = terminal.id;

  if (!terminal.smart || terminal.exited) {
    return (
      <Button size="dense" variant="ghost" disabled data-watch-for={id} title={terminal.exited ? 'This terminal has exited.' : 'Watching needs a smart terminal.'} icon={<Bell className="size-4" aria-hidden="true" />}>
        Watch
      </Button>
    );
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      // Start from the watch that is set, if any.
      const w = terminal.watch;
      setEnd(w?.end ?? 'any');
      setQuietOn(!!w?.quietSeconds);
      setQuiet(w?.quietSeconds ?? 30);
      setMatchOn(!!w?.match);
      setMatch(w?.match ?? '');
    }
    setOpen(next);
  };
  const quietValid = !quietOn || (Number.isInteger(quiet) && quiet >= 5 && quiet <= 3600);
  const matchValid = !matchOn || (match.trim().length > 0 && match.length <= 200);
  const something = end !== 'none' || quietOn || matchOn;
  const save = async () => {
    const rule: WatchRule = { end, quietSeconds: quietOn ? quiet : null, match: matchOn ? match.trim() : null, auto: false };
    const ok = await attempt(() => pty.call('pty.watch', { id, rule }));
    if (ok) setOpen(false);
  };
  const stop = async () => {
    const ok = await attempt(() => pty.call('pty.watch', { id, rule: null }));
    if (ok) setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          size="dense"
          variant="secondary"
          data-watch-for={id}
          aria-pressed={watching}
          title={watching ? 'Watching this command (Ctrl+Shift+M)' : running ? 'Tell me when this command finishes (Ctrl+Shift+M)' : 'Tell me when the next command finishes (Ctrl+Shift+M)'}
          className={cx(watching && 'border-accent text-ink outline outline-1 outline-accent')}
          icon={watching ? <BellRing className="size-4 text-accent-soft" aria-hidden="true" /> : <Bell className="size-4" aria-hidden="true" />}
        >
          {watching ? 'Watching' : 'Watch'}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          aria-label="Watch this command"
          className="ade-pop z-50 flex w-[22rem] flex-col gap-3 rounded-[var(--radius)] border border-line bg-[var(--surface-glass)] p-3 font-sans text-[13px] shadow-[var(--shadow-pop)] backdrop-blur-xl"
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (quietValid && matchValid && something) void save();
            }}
          >
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-[13px] font-semibold text-ink">{running ? 'Tell me when this command' : 'Tell me when the next command'}</legend>
              {END_OPTIONS.map((o) => (
                <label key={o.id} className="flex min-h-8 items-center gap-2">
                  <input type="radio" name={`watch-end-${id}`} checked={end === o.id} onChange={() => setEnd(o.id)} className="size-4 accent-[var(--accent)]" />
                  {o.label}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-h-8 items-center gap-2">
                <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                Goes quiet for
              </label>
              <label htmlFor={`watch-quiet-${id}`} className="sr-only">
                Seconds without output
              </label>
              <input id={`watch-quiet-${id}`} type="number" min={5} max={3600} value={quiet} disabled={!quietOn} onChange={(e) => setQuiet(Math.floor(Number(e.target.value)))} className={cx(inputClass, 'w-20 font-mono')} />
              <span className="text-ink-muted">seconds</span>
            </div>
            {!quietValid ? <p className="m-0 text-[12px] font-semibold text-ink">Choose between 5 and 3,600 seconds.</p> : null}
            <div className="flex flex-col gap-1">
              <label className="flex min-h-8 items-center gap-2">
                <input type="checkbox" checked={matchOn} onChange={(e) => setMatchOn(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                Prints
              </label>
              <label htmlFor={`watch-match-${id}`} className="sr-only">
                Text to watch for
              </label>
              <input
                id={`watch-match-${id}`}
                value={match}
                maxLength={200}
                disabled={!matchOn}
                placeholder="for example: listening on"
                aria-describedby={`watch-match-help-${id}`}
                onChange={(e) => setMatch(e.target.value)}
                className={cx(inputClass, 'font-mono')}
              />
              <span id={`watch-match-help-${id}`} className="text-[12px] text-ink-muted">
                Plain text, not case sensitive.
              </span>
            </div>
            {!something ? <p className="m-0 text-[12px] text-ink-muted">Choose at least one thing to be told about.</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              {watching ? (
                <Button size="dense" variant="ghost" className="mr-auto" onClick={() => void stop()}>
                  Stop watching
                </Button>
              ) : null}
              <Button size="dense" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="dense" variant="primary" type="submit" disabled={!quietValid || !matchValid || !something}>
                Watch
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

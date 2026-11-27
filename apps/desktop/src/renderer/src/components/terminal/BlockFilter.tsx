import { Copy, Paperclip, X } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { CommandBlock } from '@ade/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  changedLines,
  countText,
  DISPLAY_LINE,
  errorsMatcher,
  filteredHeading,
  filterInWorker,
  MAX_CONTEXT,
  selectLines,
  shownText,
  splitLines,
  tryFilterLines,
  type FilterOutcome,
  type FilterRow,
  type WorkerLike,
} from '../../lib/block-filter.ts';
import FilterWorker from '../../lib/block-filter.worker.ts?worker';
import { filterKey, previousRun, useBlockFilters, type FilterState } from '../../lib/block-filters.ts';
import { copyText } from '../../lib/clipboard.ts';
import { attachmentText } from '../../lib/format.ts';
import { sendChecked } from '../../lib/guards.ts';
import { useStore } from '../../lib/store.ts';
import { Linkified } from './Linkified.tsx';

const toggleClass = (on: boolean) =>
  cx('min-h-8 rounded-[var(--radius-small)] border px-2 text-[12px]', on ? 'border-accent bg-accent-tint font-semibold text-ink' : 'border-line text-ink-muted hover:text-ink');

function describe(f: FilterState): string {
  if (f.preset === 'errors') return 'errors and warnings';
  if (f.preset === 'changed') return 'changed since last run';
  return `${f.query}${f.regex ? ' (regular expression)' : ''}${f.matchCase ? ' (match case)' : ''}`;
}

function RowText({ row, cwd, sessionId }: { row: FilterRow; cwd: string | null; sessionId: string | null }) {
  const cut = row.text.length > DISPLAY_LINE;
  const text = cut ? row.text.slice(0, DISPLAY_LINE) : row.text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of row.ranges) {
    const start = Math.min(a, text.length);
    const end = Math.min(b, text.length);
    if (start < at || end <= start) continue;
    if (start > at) parts.push(<Linkified key={`t${at}`} text={text.slice(at, start)} cwd={cwd} sessionId={sessionId} />);
    parts.push(
      <mark key={`m${start}`} className="rounded-[2px] bg-accent-tint font-semibold text-ink">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(<Linkified key={`t${at}`} text={text.slice(at)} cwd={cwd} sessionId={sessionId} />);
  return (
    <span className={cx('min-w-0 whitespace-pre-wrap break-words', row.hit ? 'text-ink' : 'text-ink-muted')}>
      {parts}
      {cut ? <span className="font-sans text-[12px] text-ink-muted"> … line cut</span> : null}
    </span>
  );
}

/**
 * SM-20: the filter bar and the filtered output of one finished block. Nothing is deleted: clearing the filter shows
 * the output again. Plain text and the presets run here; a regular expression runs in a worker with a time budget.
 */
export function BlockFilter({ terminalId, block, blocks, cwd, sessionId }: { terminalId: string; block: CommandBlock; blocks: CommandBlock[]; cwd: string | null; sessionId: string | null }) {
  const key = filterKey(terminalId, block.command);
  const f = useBlockFilters((s) => s.byCommand[key]);
  const update = useBlockFilters((s) => s.update);
  const clear = useBlockFilters((s) => s.clear);
  const attach = useStore((s) => s.attach);
  const toast = useStore((s) => s.toast);
  const inputRef = useRef<HTMLInputElement>(null);
  // Unique per mount: the same block can be on screen in the Terminals page and, hidden, in the sessions panel.
  const inputId = useId();
  const lines = useMemo(() => splitLines(block.output.trimEnd()), [block.output]);
  const prev = useMemo(() => previousRun(blocks, block), [blocks, block]);
  const prevLines = useMemo(() => (prev ? splitLines(prev.output.trimEnd()) : null), [prev]);
  const changedOk = !!prev && !block.truncated && !prev.truncated;
  const [asyncResult, setAsyncResult] = useState<{ for: string; outcome: FilterOutcome } | null>(null);

  const focusNonce = f?.focusNonce;
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusNonce]);

  const regexRun = !!f && f.regex && !!f.query && f.preset === null;
  const runId = f ? JSON.stringify([block.id, f.query, f.matchCase, f.invert, f.context]) : '';
  useEffect(() => {
    if (!f || !regexRun) return;
    const opts = { query: f.query, regex: true, matchCase: f.matchCase, invert: f.invert, context: f.context };
    try {
      new RegExp(opts.query);
    } catch {
      setAsyncResult({ for: runId, outcome: { error: 'invalid' } });
      return;
    }
    let live = true;
    void filterInWorker(() => new FilterWorker() as unknown as WorkerLike, { lines, opts }).then((outcome) => {
      if (live) setAsyncResult({ for: runId, outcome });
    });
    return () => {
      live = false;
    };
    // runId carries the options that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regexRun, runId, lines]);

  const outcome: FilterOutcome | null = useMemo(() => {
    if (!f) return null;
    const shape = { invert: f.invert, context: f.context };
    if (f.preset === 'errors') return selectLines(lines, errorsMatcher, shape);
    if (f.preset === 'changed' && changedOk && prevLines) {
      const changed = changedLines(lines, prevLines);
      return selectLines(lines, (_l, i) => (changed.has(i) ? [] : null), shape);
    }
    if (regexRun) return asyncResult?.for === runId ? asyncResult.outcome : null;
    return tryFilterLines(lines, { query: f.query, regex: false, matchCase: f.matchCase, invert: f.invert, context: f.context });
  }, [f, lines, prevLines, changedOk, regexRun, asyncResult, runId]);

  if (!f) return null;
  const set = (patch: Partial<FilterState>) => update(key, patch);
  const result = outcome && !outcome.error ? outcome : null;
  const active = f.preset !== null || f.query !== '';
  const heading = result ? filteredHeading(block.command, result, describe(f)) : '';
  const copyShown = () => result && void copyText(`${heading}\n${shownText(result.rows)}`);
  const sendShown = () => {
    if (!result) return;
    if (!sessionId) return toast('This terminal is not linked to a session.', 'danger');
    const text = `${heading}\n${shownText(result.rows)}`;
    sendChecked(text, () => {
      attach(sessionId, attachmentText(`Filtered output: ${block.command}`, text));
      toast('Attached to the next prompt.');
    });
  };

  const status = outcome?.error === 'invalid'
    ? 'This pattern is not a valid regular expression.'
    : outcome?.error === 'slow'
      ? 'This pattern took too long, so it was stopped. Try plain text.'
      : result
        ? active
          ? result.matched === 0
            ? `No lines match. ${countText(result)}`
            : countText(result)
          : `${result.total.toLocaleString('en-GB')} lines`
        : 'Filtering…';

  return (
    <section aria-label="Filter" className="flex flex-col gap-2 font-sans text-[13px]">
      <div className="ade-pop flex flex-col gap-2 rounded-[var(--radius-small)] border border-line bg-surface px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="text-[12px] text-ink-muted">
            Filter lines
          </label>
          <input
            id={inputId}
            ref={inputRef}
            value={f.preset ? '' : f.query}
            placeholder="Text to find"
            onChange={(e) => set({ query: e.target.value, preset: null })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                clear(key);
              }
            }}
            className="min-h-8 w-48 min-w-0 flex-1 rounded border border-line bg-bg px-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
          />
          <button type="button" aria-pressed={f.matchCase} className={toggleClass(f.matchCase)} onClick={() => set({ matchCase: !f.matchCase })}>
            Match case
          </button>
          <button type="button" aria-pressed={f.regex} className={toggleClass(f.regex)} onClick={() => set({ regex: !f.regex, preset: null })}>
            Regular expression
          </button>
          <button type="button" aria-pressed={f.invert} className={toggleClass(f.invert)} onClick={() => set({ invert: !f.invert })}>
            Hide matching lines
          </button>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            Lines of context
            <input
              type="number"
              min={0}
              max={MAX_CONTEXT}
              value={f.context}
              onChange={(e) => set({ context: Math.max(0, Math.min(MAX_CONTEXT, Number(e.target.value) || 0)) })}
              className="min-h-8 w-14 rounded border border-line bg-bg px-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={f.preset === 'errors'} className={toggleClass(f.preset === 'errors')} onClick={() => set({ preset: f.preset === 'errors' ? null : 'errors' })}>
            Errors and warnings
          </button>
          {prev ? (
            <button
              type="button"
              aria-pressed={f.preset === 'changed'}
              disabled={!changedOk}
              title={changedOk ? 'Only lines the previous run of this command did not print' : 'The output of this run or the previous one was cut, so ADE cannot tell what changed.'}
              className={cx(toggleClass(f.preset === 'changed'), 'disabled:opacity-45')}
              onClick={() => set({ preset: f.preset === 'changed' ? null : 'changed' })}
            >
              Changed since last run
            </button>
          ) : null}
          <p role="status" className="m-0 ml-auto text-[12px] text-ink-muted">
            {status}
          </p>
        </div>
        {block.truncated ? <p className="m-0 text-[12px] text-ink-muted">The start of this output was cut, so earlier lines are missing.</p> : null}
      </div>
      {!active ? (
        <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[12.5px] text-ink-muted">
          <Linkified text={block.output.trimEnd()} cwd={cwd} sessionId={sessionId} />
        </pre>
      ) : result && result.rows.length ? (
        <ol aria-label="Shown lines" className="m-0 flex max-h-72 list-none flex-col overflow-auto p-0 font-mono text-[12.5px]">
          {result.rows.map((r) => (
            <li key={r.n} className="flex flex-col">
              {r.gapBefore ? (
                <span aria-hidden="true" className="select-none pl-12 leading-4 text-ink-muted">
                  …
                </span>
              ) : null}
              <span className={cx('flex gap-3', r.hit && f.preset !== 'changed' && !f.invert && active && 'bg-accent-tint/40')}>
                <span className="w-9 shrink-0 select-none text-right text-ink-muted">{r.n}</span>
                <RowText row={r} cwd={cwd} sessionId={sessionId} />
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap gap-2 text-[13px]">
        <Button size="dense" icon={<Copy className="size-4" aria-hidden="true" />} disabled={!active || !result?.rows.length} onClick={copyShown}>
          Copy shown lines
        </Button>
        <Button size="dense" icon={<Paperclip className="size-4" aria-hidden="true" />} disabled={!active || !result?.rows.length} onClick={sendShown}>
          Send shown lines to agent
        </Button>
        <Button size="dense" variant="ghost" icon={<X className="size-4" aria-hidden="true" />} onClick={() => clear(key)}>
          Clear filter
        </Button>
      </div>
    </section>
  );
}

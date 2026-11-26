import { Paperclip, Wrench } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import type { Problem } from '@ade/contracts';
import { summaryLine, type TaggedRow } from '@ade/shell-integration/problems';
import { useState } from 'react';
import { joinPath } from '../../lib/format.ts';
import { fixNewProblems, problemKey, sendProblems, useProblems, visibleRows } from '../../lib/problems.ts';
import { useStore } from '../../lib/store.ts';

const FIRST_ROWS = 50;
const SEVERITY_ORDER: Record<Problem['severity'], number> = { error: 0, failure: 1, warning: 2 };

const location = (p: Problem) => `${p.path ?? '(no file)'}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ''}` : ''}`;

/** Rows grouped by file in order of first appearance; errors before failures before warnings within a file. */
function grouped(rows: TaggedRow[]): TaggedRow[] {
  const groups = new Map<string, TaggedRow[]>();
  for (const r of rows) groups.set(r.problem.path ?? '', [...(groups.get(r.problem.path ?? '') ?? []), r]);
  return [...groups.values()].flatMap((g) => [...g].sort((a, b) => SEVERITY_ORDER[a.problem.severity] - SEVERITY_ORDER[b.problem.severity]));
}

function ProblemText({ problem }: { problem: Problem }) {
  return (
    <>
      <span className="font-mono text-[12px] text-ink">{location(problem)}</span>
      <span className={cx('text-[12px]', problem.severity === 'warning' ? 'text-ink-muted' : 'font-semibold text-danger')}>{problem.severity}</span>
      {problem.code ? <span className="font-mono text-[12px] text-ink-muted">{problem.code}</span> : null}
      <span className="min-w-0 break-words text-ink">{problem.message}</span>
    </>
  );
}

/** SM-18: the problems ADE recognised in a finished block, compared with the previous run of the same command. */
export function BlockProblems({ terminalId, blockId }: { terminalId: string; blockId: string }) {
  const key = problemKey(terminalId, blockId);
  const state = useProblems((s) => s.byBlock[key]);
  const toggleNewOnly = useProblems((s) => s.toggleNewOnly);
  const openEditor = useStore((s) => s.openEditor);
  const [all, setAll] = useState(false);
  if (!state) return null;
  const { counts, sessionId } = state;
  const compared = state.previousAt !== null;
  const rows = grouped(visibleRows(state));
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const summary = summaryLine(counts, { previousAt: state.previousAt, previousTurn: state.previousTurn, turn: state.turn, partial: state.partial });
  return (
    <section aria-label="Problems" data-state="open" className="ade-pop flex flex-col gap-2 rounded-[var(--radius-small)] border border-line bg-surface px-3 py-2 font-sans text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="m-0 text-[13px] font-semibold text-ink">Problems</h3>
        <p role="status" className="m-0 min-w-0 flex-1 text-ink-muted">
          {summary}
        </p>
        {compared && counts.new > 0 ? (
          <Button size="dense" variant={state.newOnly ? 'primary' : 'secondary'} aria-pressed={state.newOnly} onClick={() => toggleNewOnly(key)}>
            New only
          </Button>
        ) : null}
      </div>
      {shown.length ? (
        <ul aria-label="Current problems" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map((r, i) => {
            const p = r.problem;
            const badges = (
              <>
                {r.state === 'new' ? <Badge tone="attention">New</Badge> : null}
                {r.state === 'still' ? <Badge>Still there</Badge> : null}
                {r.changed ? <Badge tone="accent">In a file this session changed</Badge> : null}
                {r.inCheckout ? <Badge>Also in your checkout</Badge> : null}
              </>
            );
            const body = 'flex w-full flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[var(--radius-small)] px-2 py-1 text-left';
            return (
              <li key={`${p.fingerprint}-${i}`}>
                {p.inside && p.path ? (
                  <button
                    type="button"
                    className={cx(body, 'min-h-9 hover:bg-surface-raised')}
                    title={`Open ${p.path}${p.line ? ` at line ${p.line}` : ''}`}
                    onClick={() => openEditor(joinPath(state.root, p.path!), sessionId, p.line ?? undefined)}
                  >
                    <ProblemText problem={p} />
                    {badges}
                  </button>
                ) : (
                  <div className={body}>
                    <ProblemText problem={p} />
                    {badges}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {rows.length > shown.length ? (
        <Button size="dense" variant="ghost" className="self-start" onClick={() => setAll(true)}>
          Show all {rows.length}
        </Button>
      ) : null}
      {compared && !state.partial && state.fixed.length ? (
        <details className="text-ink-muted">
          <summary className="min-h-9 cursor-pointer py-1.5 text-ink">Fixed ({state.fixed.length})</summary>
          <ul aria-label="Fixed problems" className="m-0 flex list-none flex-col gap-0.5 p-0">
            {state.fixed.map((p, i) => (
              <li key={`${p.fingerprint}-${i}`} className="flex flex-wrap items-baseline gap-x-2 px-2 py-1">
                <ProblemText problem={p} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {sessionId && state.rows.length ? (
        <div className="flex flex-wrap gap-2">
          {compared && counts.new > 0 ? (
            <Button icon={<Wrench className="size-4" aria-hidden="true" />} size="dense" variant="primary" onClick={() => fixNewProblems(state)}>
              Fix new problems with agent
            </Button>
          ) : null}
          <Button icon={<Paperclip className="size-4" aria-hidden="true" />} size="dense" onClick={() => sendProblems(state, visibleRows(state))}>
            Send problems to agent
          </Button>
        </div>
      ) : null}
    </section>
  );
}

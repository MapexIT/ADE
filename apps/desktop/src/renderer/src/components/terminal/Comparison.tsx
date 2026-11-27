import { CircleStop, Paperclip, Play, RotateCcw, SquareTerminal, X } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { CommandBlock, TerminalInfo } from '@ade/contracts';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { closeComparison, closeFanOut, runAgain, rowState, startComparison, stopRow, useComparisons } from '../../lib/comparisons.ts';
import { compareRuns, FAN_OUT_LIMIT, fanOutRefusal, inFlight, planFanOut, problemsText, shortDuration, type CompareRowView } from '../../lib/fan-out.ts';
import { agentLabel, attachmentText } from '../../lib/format.ts';
import { sendChecked } from '../../lib/guards.ts';
import { problemKey, useProblems } from '../../lib/problems.ts';
import { currentWorkspace, useStore } from '../../lib/store.ts';
import { useTerminals } from '../../lib/terminals.ts';
import { Modal } from '../Modal.tsx';

/** The worktrees a block could run in (empty when there is nowhere else). */
export function useFanOutTargets(sessionId: string | null) {
  const sessions = useStore((s) => s.sessions);
  const workspace = useStore(currentWorkspace);
  return useMemo(() => (workspace ? planFanOut(Object.values(sessions), workspace, { sessionId }) : []), [sessions, workspace, sessionId]);
}

/** SM-21: "Run in other worktrees". One dialog for the app; a block's button or Ctrl+Shift+E opens it. */
export function FanOutDialog() {
  const dialog = useComparisons((s) => s.dialog);
  const terminal = useTerminals((t) => (dialog ? t.terminals[dialog.terminalId] : undefined));
  const block = useTerminals((t) => (dialog ? t.blocks[dialog.terminalId]?.find((b) => b.id === dialog.blockId) : undefined));
  if (!dialog || !terminal || !block) return null;
  return <FanOutForm key={`${dialog.terminalId}:${dialog.blockId}`} terminal={terminal} block={block} />;
}

function FanOutForm({ terminal, block }: { terminal: TerminalInfo & { exited: boolean }; block: CommandBlock }) {
  const targets = useFanOutTargets(terminal.sessionId);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(targets.filter((t) => t.defaultTicked).map((t) => t.key)));
  const [sequential, setSequential] = useState(true);
  const refusal = fanOutRefusal(block.command);
  const count = ticked.size;
  const toggle = (key: string, on: boolean) =>
    setTicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const run = () => {
    startComparison({ terminal, block }, targets.filter((t) => t.ranHere || ticked.has(t.key)), sequential);
    closeFanOut();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : closeFanOut())}
      title="Run in other worktrees"
      description="Runs this command in a new smart terminal in each worktree you choose. Nothing is committed, landed or sent to an agent."
      footer={
        <>
          <Button onClick={closeFanOut}>Cancel</Button>
          <Button variant="primary" icon={<Play className="size-4" aria-hidden="true" />} disabled={!!refusal || count === 0 || count > FAN_OUT_LIMIT} onClick={run}>
            {count === 1 ? 'Run in 1 worktree' : `Run in ${count} worktrees`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <pre className="m-0 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-2.5 font-mono text-[12.5px] whitespace-pre-wrap" aria-label="Command">
          {block.command}
        </pre>
        {refusal ? (
          <p role="alert" className="m-0 font-semibold text-ink">
            {refusal}
          </p>
        ) : null}
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 font-semibold">Worktrees</legend>
          {targets.map((t) => {
            const on = ticked.has(t.key);
            const detail = [t.agentId ? agentLabel(t.agentId) : null, t.branch, t.ranHere ? 'Ran here' : null].filter(Boolean).join(' · ');
            return (
              <label key={t.key} className={cx('flex min-h-11 items-start gap-2 rounded-[var(--radius)] px-2 py-1.5', t.ranHere && 'opacity-60')}>
                <input
                  type="checkbox"
                  checked={t.ranHere ? false : on}
                  disabled={t.ranHere || (!on && count >= FAN_OUT_LIMIT)}
                  onChange={(e) => toggle(t.key, e.target.checked)}
                  className="mt-1 size-5 accent-[var(--accent)]"
                />
                <span className="flex flex-col">
                  <span>{t.label}</span>
                  {detail ? <span className="text-[12px] text-ink-muted">{detail}</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>
        {count >= FAN_OUT_LIMIT ? <p className="m-0 text-[12px] text-ink-muted">Choose up to six worktrees.</p> : null}
        <label className="flex min-h-11 items-start gap-2">
          <input type="checkbox" checked={!sequential} onChange={(e) => setSequential(!e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
          <span>
            Run them at the same time
            <span className="block text-[12px] text-ink-muted">Off: one after another, so tests that use the same port do not collide.</span>
          </span>
        </label>
        <p className="m-0 text-[12px] text-ink-muted">Your checkout is used only when you tick it. Each run is your own command, typed into the shell once its prompt is ready.</p>
      </div>
    </Modal>
  );
}

/** SM-21: the comparison under the origin block. */
export function ComparisonTable({ id }: { id: string }) {
  const c = useComparisons((s) => s.byOrigin[id]);
  const terms = useTerminals(useShallow((t) => ({ terminals: t.terminals, blocks: t.blocks })));
  const byBlock = useProblems((p) => p.byBlock);
  const attach = useStore((s) => s.attach);
  const toast = useStore((s) => s.toast);
  if (!c) return null;
  const rows = c.rows.map((r) => {
    const { block, outcome } = rowState(r, terms, c.originBlockId);
    const p = r.terminalId && block ? byBlock[problemKey(r.terminalId, block.id)] : undefined;
    const view: CompareRowView = { label: r.label, ranHere: r.ranHere, outcome, problems: problemsText(p ? { total: p.counts.total, new: p.counts.new } : null, !!p && p.previousAt !== null, outcome) };
    return { row: r, view };
  });
  const { summary, text } = compareRuns(c.command, rows.map((r) => r.view));
  const busy = rows.filter((r) => inFlight(r.view.outcome.status) && r.row.terminalId);
  const inFlightLabel = rows.find((r) => !r.row.ranHere && inFlight(r.view.outcome.status))?.row.label;
  const originSession = useTerminals.getState().terminals[c.originTerminalId]?.sessionId ?? null;
  const open = (terminalId: string) => {
    useTerminals.getState().setActive(terminalId);
    useStore.getState().setTab('terminals');
  };
  const send = () => {
    if (!originSession) return toast('This terminal is not linked to a session.', 'danger');
    sendChecked(text, () => {
      attach(originSession, attachmentText(`Comparison: ${c.command}`, text));
      toast('Attached to the next prompt.');
    });
  };
  return (
    <section aria-label="Comparison" className="ade-pop flex flex-col gap-2 rounded-[var(--radius-small)] border border-line bg-surface px-3 py-2 font-sans text-[13px]">
      <table className="w-full border-collapse text-left">
        <caption className="pb-1.5 text-left font-semibold text-ink">
          Comparison: <span className="font-mono font-normal">{c.command}</span>
        </caption>
        <thead>
          <tr className="text-[12px] text-ink-muted">
            <th scope="col" className="py-1 pr-3 font-normal">Worktree</th>
            <th scope="col" className="py-1 pr-3 font-normal">Result</th>
            <th scope="col" className="py-1 pr-3 font-normal">Duration</th>
            <th scope="col" className="py-1 pr-3 font-normal">Problems</th>
            <th scope="col" className="py-1 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, view }) => {
            const failed = view.outcome.status === 'failed';
            const waitingNote = c.sequential && view.outcome.status === 'waiting' && inFlightLabel ? `Waiting for ${inFlightLabel} to finish` : view.outcome.text;
            return (
              <tr key={row.key} data-status={view.outcome.status} className={cx('border-t border-line', failed && 'font-semibold')}>
                <th scope="row" className={cx('border-l-[3px] py-1.5 pr-3 pl-2 font-normal', failed ? 'border-l-danger font-semibold' : view.outcome.status === 'passed' ? 'border-l-accent' : 'border-l-transparent')}>
                  {row.label}
                  {row.ranHere ? <span className="text-ink-muted"> (ran here)</span> : null}
                </th>
                <td className="py-1.5 pr-3">{waitingNote}</td>
                <td className="py-1.5 pr-3 font-mono text-[12px]">{shortDuration(view.outcome.durationMs)}</td>
                <td className="py-1.5 pr-3">{view.problems}</td>
                <td className="py-1.5">
                  <span className="flex flex-wrap justify-end gap-1.5">
                    {row.terminalId && inFlight(view.outcome.status) && !row.ranHere ? (
                      <Button size="dense" variant="ghost" icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => stopRow(row.terminalId!)}>
                        Stop
                      </Button>
                    ) : null}
                    {row.terminalId && !row.ranHere ? (
                      <Button size="dense" variant="ghost" icon={<SquareTerminal className="size-4" aria-hidden="true" />} onClick={() => open(row.terminalId!)}>
                        Open terminal
                      </Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p role="status" className="m-0 text-ink-muted">
        {summary}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="dense" title="Runs the command again in each other worktree" icon={<RotateCcw className="size-4" aria-hidden="true" />} disabled={busy.some((r) => !r.row.ranHere)} onClick={() => runAgain(c.id)}>
          Run again in all
        </Button>
        {busy.some((r) => !r.row.ranHere) ? (
          <Button size="dense" icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => busy.forEach((r) => !r.row.ranHere && stopRow(r.row.terminalId!))}>
            Stop all
          </Button>
        ) : null}
        <Button size="dense" icon={<Paperclip className="size-4" aria-hidden="true" />} onClick={send}>
          Send comparison to agent
        </Button>
        <Button size="dense" variant="ghost" icon={<X className="size-4" aria-hidden="true" />} onClick={() => closeComparison(c.id)}>
          Close comparison
        </Button>
      </div>
    </section>
  );
}

import { ArrowDown, ArrowUp, GitMerge, MessagesSquare, RefreshCw, SendHorizontal } from 'lucide-react';
import { Badge, Button, cx, EmptyState, SectionLabel, Waiting } from '@ade/ui';
import {
  INTEGRATE_ALONE_LABEL,
  INTEGRATE_VERDICT_LABEL,
  type IntegrateCandidate,
  type IntegrateFit,
  type IntegrateLandItem,
  type IntegrateLandResult,
  type IntegrateOverview,
  type IntegrateStep,
  type IntegrateTrial,
} from '@ade/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { attempt, currentWorkspace, useStore } from '../lib/store.ts';
import { inputClass, Modal } from './Modal.tsx';

const FIT_WORD: Record<IntegrateFit, string> = { fits: 'Fits', 'same-files': 'Same files', conflicts: 'Conflicts' };
const FIT_CLASS: Record<IntegrateFit, string> = {
  fits: 'border-line text-ink-muted',
  'same-files': 'border-accent/40 bg-accent-tint text-accent-soft',
  conflicts: 'border-attention-line bg-attention-tint font-semibold text-attention',
};
const fitText = (fit: IntegrateFit, files: number) => (fit === 'conflicts' ? `Conflicts · ${files}` : FIT_WORD[fit]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Selection = { kind: 'pair'; a: string; b: string } | { kind: 'checkout'; id: string } | { kind: 'step'; index: number } | null;

const BUSY: IntegrateTrial['status'][] = ['running', 'checking'];
const LANDABLE: IntegrateTrial['status'][] = ['fits', 'passed', 'failed'];

/**
 * PL-06 Integrate: which ready sessions fit together, a trial merge in the order the user picks (in Git's object
 * database, nothing on disk changes), checks on the combined result, a briefed "adapt" prompt, and landing in order
 * behind one confirmation.
 */
export function IntegrateScreen() {
  const workspace = useStore(currentWorkspace);
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  const sessionsKey = useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.workspaceId === s.workspaceId)
      .map((x) => `${x.id}:${x.state}:${x.baseCommit ?? ''}`)
      .sort()
      .join('|'),
  );
  const [overview, setOverview] = useState<IntegrateOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [trial, setTrial] = useState<IntegrateTrial | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [runChecks, setRunChecks] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [starting, setStarting] = useState(false);
  const [resolveFor, setResolveFor] = useState<{ sessionId: string; title: string; prompt: string } | null>(null);
  const [landItems, setLandItems] = useState<IntegrateLandItem[] | null>(null);
  const [landResult, setLandResult] = useState<IntegrateLandResult | null>(null);
  const workspaceId = workspace?.id ?? null;
  const loadSeq = useRef(0);

  const loadOverview = useCallback(async () => {
    if (!workspaceId) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    const o = await attempt(() => host.call('integrate.overview', { workspaceId }));
    if (seq !== loadSeq.current) return;
    setLoading(false);
    if (o) setOverview(o);
  }, [workspaceId]);

  const loadTrial = useCallback(async () => {
    if (!workspaceId) return;
    const t = await host.call('integrate.current', { workspaceId }).catch(() => null);
    setTrial(t);
  }, [workspaceId]);

  // A new workspace starts afresh.
  useEffect(() => {
    setOverview(null);
    setTrial(null);
    setOrder([]);
    setExcluded(new Set());
    setSelection(null);
    setLandResult(null);
    void loadTrial();
  }, [workspaceId, loadTrial]);

  // Sessions that change state (a turn ends, one lands) change the matrix; reload shortly after.
  useEffect(() => {
    const t = setTimeout(() => void loadOverview(), 250);
    return () => clearTimeout(t);
  }, [loadOverview, sessionsKey]);

  useEffect(
    () =>
      host.on('integrate.changed', (e) => {
        if (e.workspaceId === workspaceId) void loadTrial();
      }),
    [workspaceId, loadTrial],
  );

  // Out-of-date is computed when the trial is read, so read it again whenever the sessions move.
  useEffect(() => {
    if (trial && !BUSY.includes(trial.status)) void loadTrial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsKey]);

  const ready = useMemo(() => overview?.candidates.filter((c) => c.ready) ?? [], [overview]);
  const working = useMemo(() => overview?.candidates.filter((c) => !c.ready) ?? [], [overview]);
  const byId = useMemo(() => new Map((overview?.candidates ?? []).map((c) => [c.sessionId, c])), [overview]);

  // Keep the user's order for sessions that are still ready; new ones join at the end in the default order.
  useEffect(() => {
    setOrder((prev) => {
      const ids = new Set(ready.map((c) => c.sessionId));
      const kept = prev.filter((id) => ids.has(id));
      return [...kept, ...ready.map((c) => c.sessionId).filter((id) => !kept.includes(id))];
    });
  }, [ready]);

  // A finished trial with a conflict opens on the conflicting step.
  const conflictIndex = trial?.steps.findIndex((s) => s.status === 'conflicts') ?? -1;
  useEffect(() => {
    if (conflictIndex >= 0) setSelection({ kind: 'step', index: conflictIndex });
  }, [trial?.id, conflictIndex]);

  if (!workspace) {
    return <EmptyState icon={<GitMerge className="size-5" />} title="Open a repository to integrate sessions" body="Integrate shows how sessions that are ready fit together." />;
  }
  if (!overview && !trial) {
    return (
      <main aria-label="Integrate" className="flex h-full items-center justify-center bg-surface">
        <Waiting className="text-[13px]">Comparing the sessions…</Waiting>
      </main>
    );
  }
  if (overview && ready.length < 2 && !trial) {
    return (
      <main aria-label="Integrate" className="h-full bg-surface">
        <EmptyState
          icon={<GitMerge className="size-5" />}
          title="Nothing to integrate yet"
          body="Integrate shows how sessions that are ready fit together. Finish two sessions to compare them."
          action={
            <Button icon={<MessagesSquare className="size-4" aria-hidden="true" />} onClick={() => set({ tab: 'sessions' })}>
              Open sessions
            </Button>
          }
        />
      </main>
    );
  }

  const included = order.filter((id) => !excluded.has(id));
  const busy = !!trial && BUSY.includes(trial.status);
  const move = (id: string, by: -1 | 1) =>
    setOrder((o) => {
      const i = o.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const startTrial = async () => {
    if (!workspaceId || !included.length) return;
    setStarting(true);
    setLandResult(null);
    const t = await attempt(() => host.call('integrate.trial', { workspaceId, order: included, runChecks: runChecks && !!overview?.checks.length }));
    setStarting(false);
    if (t) {
      setTrial(t);
      setSelection(null);
    }
  };

  const discardTrial = async () => {
    if (!trial) return;
    if (await attempt(() => host.call('integrate.cancel', { trialId: trial.id }))) {
      setTrial(null);
      setSelection(null);
      setLandResult(null);
    }
  };

  const askToAdapt = async (step: IntegrateStep) => {
    if (!trial) return;
    const res = await attempt(() => host.call('integrate.resolvePrompt', { trialId: trial.id, sessionId: step.sessionId }));
    if (res) setResolveFor({ sessionId: step.sessionId, title: step.title, prompt: res.prompt });
  };

  const openLand = async () => {
    if (!trial) return;
    const items = await attempt(() => host.call('integrate.landPreview', { trialId: trial.id }));
    if (items) setLandItems(items);
  };

  const land = async () => {
    if (!trial) return;
    const res = await attempt(() => host.call('integrate.land', { trialId: trial.id, acknowledged: true }));
    setLandItems(null);
    if (!res) return;
    setLandResult(res);
    const title = (id: string) => trial.steps.find((s) => s.sessionId === id)?.title ?? 'A session';
    if (res.failed) toast(`Landed ${res.landed.length} of ${trial.order.length}. "${title(res.failed.sessionId)}" did not land.`, 'danger');
    else toast(res.landed.length === 1 ? `Landed "${title(res.landed[0]!)}".` : `Landed ${res.landed.length} sessions in order.`);
    void loadTrial();
    void loadOverview();
  };

  const landable = !!trial && LANDABLE.includes(trial.status) && !trial.outOfDate;

  return (
    <main aria-label="Integrate" className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto bg-surface p-3 lg:grid-cols-[minmax(240px,22%)_minmax(380px,1fr)_minmax(280px,28%)] lg:overflow-hidden">
      {/* Left: the order the sessions would land in. */}
      <section aria-label="Order" className="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto">
        <div className="flex items-center gap-2">
          <GitMerge className="size-4 text-accent-soft" aria-hidden="true" />
          <h1 className="m-0 truncate text-[16px] font-semibold">Integrate · {workspace.name}</h1>
        </div>
        <p className="m-0 text-[12px] text-ink-muted">Order does not remove a conflict; it decides which session adapts to the ones before it.</p>
        <SectionLabel>Landing order</SectionLabel>
        <ol aria-label="Landing order" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {order.map((id, i) => {
            const c = byId.get(id);
            if (!c) return null;
            const on = !excluded.has(id);
            return (
              <li key={id} className={cx('flex items-center gap-2 rounded-[var(--radius)] border bg-surface-sunken px-2 py-1.5', on ? 'border-line' : 'border-line/60 opacity-60')}>
                <span className="w-5 shrink-0 text-center font-mono text-[12px] text-ink-muted" aria-hidden="true">
                  {on ? included.indexOf(id) + 1 : '–'}
                </span>
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`Include ${c.title}`}
                    onChange={(e) =>
                      setExcluded((x) => {
                        const next = new Set(x);
                        if (e.target.checked) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    className="size-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px]" title={c.title}>
                      {c.title}
                    </span>
                    <span className="text-[11px] text-ink-muted">
                      {plural(c.files.length, 'file')} · +{c.additions} −{c.deletions}
                    </span>
                  </span>
                </label>
                <Button size="dense" variant="ghost" className="w-9 px-0" aria-label={`Move ${c.title} up`} disabled={i === 0} onClick={() => move(id, -1)}>
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
                <Button size="dense" variant="ghost" className="w-9 px-0" aria-label={`Move ${c.title} down`} disabled={i === order.length - 1} onClick={() => move(id, 1)}>
                  <ArrowDown className="size-4" aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
        {working.length ? (
          <>
            <SectionLabel>Still working</SectionLabel>
            <ul aria-label="Still working" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {working.map((c) => (
                <li key={c.sessionId} className="flex items-center gap-2 rounded-[var(--radius)] border border-line/60 px-2 py-1.5 text-ink-muted opacity-70">
                  <span className="min-w-0 flex-1 truncate text-[13px]" title={c.title}>
                    {c.title}
                  </span>
                  <Badge>Still working</Badge>
                </li>
              ))}
            </ul>
            <p className="m-0 text-[12px] text-ink-muted">Compared at their last checkpoint; they join the order when they are ready.</p>
          </>
        ) : null}
        {overview?.hidden ? <p className="m-0 text-[12px] text-ink-muted">{plural(overview.hidden, 'more session')} not shown: Integrate compares at most eight at once.</p> : null}
        <label className="flex items-start gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={runChecks && !!overview?.checks.length}
            disabled={!overview?.checks.length}
            onChange={(e) => setRunChecks(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="flex flex-col">
            Run the checks on the result
            <span className="text-[12px] text-ink-muted">
              {overview?.checks.length ? overview.checks.map((c) => c.name).join(', ') : 'Choose which configurations are checks in Review first.'}
            </span>
          </span>
        </label>
        <Button variant="primary" icon={<GitMerge className="size-4" aria-hidden="true" />} busy={starting || busy} disabled={!included.length} onClick={() => void startTrial()}>
          {trial ? 'Try again in this order' : 'Try in this order'}
        </Button>
        <p className="m-0 text-[12px] text-ink-muted">The trial merges in Git's object database. No file in your checkout or in a worktree changes.</p>
      </section>

      {/* Middle: the matrix and the trial strip. */}
      <section aria-label="Fit and trial" className="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto">
        <div className="flex items-center gap-2">
          <SectionLabel>How they fit</SectionLabel>
          {loading ? <Waiting className="text-[12px]">Comparing…</Waiting> : null}
          <Button size="dense" variant="ghost" className="ml-auto" icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={() => void loadOverview()}>
            Compare again
          </Button>
        </div>
        {overview ? <FitMatrix overview={overview} selection={selection} onSelect={setSelection} /> : null}

        <SectionLabel className="mt-1">Trial</SectionLabel>
        {trial ? (
          <TrialStrip trial={trial} head={trial.head} branch={overview?.branch ?? null} selection={selection} onSelect={setSelection} />
        ) : (
          <p className="m-0 text-[12px] text-ink-muted">Try an order to merge the sessions one after another onto your checkout's commit and see where they stop.</p>
        )}
        {trial ? <TrialStatus trial={trial} result={landResult} onRetry={() => void startTrial()} /> : null}
        {trial?.checks.length ? <CheckList trial={trial} /> : null}
        {trial ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={!landable} onClick={() => void openLand()}>
              Land in order
            </Button>
            <Button variant="ghost" onClick={() => void discardTrial()}>
              {busy ? 'Cancel the trial' : 'Discard the trial'}
            </Button>
            {!landable && !busy && trial.status !== 'landed' ? (
              <span className="text-[12px] text-ink-muted">
                {trial.outOfDate ? 'Try again first: the trial is out of date.' : trial.status === 'conflicts' ? 'Land in order needs every session to fit.' : null}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Right: what the selected cell or step contains. */}
      <Inspector overview={overview} trial={trial} selection={selection} byId={byId} onAdapt={(s) => void askToAdapt(s)} />

      <ResolveDialog
        target={resolveFor}
        onClose={() => setResolveFor(null)}
        onSend={async (prompt) => {
          if (!trial || !resolveFor) return;
          const ok = await attempt(() => host.call('integrate.resolve', { trialId: trial.id, sessionId: resolveFor.sessionId, prompt }));
          if (ok) {
            toast(`Sent to "${resolveFor.title}".`);
            setResolveFor(null);
            void loadTrial();
          }
        }}
      />
      <LandDialog items={landItems} failing={trial?.status === 'failed'} onClose={() => setLandItems(null)} onLand={land} />
    </main>
  );
}

function FitMatrix({ overview, selection, onSelect }: { overview: IntegrateOverview; selection: Selection; onSelect(s: Selection): void }) {
  const cs = overview.candidates;
  const pair = (a: string, b: string) => overview.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const isSel = (s: Selection) => JSON.stringify(s) === JSON.stringify(selection);
  return (
    <div className="overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-2">
      <table className="border-separate border-spacing-1 text-[12px]">
        <caption className="sr-only">Fit matrix: how each pair of sessions merges, and each session against your checkout</caption>
        <thead>
          <tr>
            <td />
            {cs.map((c, i) => (
              <th key={c.sessionId} scope="col" className={cx('max-w-28 px-1 text-left font-semibold', !c.ready && 'text-ink-muted')}>
                <span className="block truncate" title={c.title}>
                  {i + 1}. {c.title}
                </span>
              </th>
            ))}
            <th scope="col" className="px-1 text-left font-semibold">
              Your checkout
            </th>
          </tr>
        </thead>
        <tbody>
          {cs.map((row, i) => (
            <tr key={row.sessionId}>
              <th scope="row" className={cx('max-w-36 pr-2 text-left font-semibold', !row.ready && 'text-ink-muted')}>
                <span className="block truncate" title={row.title}>
                  {i + 1}. {row.title}
                </span>
                {!row.ready ? <span className="block text-[11px] font-normal">Still working</span> : null}
              </th>
              {cs.map((col) => {
                if (col.sessionId === row.sessionId)
                  return (
                    <td key={col.sessionId} className="min-w-24 text-center text-ink-muted" aria-label="Same session">
                      –
                    </td>
                  );
                const p = pair(row.sessionId, col.sessionId);
                if (!p) return <td key={col.sessionId} />;
                const sel: Selection = { kind: 'pair', a: row.sessionId, b: col.sessionId };
                return (
                  <td key={col.sessionId} className="min-w-24">
                    <button
                      type="button"
                      aria-label={`${row.title} and ${col.title}: ${FIT_WORD[p.fit]}${p.files.length ? `, ${plural(p.files.length, 'file')}` : ''}`}
                      aria-pressed={isSel(sel)}
                      onClick={() => onSelect(sel)}
                      className={cx(
                        'min-h-9 w-full rounded-[var(--radius-small)] border px-2 text-left transition-colors duration-150 ease-out hover:border-line-strong',
                        FIT_CLASS[p.fit],
                        isSel(sel) && 'shadow-[0_0_0_2px_var(--color-accent)]',
                      )}
                    >
                      {fitText(p.fit, p.files.length)}
                    </button>
                  </td>
                );
              })}
              <td className="min-w-28">
                <button
                  type="button"
                  aria-label={`${row.title} and your checkout: ${FIT_WORD[row.checkout.fit]}`}
                  aria-pressed={isSel({ kind: 'checkout', id: row.sessionId })}
                  onClick={() => onSelect({ kind: 'checkout', id: row.sessionId })}
                  className={cx(
                    'min-h-9 w-full rounded-[var(--radius-small)] border px-2 text-left transition-colors duration-150 ease-out hover:border-line-strong',
                    FIT_CLASS[row.checkout.fit],
                    isSel({ kind: 'checkout', id: row.sessionId }) && 'shadow-[0_0_0_2px_var(--color-accent)]',
                  )}
                >
                  {fitText(row.checkout.fit, row.checkout.files.length)}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STEP_WORD: Record<IntegrateStep['status'], string> = { pending: 'Waiting', fits: 'Fits', conflicts: 'Conflicts', skipped: 'Not tried' };

function TrialStrip({ trial, head, branch, selection, onSelect }: { trial: IntegrateTrial; head: string; branch: string | null; selection: Selection; onSelect(s: Selection): void }) {
  const running = trial.status === 'running';
  return (
    <ol aria-label="Trial steps" className="m-0 flex list-none items-stretch overflow-x-auto p-0 pb-1">
      <li className="flex shrink-0 items-center">
        <div className="flex min-h-16 flex-col justify-center rounded-[var(--radius)] border border-line bg-surface-sunken px-3 py-2 text-[12px]">
          <span className="font-semibold">Your checkout</span>
          <span className="font-mono text-ink-muted">
            {branch ? `${branch} · ` : ''}
            {head.slice(0, 7)}
          </span>
        </div>
      </li>
      {trial.steps.map((s, i) => {
        const sel = selection?.kind === 'step' && selection.index === i;
        const firstPending = running && s.status === 'pending' && trial.steps.findIndex((x) => x.status === 'pending') === i;
        return (
          <li key={s.sessionId} className="flex shrink-0 items-center">
            <span aria-hidden="true" className={cx('h-px w-6', s.status === 'skipped' || s.status === 'pending' ? 'bg-line' : 'bg-accent/60')} />
            <button
              type="button"
              aria-pressed={sel}
              aria-label={`Step ${i + 1}, ${s.title}: ${STEP_WORD[s.status]}`}
              onClick={() => onSelect({ kind: 'step', index: i })}
              className={cx(
                'flex min-h-16 w-44 flex-col justify-center gap-1 rounded-[var(--radius)] border px-3 py-2 text-left text-[12px] transition-colors duration-150 ease-out hover:border-line-strong',
                s.status === 'conflicts' ? 'border-attention-line bg-attention-tint' : 'border-line bg-surface-sunken',
                s.status === 'skipped' && 'opacity-60',
                sel && 'shadow-[0_0_0_2px_var(--color-accent)]',
              )}
            >
              <span className="truncate font-semibold" title={s.title}>
                {i + 1}. {s.title}
              </span>
              {firstPending ? (
                <Waiting>Merging…</Waiting>
              ) : (
                <span className={cx(s.status === 'conflicts' ? 'font-semibold text-attention' : s.status === 'fits' ? 'text-accent-soft' : 'text-ink-muted')}>
                  {s.status === 'conflicts' ? `Conflicts · ${plural(s.conflicts.length, 'file')}` : STEP_WORD[s.status]}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function TrialStatus({ trial, result, onRetry }: { trial: IntegrateTrial; result: IntegrateLandResult | null; onRetry(): void }) {
  const title = (id: string) => trial.steps.find((s) => s.sessionId === id)?.title ?? 'A session';
  const stopped = trial.steps.find((s) => s.status === 'conflicts');
  const line: Record<IntegrateTrial['status'], string | null> = {
    running: null,
    checking: null,
    conflicts: stopped ? `Stopped at "${stopped.title}": it conflicts with the sessions before it.` : 'Stopped at a conflict.',
    fits: 'Every session fits, in this order.',
    passed: 'Every session fits, and the checks pass on the combined result.',
    failed: 'Every session fits, but checks fail on the combined result.',
    cancelled: trial.error ?? 'The trial was cancelled.',
    error: `The trial could not finish: ${trial.error ?? 'unknown error'}`,
    landed: 'Landed in order.',
  };
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {trial.status === 'running' ? <Waiting className="text-[13px]">Merging in order…</Waiting> : null}
      {trial.status === 'checking' ? <Waiting className="text-[13px]">Running the checks on the combined result…</Waiting> : null}
      {line[trial.status] ? <p className={cx('m-0 text-[13px]', trial.status === 'error' && 'font-semibold text-danger')}>{line[trial.status]}</p> : null}
      {trial.outOfDate ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-attention-line bg-attention-tint px-3 py-2 text-[13px] text-attention">
          <span className="font-semibold">Out of date.</span>
          <span className="min-w-0 flex-1">{trial.outOfDate}</span>
          <Button size="dense" variant="attention" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
      {result ? (
        <p className="m-0 text-[13px]">
          {result.landed.length ? `Landed: ${result.landed.map(title).join(', ')}.` : 'Nothing landed.'}
          {result.failed ? (
            <span className="block font-semibold text-danger">
              "{title(result.failed.sessionId)}" did not land: {result.failed.message}
            </span>
          ) : null}
          {result.notLanded.length ? <span className="block text-ink-muted">Not landed: {result.notLanded.map(title).join(', ')}.</span> : null}
        </p>
      ) : null}
    </div>
  );
}

function CheckList({ trial }: { trial: IntegrateTrial }) {
  const title = (id: string) => trial.steps.find((s) => s.sessionId === id)?.title ?? 'A session';
  return (
    <section aria-label="Combined checks" className="flex flex-col gap-2">
      <SectionLabel>Checks on the combined result</SectionLabel>
      <p className="m-0 text-[12px] text-ink-muted">
        Ran in a temporary worktree of the last trial commit, {trial.sandboxed ? 'inside the sandbox' : 'not sandboxed'}. The worktree was removed afterwards.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {trial.checks.map((c) => (
          <li key={c.configId} className={cx('rounded-[var(--radius)] border px-3 py-2', c.verdict === 'passes' ? 'border-line bg-surface-sunken' : 'border-danger-line bg-danger-tint')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12px]">{c.name}</span>
              <Badge tone={c.verdict === 'passes' ? 'ok' : 'danger'}>{INTEGRATE_VERDICT_LABEL[c.verdict]}</Badge>
              {c.verdict !== 'passes' ? <span className="text-[12px] text-ink-muted">exit {c.exitCode ?? 'unknown'}</span> : null}
            </div>
            <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-[12px] text-ink-muted">
              {c.alone.map((a) => (
                <li key={a.sessionId}>
                  {title(a.sessionId)}: {INTEGRATE_ALONE_LABEL[a.result]}
                </li>
              ))}
            </ul>
            {c.verdict !== 'passes' && c.output.trim() ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[12px] text-ink-muted">Output</summary>
                <pre className="mt-1 max-h-48 overflow-auto rounded-[var(--radius-small)] bg-surface-sunken p-2 font-mono text-[12px] whitespace-pre-wrap">{c.output.trim().slice(-6000)}</pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FileList({ files, label }: { files: string[]; label: string }) {
  if (!files.length) return null;
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-0.5 p-0">
      {files.map((f) => (
        <li key={f} className="truncate font-mono text-[12px]" title={f}>
          {f}
        </li>
      ))}
    </ul>
  );
}

function Inspector({
  overview,
  trial,
  selection,
  byId,
  onAdapt,
}: {
  overview: IntegrateOverview | null;
  trial: IntegrateTrial | null;
  selection: Selection;
  byId: Map<string, IntegrateCandidate>;
  onAdapt(step: IntegrateStep): void;
}) {
  const box = 'flex min-h-0 min-w-0 flex-col gap-2 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-3';
  if (selection?.kind === 'pair' && overview) {
    const a = byId.get(selection.a);
    const b = byId.get(selection.b);
    const p = overview.pairs.find((x) => (x.a === selection.a && x.b === selection.b) || (x.a === selection.b && x.b === selection.a));
    if (a && b && p) {
      return (
        <aside aria-label="Details" className={box}>
          <h2 className="m-0 text-[14px] font-semibold break-words">
            {a.title} and {b.title}
          </h2>
          <span className={cx('self-start rounded-[var(--radius-small)] border px-2 py-0.5 text-[12px]', FIT_CLASS[p.fit])}>{FIT_WORD[p.fit]}</span>
          <p className="m-0 text-[12px] text-ink-muted">
            {p.fit === 'conflicts'
              ? 'Git cannot merge these files on its own. Whichever lands second has to adapt.'
              : p.fit === 'same-files'
                ? 'Both change these files, in different places. Git merges them cleanly.'
                : 'They change different files.'}
          </p>
          <FileList files={p.files} label={p.fit === 'conflicts' ? 'Conflicted files' : 'Shared files'} />
        </aside>
      );
    }
  }
  if (selection?.kind === 'checkout') {
    const c = byId.get(selection.id);
    if (c) {
      return (
        <aside aria-label="Details" className={box}>
          <h2 className="m-0 text-[14px] font-semibold break-words">{c.title} and your checkout</h2>
          <span className={cx('self-start rounded-[var(--radius-small)] border px-2 py-0.5 text-[12px]', FIT_CLASS[c.checkout.fit])}>{FIT_WORD[c.checkout.fit]}</span>
          <p className="m-0 text-[12px] text-ink-muted">
            {c.checkout.behind ? `Your checkout is ${plural(c.checkout.behind, 'commit')} past this session's start.` : "The session started from your checkout's current commit."} Uncommitted changes in your checkout are not compared.
          </p>
          <FileList files={c.checkout.files} label={c.checkout.fit === 'conflicts' ? 'Conflicted files' : 'Shared files'} />
          <SectionLabel className="mt-1">Changed by the session</SectionLabel>
          <FileList files={c.files} label="Changed files" />
        </aside>
      );
    }
  }
  if (selection?.kind === 'step' && trial) {
    const s = trial.steps[selection.index];
    if (s) {
      const canAdapt = !trial.outOfDate && (s.status === 'conflicts' || (trial.status === 'failed' && s.status === 'fits'));
      return (
        <aside aria-label="Details" className={box}>
          <h2 className="m-0 text-[14px] font-semibold break-words">
            Step {selection.index + 1}: {s.title}
          </h2>
          <span className="text-[12px] text-ink-muted">{STEP_WORD[s.status]}</span>
          {s.status === 'conflicts' ? (
            <>
              <p className="m-0 text-[12px] text-ink-muted">These files conflict with the sessions before it in the order:</p>
              <FileList files={s.conflicts} label="Conflicted files" />
            </>
          ) : null}
          {s.commit ? <span className="font-mono text-[12px] text-ink-muted">Trial commit {s.commit.slice(0, 12)}</span> : null}
          {canAdapt ? (
            <>
              <p className="m-0 text-[12px] text-ink-muted">
                {s.status === 'conflicts'
                  ? 'The agent is told what the sessions before it changed, and its branch moves onto the trial commit before it, with conflict markers to resolve.'
                  : 'The agent is told which checks fail together and what the sessions before it changed, and its branch moves onto the trial commit before it.'}
              </p>
              <Button variant="attention" icon={<SendHorizontal className="size-4" aria-hidden="true" />} onClick={() => onAdapt(s)}>
                Ask the agent to adapt
              </Button>
            </>
          ) : null}
          {s.changed.length ? (
            <>
              <SectionLabel className="mt-1">Changed by the session</SectionLabel>
              <FileList files={s.changed} label="Changed files" />
            </>
          ) : null}
        </aside>
      );
    }
  }
  return (
    <aside aria-label="Details" className="hidden min-h-0 items-center justify-center lg:flex">
      <EmptyState icon={<GitMerge className="size-5" />} title="Select a cell or a step" body="Its files, and what to do about a conflict, appear here." />
    </aside>
  );
}

function ResolveDialog({ target, onClose, onSend }: { target: { title: string; prompt: string } | null; onClose(): void; onSend(prompt: string): Promise<void> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => setText(target?.prompt ?? ''), [target]);
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      wide
      title={`Ask "${target?.title ?? ''}" to adapt`}
      description="Its branch moves onto the trial commit before it (files that clash get conflict markers), then it gets this prompt. Edit it first if you like."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={sending}
            disabled={!text.trim()}
            icon={<SendHorizontal className="size-4" aria-hidden="true" />}
            onClick={async () => {
              setSending(true);
              await onSend(text);
              setSending(false);
            }}
          >
            Move and send
          </Button>
        </>
      }
    >
      <label htmlFor="integrate-prompt" className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
        Prompt
      </label>
      <textarea id="integrate-prompt" rows={14} value={text} onChange={(e) => setText(e.target.value)} className={cx(inputClass, 'w-full py-2 font-mono text-[12px]')} spellCheck={false} />
    </Modal>
  );
}

function LandDialog({ items, failing, onClose, onLand }: { items: IntegrateLandItem[] | null; failing: boolean; onClose(): void; onLand(): Promise<void> }) {
  const [landing, setLanding] = useState(false);
  return (
    <Modal
      open={!!items}
      onOpenChange={(o) => !o && onClose()}
      wide
      title={items?.length === 1 ? 'Land 1 session?' : `Land ${items?.length ?? 0} sessions in order?`}
      description="Each session's changes are applied to your checkout as uncommitted changes, in this order. ADE stops at the first one that does not apply, and each session ends once it lands."
      footer={
        <>
          <Button onClick={onClose}>Keep them</Button>
          <Button
            variant="primary"
            busy={landing}
            onClick={async () => {
              setLanding(true);
              await onLand();
              setLanding(false);
            }}
          >
            Land in order
          </Button>
        </>
      }
    >
      {failing ? <p className="m-0 mb-3 font-semibold text-danger">Checks fail on the combined result.</p> : null}
      <ol className="m-0 flex list-decimal flex-col gap-3 pl-5">
        {(items ?? []).map((it) => (
          <li key={it.sessionId}>
            <span className="font-semibold">{it.title}</span>
            <span className="block text-[12px] text-ink-muted">{plural(it.files.length, 'file')}: <span className="font-mono">{it.files.join(', ') || 'none'}</span></span>
            {it.unreviewed.length ? (
              <span className="block text-[12px] text-attention">
                Not reviewed: <span className="font-mono">{it.unreviewed.join(', ')}</span>
              </span>
            ) : (
              <span className="block text-[12px] text-ink-muted">Every file is reviewed.</span>
            )}
            {it.receiptItems.length ? (
              <span className="block text-[12px] text-attention">Open receipt items: {it.receiptItems.join(' · ')}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </Modal>
  );
}

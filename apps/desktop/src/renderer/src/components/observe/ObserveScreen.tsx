import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import {
  emptyActivity,
  isBusy,
  phaseTotals,
  rateBuckets,
  type Activity,
  type FeedKind,
} from '@ade/session-core';
import type { Session } from '@ade/contracts';
import { Activity as ActivityIcon, ArrowRight, Bot, CircleAlert, Coins, FileCode, FilePen, Files, GitCompareArrows, Hand, ListChecks, MessageSquare, Play, Plus, ReceiptText, Repeat2, Search, SquareTerminal, Timer, User, Wrench, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { agentLabel } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { AnimatedNumber, DrawnCheck, Orb, PHASE_STYLE, PhaseBar, Sparkline, useSteadyPhase } from './visuals.tsx';
import { AgentTeams, LoopingAgents, QuietAgents } from './Teams.tsx';
import { useTeams } from '../../lib/teams.ts';

const LIVE_STATES = new Set<Session['state']>(['queued', 'starting', 'working', 'waiting-on-user']);
const MAX_SESSIONS = 24;

/** Re-renders every `ms` so timers, sparklines and the phase bar keep moving between events. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const clockTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

const tokens = (a: Activity) => (a.usage ? (a.usage.inputTokens ?? 0) + (a.usage.outputTokens ?? 0) : null);

const FEED_ICONS: Record<FeedKind, LucideIcon> = {
  you: User,
  message: MessageSquare,
  tool: Wrench,
  'tool-failed': CircleAlert,
  command: SquareTerminal,
  'command-failed': CircleAlert,
  approval: Hand,
  plan: ListChecks,
  turn: Play,
  state: Bot,
  notice: CircleAlert,
  loop: Repeat2,
  receipt: ReceiptText,
};

/** WA-07: every agent session in the workspace, live, with what it is doing and what it did. */
export function ObserveScreen() {
  const now = useNow();
  const sessions = useStore((s) => s.sessions);
  const activity = useStore((s) => s.activity);
  const views = useStore((s) => s.views);
  const workspaceId = useStore((s) => s.workspaceId);
  const loadSession = useStore((s) => s.loadSession);
  const [selected, setSelected] = useState<string | null>(null);
  const teams = useTeams(1000);

  // Live sessions first, then the most recent.
  const list = useMemo(
    () =>
      Object.values(sessions)
        .sort(
          (a, b) =>
            Number(LIVE_STATES.has(b.state)) - Number(LIVE_STATES.has(a.state)) ||
            b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, MAX_SESSIONS),
    [sessions],
  );

  // Load the events of sessions not opened yet, so their activity can be shown.
  useEffect(() => {
    for (const s of list) if (!views[s.id]) void loadSession(s.id);
  }, [list, views, loadSession]);

  const current = list.find((s) => s.id === selected) ?? list[0] ?? null;
  const all = list.map((s) => activity[s.id] ?? emptyActivity());
  const running = list.filter((s, i) => LIVE_STATES.has(s.state) && isBusy(all[i]!.phase)).length;
  const waiting = list.filter((s) => s.state === 'waiting-on-user').length;
  const sum = (f: (a: Activity) => number) => all.reduce((n, a) => n + f(a), 0);
  const files = new Set(all.flatMap((a) => Object.keys(a.files))).size;

  if (!workspaceId) {
    return (
      <EmptyState
        icon={<ActivityIcon className="size-5" />}
        title="Open a repository"
        body="Observe shows every agent session in a repository as it works."
      />
    );
  }
  if (!list.length) {
    return (
      <EmptyState
        icon={<ActivityIcon className="size-5" />}
        title="No agents to observe yet"
        body="Start a session and watch it here: what the agent is doing, how busy it is, the files it touches and the result."
        action={
          <Button icon={<Plus className="size-4" aria-hidden="true" />} variant="primary" onClick={() => useStore.getState().set({ newSession: {} })}>
            New session
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4">
      <section
        aria-label="Overview"
        className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      >
        <Kpi icon={ActivityIcon} label="Working now" value={running} live={running > 0} />
        <Kpi icon={Hand} label="Waiting for you" value={waiting} attention={waiting > 0} />
        <Kpi icon={Wrench} label="Tool calls" value={sum((a) => a.counts.toolCalls)} />
        <Kpi
          icon={SquareTerminal}
          label="Commands"
          value={sum((a) => a.counts.commands)}
          sub={
            sum((a) => a.counts.commandsFailed) ? `${sum((a) => a.counts.commandsFailed)} failed` : undefined
          }
        />
        <Kpi icon={Files} label="Files touched" value={files} />
        <Kpi
          icon={Coins}
          label="Tokens"
          value={sum((a) => tokens(a) ?? 0)}
          sub={all.some((a) => a.usage) ? undefined : 'not reported'}
        />
      </section>

      <LoopingAgents />
      <QuietAgents teams={teams} />
      <section aria-label="Teams" className="flex max-h-[42%] shrink-0 flex-col gap-2 overflow-auto">
        <SectionLabel>Agent teams · who started them, and how hard they work</SectionLabel>
        <AgentTeams teams={teams} />
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,420px)_1fr]">
        <section aria-label="Agents" className="flex min-h-0 flex-col gap-2.5 overflow-auto pr-1">
          <AnimatePresence initial={false}>
            {list.map((s) => (
              <motion.div
                key={s.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              >
                <AgentCard
                  session={s}
                  activity={activity[s.id] ?? emptyActivity()}
                  now={now}
                  selected={current?.id === s.id}
                  onSelect={() => setSelected(s.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </section>
        {current ? (
          <Detail
            key={current.id}
            session={current}
            activity={activity[current.id] ?? emptyActivity()}
            now={now}
          />
        ) : null}
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  live,
  attention,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  sub?: string;
  live?: boolean;
  attention?: boolean;
}) {
  return (
    <div
      className={cx(
        'flex flex-col gap-1 rounded-[var(--radius-card)] border bg-surface p-3 transition-colors duration-[var(--motion-slow)]',
        attention ? 'border-attention-line bg-attention-tint' : live ? 'border-accent/50' : 'border-line',
      )}
    >
      <span className="flex items-center gap-2 text-[12px] text-ink-muted">
        <Icon className={cx('size-4', live || attention ? 'text-accent-soft' : '')} aria-hidden="true" />
        {label}
      </span>
      <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-ink">
        <AnimatedNumber value={value} />
      </span>
      {sub ? <span className="text-[11px] text-ink-muted">{sub}</span> : null}
    </div>
  );
}

function AgentCard({
  session,
  activity: a,
  now,
  selected,
  onSelect,
}: {
  session: Session;
  activity: Activity;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = LIVE_STATES.has(session.state);
  const phase = useSteadyPhase(live ? a.phase : a.phase === 'stopped' ? 'stopped' : 'idle');
  const busy = live && isBusy(phase);
  const since = a.turnStartedAt ?? a.startedAt ?? Date.parse(session.createdAt);
  const elapsedMs = (live ? now : (a.lastEventAt ?? now)) - since;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${session.title}, ${agentLabel(session.agentId)}, ${PHASE_STYLE[phase].label}`}
      className={cx(
        'flex w-full flex-col gap-2.5 rounded-[var(--radius-card)] border bg-surface p-3 text-left',
        busy && 'ade-live-edge',
        selected
          ? 'border-accent bg-accent-tint/60'
          : 'border-line hover:border-line-strong hover:bg-surface-raised',
      )}
    >
      <div className="flex w-full items-center gap-2.5">
        <Orb phase={phase} />
        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{session.title}</span>
        <span className="flex items-center gap-1 text-[12px] text-ink-muted tabular-nums">
          <Timer className="size-3.5" aria-hidden="true" />
          {clockTime(elapsedMs)}
        </span>
      </div>
      <div className="flex w-full items-center gap-2 text-[12px]">
        <Badge>{agentLabel(session.agentId)}</Badge>
        <span className={cx('min-w-0 flex-1 truncate', busy ? 'ade-shimmer' : 'text-ink-muted')}>
          {live
            ? (a.now ?? PHASE_STYLE[phase].label)
            : a.outcome
              ? `Finished: ${a.outcome.stopReason.replace(/_/g, ' ')}`
              : PHASE_STYLE[phase].label}
        </span>
      </div>
      <div className="flex w-full items-end justify-between gap-3">
        <Sparkline values={rateBuckets(a.times, now)} width={150} height={30} />
        <div className="flex gap-3 text-[12px] text-ink-muted tabular-nums">
          <Stat icon={Wrench} value={a.counts.toolCalls} label="tool calls" />
          <Stat icon={FilePen} value={a.counts.edits} label="edits" />
          <Stat icon={SquareTerminal} value={a.counts.commands} label="commands" />
        </div>
      </div>
      {a.plan.total ? (
        <div className="flex w-full items-center gap-2 text-[11px] text-ink-muted">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={false}
              animate={{ width: `${(a.plan.done / a.plan.total) * 100}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          Plan {a.plan.done}/{a.plan.total}
        </div>
      ) : null}
    </button>
  );
}

function Stat({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1" title={`${value} ${label}`}>
      <Icon className="size-3.5" aria-hidden="true" />
      <AnimatedNumber value={value} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Detail({ session, activity: a, now }: { session: Session; activity: Activity; now: number }) {
  const set = useStore((s) => s.set);
  const live = LIVE_STATES.has(session.state);
  const phase = useSteadyPhase(live ? a.phase : a.phase === 'stopped' ? 'stopped' : 'idle');
  const end = live ? now : (a.lastEventAt ?? now);
  const totals = phaseTotals(a.segments, end);
  const totalMs = Object.values(totals).reduce((x, y) => x + (y ?? 0), 0);
  const files = Object.entries(a.files)
    .sort((x, y) => y[1].edits * 3 + y[1].reads - (x[1].edits * 3 + x[1].reads))
    .slice(0, 8);
  const maxTouches = Math.max(1, ...files.map(([, f]) => f.edits + f.reads));
  const open = (tab: 'sessions' | 'review') => {
    useStore.getState().selectSession(session.id);
    set({ tab });
  };
  const showResult = !!a.outcome && !isBusy(a.phase) && a.phase !== 'waiting';

  return (
    <section
      aria-label="Agent detail"
      className="flex min-h-0 flex-col gap-4 overflow-auto rounded-[var(--radius-card)] border border-line bg-surface p-4"
    >
      <header className="flex flex-wrap items-center gap-3">
        <Orb phase={phase} size={18} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 truncate text-[16px] font-semibold tracking-[-0.01em]">{session.title}</h2>
          <span className="text-[12px] text-ink-muted">
            {agentLabel(session.agentId)} · {a.turns ? `turn ${a.turns}` : 'not started'} ·{' '}
            {PHASE_STYLE[phase].label}
          </span>
        </div>
        <Button
          size="dense"
          onClick={() => open('review')}
          icon={<GitCompareArrows className="size-4" aria-hidden="true" />}
        >
          Review
        </Button>
        <Button
          size="dense"
          variant="primary"
          onClick={() => open('sessions')}
          icon={<ArrowRight className="size-4" aria-hidden="true" />}
        >
          Open session
        </Button>
      </header>

      <AnimatePresence mode="wait">
        {showResult ? (
          <motion.div
            key="result"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col gap-3 rounded-[var(--radius)] border border-accent/50 bg-accent-tint/50 p-4"
            aria-label="Result"
          >
            <div className="flex items-center gap-3">
              <DrawnCheck />
              <div className="flex flex-col">
                <span className="font-semibold text-ink">
                  Turn finished: {a.outcome!.stopReason.replace(/_/g, ' ')}
                </span>
                <span className="text-[12px] text-ink-muted">
                  {a.outcome!.durationMs !== null ? `in ${clockTime(a.outcome!.durationMs)}` : null} ·{' '}
                  {a.counts.toolCalls} tool calls · {Object.values(a.files).filter((f) => f.edits).length}{' '}
                  files changed · {a.counts.commands} commands
                  {a.counts.commandsFailed ? ` (${a.counts.commandsFailed} failed)` : ''}
                  {a.usage ? ` · ${(tokens(a) ?? 0).toLocaleString('en-GB')} tokens` : ''}
                  {a.usage?.costUsd != null ? ` · $${a.usage.costUsd.toFixed(2)}` : ''}
                </span>
              </div>
            </div>
            {a.lastMessage ? (
              <p className="m-0 line-clamp-4 whitespace-pre-wrap text-ink">{a.lastMessage}</p>
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="now"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-1 rounded-[var(--radius)] border border-line bg-surface-sunken p-4"
            aria-label="Now"
          >
            <SectionLabel>Now</SectionLabel>
            <span
              className={cx(
                'text-[15px] font-semibold',
                live && isBusy(a.phase) ? 'ade-shimmer' : 'text-ink',
              )}
            >
              {a.now ?? PHASE_STYLE[phase].label}
            </span>
            {a.phaseSince && live ? (
              <span className="text-[12px] text-ink-muted tabular-nums">
                for {clockTime(now - a.phaseSince)}
              </span>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Timeline</SectionLabel>
          <span className="text-[12px] text-ink-muted tabular-nums">{clockTime(totalMs)}</span>
        </div>
        <PhaseBar segments={a.segments} now={end} />
        <ul
          className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-ink-muted"
          aria-label="Time per phase"
        >
          {Object.entries(totals)
            .filter(([, ms]) => (ms ?? 0) >= 500)
            .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))
            .map(([p, ms]) => {
              const style = PHASE_STYLE[p as keyof typeof PHASE_STYLE];
              return (
                <li key={p} className="flex items-center gap-1.5">
                  <span
                    className={cx('inline-block size-2.5 rounded-[2px]', style.striped && 'ade-stripes')}
                    style={{ backgroundColor: style.color }}
                    aria-hidden="true"
                  />
                  {style.label} <span className="tabular-nums text-ink">{clockTime(ms ?? 0)}</span>
                </li>
              );
            })}
        </ul>
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <SectionLabel>Activity</SectionLabel>
            <span className="flex items-center gap-2 text-[12px] text-ink-muted">
              <Sparkline values={rateBuckets(a.times, now, 30)} width={120} height={20} />
              events, last 2 min
            </span>
          </div>
          <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Activity feed">
            <AnimatePresence initial={false}>
              {a.feed
                .slice(-30)
                .reverse()
                .map((f) => {
                  const Icon = FEED_ICONS[f.kind];
                  const bad = f.kind === 'tool-failed' || f.kind === 'command-failed';
                  return (
                    <motion.li
                      key={f.id}
                      layout
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className={cx(
                        'flex items-start gap-2.5 rounded-[var(--radius-small)] px-2 py-1.5',
                        bad ? 'bg-danger-tint font-semibold text-danger' : 'hover:bg-surface-raised',
                      )}
                    >
                      <Icon
                        className={cx(
                          'mt-0.5 size-4 shrink-0',
                          bad ? '' : f.kind === 'approval' ? 'text-attention' : 'text-accent-soft',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 break-words">{f.text}</span>
                      <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
                        {new Date(f.at).toLocaleTimeString('en-GB')}
                      </span>
                    </motion.li>
                  );
                })}
            </AnimatePresence>
          </ol>
          {!a.feed.length ? (
            <p className="m-0 text-ink-muted">Nothing yet. Steps appear here as the agent works.</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Mini icon={Wrench} label="Tool calls" value={a.counts.toolCalls} />
            <Mini icon={FileCode} label="Reads" value={a.counts.reads} />
            <Mini icon={FilePen} label="Edits" value={a.counts.edits} />
            <Mini icon={Search} label="Searches" value={a.counts.searches} />
            <Mini icon={SquareTerminal} label="Commands" value={a.counts.commands} />
            <Mini icon={Hand} label="Approvals" value={a.counts.approvals} />
          </div>
          <div className="flex flex-col gap-2">
            <SectionLabel>Files touched</SectionLabel>
            {files.length ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {files.map(([path, f]) => (
                  <li key={path} className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate font-mono" title={path}>
                        {path.split(/[\\/]/).pop()}
                      </span>
                      <span className="shrink-0 text-ink-muted tabular-nums">
                        {f.edits ? `${f.edits} edit${f.edits > 1 ? 's' : ''}` : ''}
                        {f.edits && f.reads ? ' · ' : ''}
                        {f.reads ? `${f.reads} read${f.reads > 1 ? 's' : ''}` : ''}
                      </span>
                    </span>
                    <div
                      className="flex h-1 overflow-hidden rounded-full bg-surface-sunken"
                      aria-hidden="true"
                    >
                      <motion.div
                        className="h-full bg-accent"
                        initial={{ width: 0 }}
                        animate={{ width: `${(f.edits / maxTouches) * 100}%` }}
                        transition={{ duration: 0.4 }}
                      />
                      <motion.div
                        className="h-full bg-accent-soft/50"
                        initial={{ width: 0 }}
                        animate={{ width: `${(f.reads / maxTouches) * 100}%` }}
                        transition={{ duration: 0.4 }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[12px] text-ink-muted">None yet.</span>
            )}
          </div>
          <div className="flex flex-col gap-1 text-[12px] text-ink-muted">
            <SectionLabel>Usage</SectionLabel>
            {a.usage ? (
              <span>
                {(a.usage.inputTokens ?? 0).toLocaleString('en-GB')} in ·{' '}
                {(a.usage.outputTokens ?? 0).toLocaleString('en-GB')} out
                {a.usage.costUsd != null ? ` · $${a.usage.costUsd.toFixed(2)}` : ''}
              </span>
            ) : (
              <span>Not reported by this agent.</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Mini({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius)] border border-line bg-surface-raised/40 p-2.5">
      <Icon className="size-4 text-accent-soft" aria-hidden="true" />
      <span className="flex flex-col">
        <span className="text-[15px] leading-5 font-semibold text-ink">
          <AnimatedNumber value={value} />
        </span>
        <span className="text-[11px] text-ink-muted">{label}</span>
      </span>
    </div>
  );
}

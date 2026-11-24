import { BrainCircuit, CircleStop, Columns2, Hourglass, MessagesSquare, Repeat2, User, Workflow, type LucideIcon } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import { loopTitle, motionFor, type Team, type TeamAgent, type TeamKind } from '@ade/session-core';
import type { CSSProperties } from 'react';
import { host } from '../../lib/bridge.ts';
import { agentLabel } from '../../lib/format.ts';
import { attempt, useStore } from '../../lib/store.ts';
import { useTeams } from '../../lib/teams.ts';

export const TEAM_ICONS: Record<TeamKind, LucideIcon> = { you: User, compare: Columns2, workflow: Workflow, reasoning: BrainCircuit };

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
const vars = (o: Record<string, string | number>) => o as CSSProperties;

/**
 * WA-08: one team as a constellation. The spawner sits in the middle; its agents orbit it. Everything moves in
 * proportion to how busy the agents are: the orbit speed follows the team, each agent's pulse and glow follow that
 * agent, and dashes flow along the link from the spawner while an agent is working. Waiting agents hold still.
 */
export function TeamConstellation({ team, size = 168 }: { team: Team; size?: number }) {
  const Icon = TEAM_ICONS[team.kind];
  const c = size / 2;
  const r = size / 2 - 18;
  const teamMotion = motionFor(team.intensity);
  const n = Math.max(1, team.agents.length);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${team.label}: ${team.agents.length} agent${team.agents.length === 1 ? '' : 's'}, ${Math.round(team.intensity * 100)}% busy`} className="shrink-0 overflow-visible">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeDasharray="2 6" />
      <g className="ade-orbit" style={vars({ '--orbit': `${teamMotion.orbit}s` })}>
        {team.agents.map((a, i) => {
          const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
          const x = c + r * Math.cos(angle);
          const y = c + r * Math.sin(angle);
          const m = motionFor(a.intensity);
          const still = a.intensity === 0;
          const dot = a.kind === 'reasoner' ? 5 : 8;
          return (
            <g key={a.id}>
              <line x1={c} y1={c} x2={x} y2={y} stroke={still ? 'var(--line)' : 'var(--accent-soft)'} strokeWidth={1.25} className={still ? undefined : 'ade-flow'} style={vars({ '--flow': `${m.flow}s` })} opacity={still ? 0.6 : 0.4 + m.glow * 0.6} />
              <circle cx={x} cy={y} r={dot + 6 * m.glow} fill="var(--accent)" opacity={still ? 0 : 0.18 * m.glow} className={still ? undefined : 'ade-pulse'} style={vars({ '--pulse': `${m.pulse}s`, '--glow': m.glow })} />
              <circle cx={x} cy={y} r={dot} fill={a.quietMs ? 'var(--bg)' : still ? 'var(--surface-raised)' : 'var(--accent)'} stroke={a.quietMs ? 'var(--ink)' : still ? 'var(--line-strong)' : 'var(--accent-soft)'} strokeWidth={a.quietMs ? 2 : 1.5} strokeDasharray={a.quietMs ? '2 2' : undefined}>
                <title>{`${a.label} · ${a.quietMs ? `quiet for ${minutes(a.quietMs)}` : still ? 'waiting' : `${Math.round(a.intensity * 100)}% busy`}`}</title>
              </circle>
            </g>
          );
        })}
      </g>
      <circle cx={c} cy={c} r={17} fill="var(--surface-raised)" stroke={team.intensity ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth={1.5} />
      <foreignObject x={c - 9} y={c - 9} width={18} height={18}>
        <Icon className={cx('size-[18px]', team.intensity ? 'text-accent-soft' : 'text-ink-muted')} aria-hidden="true" />
      </foreignObject>
    </svg>
  );
}

function AgentLine({ a }: { a: TeamAgent }) {
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  return (
    <li className="flex min-h-7 items-center gap-2 text-[12px]">
      <span className="relative inline-flex h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        <span className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.round(a.intensity * 100)}%` }} />
      </span>
      <button type="button" onClick={() => (selectSession(a.sessionId), set({ tab: 'sessions' }))} className="min-w-0 flex-1 truncate text-left hover:underline" title={a.label}>
        {a.label}
      </button>
      <span className="shrink-0 text-ink-muted">{a.kind === 'reasoner' ? 'read-only' : agentLabel(a.agentId as never)}</span>
      {a.quietMs ? (
        <Badge tone="attention" title="WA-09: no events for a while; the agent may be stuck">
          <Hourglass className="size-3" aria-hidden="true" /> quiet {minutes(a.quietMs)}
        </Badge>
      ) : null}
    </li>
  );
}

/** WA-08: every live team, each with its constellation and its agents. */
export function AgentTeams({ teams }: { teams: Team[] }) {
  if (!teams.length) {
    return <p className="m-0 text-[12px] text-ink-muted">No agents are working right now. Teams appear here as soon as a session, a comparison, a workflow or a reasoning run starts agents.</p>;
  }
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 2xl:grid-cols-3" aria-label="Agent teams">
      {teams.map((t) => {
        const Icon = TEAM_ICONS[t.kind];
        return (
          <li key={t.id} aria-label={`Team: ${t.label}`} className="flex items-center gap-3 rounded-[var(--radius)] border border-line bg-surface p-3">
            <TeamConstellation team={t} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1.5 font-semibold">
                <Icon className="size-4 text-accent-soft" aria-hidden="true" />
                <span className="truncate">{t.label}</span>
              </span>
              <span className="truncate text-[12px] text-ink-muted">Started by {t.spawner}</span>
              <span className="text-[12px] text-ink-muted">
                {t.kind === 'reasoning' && !t.agents.length
                  ? 'Preparing, or between steps'
                  : `${t.agents.length} agent${t.agents.length === 1 ? '' : 's'} · ${Math.round(t.intensity * 100)}% busy`}
              </span>
              <ul className="m-0 mt-1 flex list-none flex-col p-0">
                {t.agents.map((a) => (
                  <AgentLine key={a.id} a={a} />
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** WA-09: agents that should be working but have been silent; each can be opened or its turn cancelled. */
/** WA-10: sessions whose running turn has a loop warning, with Open and Cancel turn. */
export function LoopingAgents() {
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  const sessions = useStore((s) => s.sessions);
  const activity = useStore((s) => s.activity);
  const workspaceId = useStore((s) => s.workspaceId);
  const looping = Object.values(sessions).flatMap((x) => {
    const loop = x.workspaceId === workspaceId ? activity[x.id]?.loop : null;
    return loop ? [{ id: x.id, title: x.title, loop }] : [];
  });
  if (!looping.length) return null;
  return (
    <section aria-label="Agents that may be looping" className="flex flex-col gap-2 rounded-[var(--radius)] border border-attention-line bg-surface p-3">
      <span className="flex items-center gap-2 font-semibold text-attention">
        <Repeat2 className="size-4" aria-hidden="true" />
        {looping.length === 1 ? 'An agent may be going round in circles' : `${looping.length} agents may be going round in circles`}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {looping.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="min-w-0 truncate font-semibold">{a.title}</span>
            <span className="min-w-0 flex-1 truncate text-ink-muted">{loopTitle(a.loop)}</span>
            <Button size="dense" icon={<MessagesSquare className="size-4" aria-hidden="true" />} onClick={() => (selectSession(a.id), set({ tab: 'sessions' }))}>
              Open
            </Button>
            <Button size="dense" variant="ghost" icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId: a.id }))}>
              Cancel turn
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function QuietAgents({ teams }: { teams: Team[] }) {
  const selectSession = useStore((s) => s.selectSession);
  const set = useStore((s) => s.set);
  const quiet = teams.flatMap((t) => t.agents.filter((a) => a.quietMs && a.kind === 'session'));
  if (!quiet.length) return null;
  return (
    <section aria-label="Quiet agents" className="flex flex-col gap-2 rounded-[var(--radius)] border border-attention-line bg-surface p-3">
      <span className="flex items-center gap-2 font-semibold text-attention">
        <Hourglass className="size-4" aria-hidden="true" />
        {quiet.length === 1 ? 'An agent has gone quiet' : `${quiet.length} agents have gone quiet`}
      </span>
      <p className="m-0 text-[12px] text-ink-muted">These should be working but have sent nothing for a while. A long build can be quiet; a hung agent looks the same.</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {quiet.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate font-semibold">{a.label}</span>
            <span className="text-ink-muted">silent for {minutes(a.quietMs!)}</span>
            <Button size="dense" icon={<MessagesSquare className="size-4" aria-hidden="true" />} onClick={() => (selectSession(a.sessionId), set({ tab: 'sessions' }))}>
              Open
            </Button>
            <Button size="dense" variant="ghost" icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => void attempt(() => host.call('sessions.cancel', { sessionId: a.sessionId }))}>
              Cancel turn
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * WA-08: the top bar's pulse: one dot per working agent, grouped by team, each pulsing with its own activity. A
 * hollow dot is a quiet agent. Opens Observe.
 */
export function AgentPulse() {
  // Ticks here, not in the top bar, so only this small button re-renders every second.
  const teams = useTeams(1000);
  const setTab = useStore((s) => s.setTab);
  const agents = teams.flatMap((t) => t.agents);
  if (!agents.length) return null;
  const working = agents.filter((a) => a.intensity > 0).length;
  const quiet = agents.filter((a) => a.quietMs).length;
  const summary = `${working} agent${working === 1 ? '' : 's'} working in ${teams.length} team${teams.length === 1 ? '' : 's'}${quiet ? `, ${quiet} quiet` : ''}`;
  let x = 6;
  const dots: { a: TeamAgent; x: number }[] = [];
  for (const t of teams) {
    for (const a of t.agents.slice(0, 6)) {
      dots.push({ a, x });
      x += 9;
    }
    x += 6;
  }
  const width = Math.min(150, x);
  return (
    <button type="button" onClick={() => setTab('observe')} aria-label={summary} title={`${summary}. Open Observe.`} className="hidden min-h-9 items-center gap-1.5 rounded-[var(--radius)] border border-line px-2 hover:bg-surface-raised md:flex">
      <svg width={width} height={16} aria-hidden="true" className="overflow-visible">
        {dots
          .filter((d) => d.x < width)
          .map(({ a, x: cx }) => {
            const m = motionFor(a.intensity);
            return (
              <g key={a.id}>
                {a.intensity > 0 ? <circle cx={cx} cy={8} r={5} fill="var(--accent)" opacity={0.25 * m.glow} className="ade-pulse" style={vars({ '--pulse': `${m.pulse}s`, '--glow': m.glow })} /> : null}
                <circle cx={cx} cy={8} r={a.kind === 'reasoner' ? 2 : 3} fill={a.quietMs ? 'none' : a.intensity > 0 ? 'var(--accent)' : 'var(--ink-muted)'} stroke={a.quietMs ? 'var(--ink)' : 'none'} />
              </g>
            );
          })}
      </svg>
      <span className="text-[12px] text-ink-muted">{working}</span>
    </button>
  );
}

/** WA-08: a thin wave under a session's header while it works; it runs faster the busier the agent is. */
export function ActivityWave({ level, active }: { level: number; active: boolean }) {
  const m = motionFor(level);
  return (
    <div aria-hidden="true" className="h-0.5 w-full overflow-hidden bg-transparent">
      {active ? <div className="ade-wave h-full w-full transition-opacity duration-500" style={vars({ '--wave': `${Math.max(0.6, m.flow)}s`, opacity: m.glow })} /> : null}
    </div>
  );
}

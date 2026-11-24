import type { Session, WorkflowRunView } from '@ade/contracts';
import { isBusy, type Activity, type ActivityPhase } from './observe.ts';
import type { SessionView } from './projection.ts';

/**
 * WA-08 / WA-09: who is working, in which team, and how hard. Pure: derived from session state, the activity model
 * and the reasoning steps already in the timeline, so the animation and the stall check need no extra events.
 */

/** Recent events count more: each event fades with this half-life. */
const HALF_LIFE_MS = 4000;
const WINDOW_MS = 20_000;
/** A rate (weighted events) that reads as "very busy". */
const BUSY_RATE = 6;

/** 0 (idle) to 1 (very busy), from recent event times. Smooth, so the animation eases instead of jumping. */
export function intensity(times: readonly number[], now: number): number {
  let rate = 0;
  for (let i = times.length - 1; i >= 0; i--) {
    const age = now - times[i]!;
    if (age > WINDOW_MS) break;
    if (age >= 0) rate += Math.pow(0.5, age / HALF_LIFE_MS);
  }
  return 1 - Math.exp(-rate / BUSY_RATE);
}

export type TeamKind = 'you' | 'compare' | 'workflow' | 'reasoning';

export interface TeamAgent {
  id: string;
  label: string;
  /** A session, or a read-only agent a reasoning run started. */
  kind: 'session' | 'reasoner';
  sessionId: string;
  agentId: string;
  phase: ActivityPhase;
  intensity: number;
  /** Set when the agent should be working but has been silent for a while (WA-09). */
  quietMs: number | null;
}

export interface Team {
  id: string;
  kind: TeamKind;
  label: string;
  /** Who started the agents: "You", a workflow, the session that is reasoning. */
  spawner: string;
  agents: TeamAgent[];
  /** The mean of the agents' intensities. */
  intensity: number;
}

const LIVE = new Set<Session['state']>(['starting', 'working', 'waiting-on-user']);

/** How long an agent may stay silent in a phase before it counts as quiet. Commands and setup may run long. */
export const QUIET_AFTER_MS: Partial<Record<ActivityPhase, number>> = {
  starting: 5 * 60_000,
  command: 10 * 60_000,
  working: 3 * 60_000,
  thinking: 3 * 60_000,
  writing: 3 * 60_000,
  tool: 5 * 60_000,
};

/**
 * WA-09: how long a session that should be busy has sent nothing, once that passes its phase's threshold; else
 * null. Waiting for the user, idle and stopped sessions are never quiet.
 */
export function quietFor(session: Pick<Session, 'state'>, activity: Activity, now: number): number | null {
  if (session.state !== 'working' && session.state !== 'starting') return null;
  if (!isBusy(activity.phase)) return null;
  const since = activity.lastEventAt ?? activity.startedAt;
  if (since === null) return null;
  const silent = now - since;
  return silent >= (QUIET_AFTER_MS[activity.phase] ?? 3 * 60_000) ? silent : null;
}

export interface TeamInput {
  sessions: Session[];
  activity: Record<string, Activity | undefined>;
  views: Record<string, SessionView | undefined>;
  runs: WorkflowRunView[];
  now: number;
  /** Labels for the reasoning methods, e.g. { foa: 'Fleet of Agents' }. */
  methodLabel(method: string): string;
}

/** The live teams: sessions grouped by who started them, plus one team per reasoning run in progress. */
export function buildTeams({ sessions, activity, views, runs, now, methodLabel }: TeamInput): Team[] {
  const runOf = new Map<string, WorkflowRunView>();
  for (const r of runs) for (const n of r.nodes) if (n.sessionId) runOf.set(n.sessionId, r);
  const teams = new Map<string, Team>();
  const add = (id: string, make: () => Omit<Team, 'agents' | 'intensity'>, agent: TeamAgent) => {
    const team = teams.get(id) ?? { ...make(), agents: [], intensity: 0 };
    team.agents.push(agent);
    teams.set(id, team);
  };

  for (const s of sessions) {
    const a = activity[s.id];
    const view = views[s.id];
    if (LIVE.has(s.state) && a) {
      const busy = s.state !== 'waiting-on-user' && isBusy(a.phase);
      const agent: TeamAgent = {
        id: s.id,
        label: s.title,
        kind: 'session',
        sessionId: s.id,
        agentId: s.agentId,
        phase: s.state === 'waiting-on-user' ? 'waiting' : a.phase,
        // A busy agent never drops to nothing: it still moves gently between bursts.
        intensity: busy ? Math.max(0.12, intensity(a.times, now)) : 0,
        quietMs: quietFor(s, a, now),
      };
      const run = runOf.get(s.id);
      if (run) add(`workflow:${run.id}`, () => ({ id: `workflow:${run.id}`, kind: 'workflow', label: run.workflowName, spawner: `Workflow ${run.workflowName}` }), agent);
      else if (s.compareGroup) add(`compare:${s.compareGroup}`, () => ({ id: `compare:${s.compareGroup}`, kind: 'compare', label: 'Compare agents', spawner: 'You, comparing agents' }), agent);
      else add('you', () => ({ id: 'you', kind: 'you', label: 'Your sessions', spawner: 'You' }), agent);
    }
    // Reasoning: the read-only agents a session's reasoning run is waiting on right now.
    if (view?.reasoningRunId) {
      const item = view.items.find((i) => i.kind === 'reasoning' && i.runId === view.reasoningRunId);
      if (item?.kind === 'reasoning' && item.outcome === null) {
        const running = item.steps.filter((st) => st.status === 'running');
        const id = `reasoning:${item.runId}`;
        for (const st of running) {
          add(
            id,
            () => ({ id, kind: 'reasoning', label: methodLabel(item.method), spawner: s.title }),
            { id: `${item.runId}:${st.stepId}`, label: st.label, kind: 'reasoner', sessionId: s.id, agentId: s.agentId, phase: 'thinking', intensity: 0.6, quietMs: null },
          );
        }
        // A run between steps still shows as a team, with no agents out.
        if (!running.length && !teams.has(id)) teams.set(id, { id, kind: 'reasoning', label: methodLabel(item.method), spawner: s.title, agents: [], intensity: 0 });
      }
    }
  }
  const order: Record<TeamKind, number> = { you: 0, compare: 1, workflow: 2, reasoning: 3 };
  return [...teams.values()]
    .map((t) => ({ ...t, intensity: t.agents.length ? t.agents.reduce((n, x) => n + x.intensity, 0) / t.agents.length : 0 }))
    .sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
}

/** Animation timings for an intensity: faster and brighter the busier. Seconds, for CSS. */
export function motionFor(level: number) {
  const l = Math.min(1, Math.max(0, level));
  return {
    /** One orbit of a team's agents. */
    orbit: 40 - 32 * l,
    /** One pulse of an agent's glow. */
    pulse: 2.6 - 1.9 * l,
    /** Dashes flowing from the spawner to the agent. */
    flow: 3.2 - 2.6 * l,
    /** Glow strength, 0..1. */
    glow: 0.25 + 0.75 * l,
  };
}

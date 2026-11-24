import { describe, expect, it } from 'vitest';
import type { Session, WorkflowRunView } from '@ade/contracts';
import { buildTeams, emptyActivity, emptyView, intensity, motionFor, quietFor, type Activity, type SessionView } from '../src/index.ts';

const NOW = 1_800_000_000_000;
const session = (id: string): Session => ({ id, title: `Session ${id}`, state: 'working', agentId: 'fake', compareGroup: null, workspaceId: 'w' }) as Session;
const busy = (eventsAgo: number[], phase: Activity['phase'] = 'tool'): Activity => ({ ...emptyActivity(), phase, startedAt: NOW - 60_000, lastEventAt: NOW - Math.min(...eventsAgo), times: eventsAgo.map((a) => NOW - a).sort((x, y) => x - y) });

describe('WA-08 intensity', () => {
  it('rises with recent events, fades with age, and stays between 0 and 1', () => {
    expect(intensity([], NOW)).toBe(0);
    const burst = intensity(Array.from({ length: 20 }, (_, i) => NOW - i * 100), NOW);
    const trickle = intensity([NOW - 1000], NOW);
    const old = intensity([NOW - 15_000], NOW);
    expect(burst).toBeGreaterThan(0.8);
    expect(burst).toBeLessThan(1);
    expect(trickle).toBeGreaterThan(old);
    expect(intensity([NOW - 60_000], NOW)).toBe(0);
  });

  it('maps intensity to faster, brighter motion', () => {
    const calm = motionFor(0);
    const hot = motionFor(1);
    expect(hot.orbit).toBeLessThan(calm.orbit);
    expect(hot.pulse).toBeLessThan(calm.pulse);
    expect(hot.flow).toBeLessThan(calm.flow);
    expect(hot.glow).toBeGreaterThan(calm.glow);
    expect(motionFor(5)).toEqual(hot);
  });
});

describe('WA-09 quiet agents', () => {
  it('flags a working agent silent past its phase threshold, never a waiting one', () => {
    expect(quietFor({ state: 'working' }, busy([4 * 60_000], 'working'), NOW)).toBe(4 * 60_000);
    expect(quietFor({ state: 'working' }, busy([60_000], 'working'), NOW)).toBeNull();
    // A command may run long before it counts as quiet.
    expect(quietFor({ state: 'working' }, busy([4 * 60_000], 'command'), NOW)).toBeNull();
    expect(quietFor({ state: 'working' }, busy([11 * 60_000], 'command'), NOW)).toBe(11 * 60_000);
    expect(quietFor({ state: 'waiting-on-user' }, busy([60 * 60_000], 'working'), NOW)).toBeNull();
    expect(quietFor({ state: 'working' }, { ...busy([60 * 60_000]), phase: 'idle' }, NOW)).toBeNull();
  });
});

describe('WA-08 teams', () => {
  const run: WorkflowRunView = { id: 'r1', workspaceId: 'w', workflowId: 'wf', workflowName: 'Fix and test', status: 'running', current: 'n1', pauseReason: null, nodes: [{ id: 'n1', type: 'agent', title: 'Fix', detail: '', status: 'running', attempts: 1, sessionId: 'c', startedAt: NOW, endedAt: null, summary: '' }] } as WorkflowRunView;

  it('groups sessions by who started them and adds the reasoning agents a session is waiting on', () => {
    const reasoningView: SessionView = {
      ...emptyView(),
      reasoningRunId: 'rr',
      items: [{ kind: 'reasoning', key: 'reasoning:rr', runId: 'rr', method: 'foa', plannedCalls: 12, outcome: null, approach: null, calls: 3, steps: [
        { stepId: 's1', phase: 'generate', label: 'Agent 1', parents: [], status: 'running', score: null, detail: null },
        { stepId: 's2', phase: 'generate', label: 'Agent 2', parents: [], status: 'running', score: null, detail: null },
        { stepId: 's3', phase: 'generate', label: 'Agent 3', parents: [], status: 'done', score: null, detail: null },
      ] }],
    };
    const teams = buildTeams({
      sessions: [session('a'), { ...session('b'), compareGroup: 'g1' }, { ...session('b2'), compareGroup: 'g1', state: 'waiting-on-user' }, session('c'), { ...session('d'), state: 'ready' }],
      activity: { a: busy([100, 200, 300]), b: busy([5000]), b2: busy([100]), c: busy([100]), d: busy([100]) },
      views: { d: reasoningView },
      runs: [run],
      now: NOW,
      methodLabel: (m) => (m === 'foa' ? 'Fleet of Agents' : m),
    });
    expect(teams.map((t) => [t.kind, t.label, t.spawner, t.agents.map((a) => a.label)])).toEqual([
      ['you', 'Your sessions', 'You', ['Session a']],
      ['compare', 'Compare agents', 'You, comparing agents', ['Session b', 'Session b2']],
      ['workflow', 'Fix and test', 'Workflow Fix and test', ['Session c']],
      ['reasoning', 'Fleet of Agents', 'Session d', ['Agent 1', 'Agent 2']],
    ]);
    const compare = teams[1]!;
    // The waiting agent holds still; the working one keeps a minimum motion.
    expect(compare.agents[1]).toMatchObject({ phase: 'waiting', intensity: 0 });
    expect(compare.agents[0]!.intensity).toBeGreaterThanOrEqual(0.12);
    expect(teams[0]!.agents[0]!.intensity).toBeGreaterThan(compare.agents[0]!.intensity);
    expect(teams[3]!.agents.every((a) => a.kind === 'reasoner')).toBe(true);
  });

  it('has no teams when nothing is live', () => {
    expect(buildTeams({ sessions: [{ ...session('x'), state: 'ready' }], activity: { x: busy([100]) }, views: {}, runs: [], now: NOW, methodLabel: (m) => m })).toEqual([]);
  });
});

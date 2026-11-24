import type { WorkflowRunView } from '@ade/contracts';
import { strategyFor } from '@ade/reasoning';
import { buildTeams, type Team } from '@ade/session-core';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { host } from './bridge.ts';
import { useStore } from './store.ts';

interface RunsStore {
  runs: Record<string, WorkflowRunView>;
  workspaceId: string | null;
  load(workspaceId: string): Promise<void>;
}

/** Workflow runs of the open workspace, kept live, so their sessions can be shown as one team. */
export const useRuns = create<RunsStore>((set, get) => ({
  runs: {},
  workspaceId: null,
  async load(workspaceId) {
    if (get().workspaceId === workspaceId) return;
    set({ workspaceId, runs: {} });
    const list = await host.call('workflows.runs', { workspaceId }).catch(() => [] as WorkflowRunView[]);
    if (get().workspaceId === workspaceId) set({ runs: Object.fromEntries(list.map((r) => [r.id, r])) });
  },
}));

let following = false;
function followRuns() {
  if (following) return;
  following = true;
  host.on('workflow.run', (r) => {
    if (r.workspaceId === useRuns.getState().workspaceId) useRuns.setState((s) => ({ runs: { ...s.runs, [r.id]: r } }));
  });
}

/** Re-renders on an interval so intensities fade between events. */
export function useTick(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const methodLabel = (m: string) => {
  try {
    return strategyFor(m as Parameters<typeof strategyFor>[0]).label;
  } catch {
    return m;
  }
};

/** WA-08: the live teams of the open workspace, refreshed every `ms`. */
export function useTeams(ms = 1000): Team[] {
  const now = useTick(ms);
  const workspaceId = useStore((s) => s.workspaceId);
  const sessions = useStore((s) => s.sessions);
  const activity = useStore((s) => s.activity);
  const views = useStore((s) => s.views);
  const runs = useRuns((r) => r.runs);
  useEffect(() => {
    followRuns();
    if (workspaceId) void useRuns.getState().load(workspaceId);
  }, [workspaceId]);
  return useMemo(
    () => buildTeams({ sessions: Object.values(sessions).filter((s) => s.workspaceId === workspaceId), activity, views, runs: Object.values(runs), now, methodLabel }),
    [sessions, activity, views, runs, now, workspaceId],
  );
}

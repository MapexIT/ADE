import type { AgentId } from '@ade/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../lib/store.ts';
import { inputClass } from '../Modal.tsx';

export type Overrides = Partial<Record<AgentId, AgentId>>;

/**
 * WF-09: for every agent a workflow names that is not ready, pick an installed agent to stand in. Defaults to
 * the first ready agent; `blocked` is true when no agent can stand in.
 */
export function useAgentOverrides(agentsUsed: AgentId[], active: boolean) {
  const agents = useStore((s) => s.agents);
  const ready = useMemo(() => agents.filter((a) => a.health === 'ready'), [agents]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const key = agentsUsed.join(',');

  useEffect(() => {
    if (!active) return;
    const next: Overrides = {};
    for (const id of key ? (key.split(',') as AgentId[]) : []) {
      if (agents.find((a) => a.id === id)?.health !== 'ready' && ready[0]) next[id] = ready[0].id;
    }
    setOverrides(next);
  }, [active, key, agents, ready]);

  const missing = agentsUsed.filter((id) => agents.find((a) => a.id === id)?.health !== 'ready');
  return { overrides, setOverrides, missing, ready, blocked: missing.some((id) => !overrides[id]) };
}

export function AgentOverrideFields({ state }: { state: ReturnType<typeof useAgentOverrides> }) {
  const agents = useStore((s) => s.agents);
  return (
    <>
      {state.missing.map((id) => (
        <div key={id} className="flex flex-col gap-1">
          <label htmlFor={`run-override-${id}`} className="font-semibold">
            {agents.find((a) => a.id === id)?.label ?? id} is not ready. Use instead:
          </label>
          <select
            id={`run-override-${id}`}
            value={state.overrides[id] ?? ''}
            onChange={(e) => state.setOverrides((o) => ({ ...o, [id]: e.target.value as AgentId }))}
            className={inputClass}
          >
            {state.ready.length === 0 ? <option value="">No agent is ready</option> : null}
            {state.ready.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </>
  );
}

import type { AgentId, AgentInstallPlan, AgentInstallState } from '@ade/contracts';
import { create } from 'zustand';
import { host } from './bridge.ts';
import { useStore } from './store.ts';

interface InstallStore {
  plans: AgentInstallPlan[];
  states: Partial<Record<AgentId, AgentInstallState>>;
  loadPlans(): Promise<void>;
}

/** ST-07: install plans and live install progress for the coding CLIs. */
export const useInstalls = create<InstallStore>((set) => ({
  plans: [],
  states: {},
  async loadPlans() {
    const [plans, states] = await Promise.all([host.call('agents.installPlans', {}).catch(() => []), host.call('agents.installStates', {}).catch(() => [])]);
    set({ plans, states: Object.fromEntries(states.map((s) => [s.agentId, s])) });
  },
}));

let listening = false;
/** Follows install progress; when one finishes, agent health is detected again. Safe to call more than once. */
export function followInstalls() {
  if (listening) return;
  listening = true;
  host.on('agents.install', (s) => {
    useInstalls.setState((st) => ({ states: { ...st.states, [s.agentId]: s } }));
    if (s.state !== 'running') void useStore.getState().refreshAgents(true);
  });
}

export async function installAgent(agentId: AgentId): Promise<string | null> {
  try {
    const s = await host.call('agents.install', { agentId });
    useInstalls.setState((st) => ({ states: { ...st.states, [agentId]: s } }));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

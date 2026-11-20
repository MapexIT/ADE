import { emptyHandOff, initialState, reduce, type Effect, type HandOff, type RunEvent, type RunState } from './engine.ts';
import type { NodeType, Workflow, WorkflowNode } from './schema.ts';

export interface NodeResult {
  outcome: 'pass' | 'fail';
  packet: Partial<HandOff>;
  sessionId?: string;
  turns?: number;
  costUsd?: number;
}

/** Strategy per node type (M6-T02). Agent nodes start a normal session; command nodes call the code runner. */
export interface NodeExecutor<T extends WorkflowNode = WorkflowNode> {
  readonly type: T['type'];
  execute(node: T, packet: HandOff, signal: AbortSignal): Promise<NodeResult>;
}

/** Persistence for run state (`workflow_runs` in the host's SQLite). */
export interface RunStore {
  save(runId: string, workflowName: string, state: RunState): Promise<void> | void;
  load(runId: string): Promise<RunState | null> | RunState | null;
}

export class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunState>();
  save(runId: string, _name: string, state: RunState) {
    this.runs.set(runId, structuredClone(state));
  }
  load(runId: string) {
    return this.runs.get(runId) ?? null;
  }
}

export interface RunnerHooks {
  onState?(state: RunState): void;
  onGate?(nodeId: string, state: RunState): void;
  onPaused?(reason: string, state: RunState): void;
}

/**
 * Drives a run: feeds events to the pure reducer, persists every state, and performs the effects it returns
 * with the registered executors. Gates and pauses stop the loop until `decideGate` or `resume` is called.
 */
export class WorkflowRunner {
  private state: RunState;
  private readonly executors = new Map<NodeType, NodeExecutor>();
  private readonly abort = new AbortController();
  private idle: Promise<void> = Promise.resolve();
  private readonly wf: Workflow;
  private readonly runId: string;
  private readonly store: RunStore;
  private readonly hooks: RunnerHooks;

  constructor(wf: Workflow, runId: string, store: RunStore, executors: NodeExecutor[], hooks: RunnerHooks = {}, state?: RunState) {
    this.wf = wf;
    this.runId = runId;
    this.store = store;
    this.hooks = hooks;
    for (const ex of executors) this.executors.set(ex.type, ex);
    this.state = state ?? initialState(wf);
  }

  get current(): RunState {
    return this.state;
  }

  private async apply(event: RunEvent): Promise<Effect[]> {
    const { state, effects } = reduce(this.wf, this.state, event);
    this.state = state;
    await this.store.save(this.runId, this.wf.name, state);
    this.hooks.onState?.(state);
    return effects;
  }

  private async drive(effects: Effect[]): Promise<void> {
    let queue = effects;
    while (queue.length && !this.abort.signal.aborted) {
      const effect = queue.shift()!;
      if (effect.type === 'await-gate') this.hooks.onGate?.(effect.nodeId, this.state);
      else if (effect.type === 'paused') this.hooks.onPaused?.(effect.reason, this.state);
      else if (effect.type === 'run-node') {
        const node = this.wf.nodes.find((n) => n.id === effect.nodeId)!;
        const executor = this.executors.get(node.type);
        let result: NodeResult;
        await this.apply({ type: 'node.started', nodeId: node.id, at: Date.now() });
        if (!executor) result = { outcome: 'fail', packet: { summary: `No executor for ${node.type} nodes.` } };
        else {
          try {
            result = await executor.execute(node, effect.packet, this.abort.signal);
          } catch (err) {
            result = { outcome: 'fail', packet: { summary: (err as Error).message } };
          }
        }
        if (result.sessionId) await this.apply({ type: 'node.started', nodeId: node.id, sessionId: result.sessionId, at: Date.now() }).then(() => undefined);
        queue = [
          ...queue,
          ...(await this.apply({ type: 'node.finished', nodeId: node.id, outcome: result.outcome, packet: result.packet, ...(result.turns !== undefined ? { turns: result.turns } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}), at: Date.now() })),
        ];
      }
    }
  }

  private enqueue(event: RunEvent): Promise<void> {
    this.idle = this.idle.then(async () => this.drive(await this.apply(event)));
    return this.idle;
  }

  start(workItem: Record<string, string> = {}): Promise<void> {
    return this.enqueue({ type: 'start', workItem, at: Date.now() });
  }

  decideGate(nodeId: string, approved: boolean): Promise<void> {
    return this.enqueue({ type: 'gate.decided', nodeId, approved, at: Date.now() });
  }

  resume(): Promise<void> {
    return this.enqueue({ type: 'resume', at: Date.now() });
  }

  retryFrom(nodeId: string): Promise<void> {
    return this.enqueue({ type: 'retry-from', nodeId, at: Date.now() });
  }

  tick(minutes: number): Promise<void> {
    return this.enqueue({ type: 'tick', minutes });
  }

  async cancel(): Promise<void> {
    this.abort.abort();
    await this.idle.catch(() => undefined);
    const { state } = reduce(this.wf, this.state, { type: 'cancel', at: Date.now() });
    this.state = state;
    await this.store.save(this.runId, this.wf.name, state);
  }

  /** WF-11: run one node on sample input, outside any run. */
  static async testNode(executor: NodeExecutor, node: WorkflowNode, packet: Partial<HandOff> = {}): Promise<NodeResult> {
    return executor.execute(node, { ...emptyHandOff(), ...packet }, new AbortController().signal);
  }
}

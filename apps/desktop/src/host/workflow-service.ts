import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RpcError,
  type NeedsYouItem,
  type StartWorkflowInput,
  type WorkflowDetail,
  type WorkflowRunView,
  type WorkflowSummary,
} from '@ade/contracts';
import { diffPatch, git, revParse, snapshot } from '@ade/git';
import {
  parseWorkflow,
  Workflow,
  WorkflowError,
  WorkflowNode,
  WorkflowRunner,
  type HandOff,
  type RunState,
  type RunStore,
} from '@ade/workflow-engine';
import { parse, stringify } from 'yaml';
import type { EventBus } from './bus.ts';
import {
  AgentExecutor,
  CommandExecutor,
  ConnectorExecutor,
  LandExecutor,
  type ExecutorDeps,
  type RunContext,
  type RunHead,
  lastMessage,
  tail,
} from './executors.ts';
import type { Repositories, WorkflowRunRow } from './repositories.ts';
import { detailOf, listWorkflows, loadWorkflowSource, summarise } from './workflows.ts';

interface ActiveRun {
  runner: WorkflowRunner;
  wf: Workflow;
  ctx: RunContext;
  workflowId: string;
  createdAt: string;
}

const LIVE_STATUSES = ['running', 'waiting-gate', 'paused'];

interface LaunchOptions {
  workItem: Record<string, string>;
  packet?: Partial<HandOff>;
  agentOverrides: RunContext['agentOverrides'];
  /** Who started it: the user, or the event trigger that fired (WF-10). */
  actor: 'user' | 'ready-session' | 'failed-check';
  /** Event triggers continue from an existing session instead of the checkout's HEAD. */
  head?: RunHead;
  baseCommit?: string;
}

/** Setting that lets event triggers start workflows on their own. Off by default. */
export const AUTO_TRIGGERS_SETTING = 'workflows.autoTriggers';

/**
 * Runs workflows against real sessions (M6-T02). A Facade over the pure engine: it loads and validates the
 * workflow, wires the executors (Strategy) to this run's context, persists every state, and turns gates and
 * pauses into Needs you items.
 */
export class WorkflowService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly ticker: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly lastState = new Map<string, string>();
  private owned: Set<string> | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly repos: Repositories,
    private readonly bus: EventBus,
    private readonly deps: Omit<ExecutorDeps, 'saveContext' | 'claimSession'>,
    private readonly refreshInbox: () => void,
  ) {
    // WF-07: the minutes budget counts wall-clock time while a node runs.
    this.ticker = setInterval(() => {
      for (const run of this.active.values())
        if (run.runner.current.status === 'running') void run.runner.tick(1).catch(() => undefined);
    }, 60_000);
    this.ticker.unref?.();
    // WF-10: a session that finishes a turn can start `ready-session` workflows.
    this.offs.push(
      bus.on('session.changed', ({ session }) => {
        const prev = this.lastState.get(session.id);
        this.lastState.set(session.id, session.state);
        if (session.state === 'ready' && prev === 'working') {
          void this.fire('ready-session', session.workspaceId, {
            sessionId: session.id,
            title: session.title,
          }).catch((err) => console.error('[host] ready-session trigger failed', err));
        }
      }),
    );
  }

  /** WF-10: a failed run (code runner) can start `failed-check` workflows. */
  onRunRecorded(
    run: { sessionId: string | null; command: string[]; exitCode: number | null; output: string },
    workspaceId: string | null,
  ) {
    if (!workspaceId || run.exitCode === null || run.exitCode === 0) return;
    const command = run.command.join(' ');
    void this.fire('failed-check', workspaceId, {
      sessionId: run.sessionId,
      title: `Fix: ${command}`,
      checkOutput: tail(`$ ${command}\n${run.output.trimEnd()}\n[exit ${run.exitCode}]`, 20_000),
    }).catch((err) => console.error('[host] failed-check trigger failed', err));
  }

  /** Sessions started by workflow steps. They never fire triggers, so a workflow cannot start itself. */
  private ownedSessions(): Set<string> {
    this.owned ??= new Set(this.repos.workflowRuns.allSessionIds());
    return this.owned;
  }

  /**
   * Starts every valid repository workflow whose trigger matches, when the user allowed event triggers.
   * Templates never start on their own. A ready session's work is the run's starting point.
   */
  async fire(
    trigger: 'ready-session' | 'failed-check',
    workspaceId: string,
    seed: { sessionId: string | null; title: string; checkOutput?: string },
  ): Promise<WorkflowRunView[]> {
    if (this.disposed || !this.repos.settings.get<boolean>(AUTO_TRIGGERS_SETTING, false)) return [];
    if (seed.sessionId && this.ownedSessions().has(seed.sessionId)) return [];
    const workspace = this.repos.workspaces.get(workspaceId);
    if (!workspace) return [];
    const matching = (await listWorkflows(workspace.rootPath)).filter(
      (w) =>
        w.source === 'repository' && w.trigger === trigger && !w.problems.some((p) => p.level === 'error'),
    );
    if (!matching.length) return [];

    let head: RunHead | undefined;
    let baseCommit: string | undefined;
    const packet: Partial<HandOff> = seed.checkOutput ? { checkOutput: seed.checkOutput } : {};
    const session = seed.sessionId ? this.repos.sessions.get(seed.sessionId) : null;
    if (session?.worktreePath && session.baseCommit && session.state === 'ready') {
      const commit =
        this.repos.turns.list(session.id).at(-1)?.endCheckpoint ??
        (await snapshot(session.worktreePath, null, 'ADE workflow trigger'));
      head = { sessionId: session.id, worktree: session.worktreePath, commit };
      baseCommit = session.baseCommit;
      packet.summary = lastMessage(this.repos.events.list(session.id));
      packet.diff = tail(
        (await diffPatch(session.worktreePath, session.baseCommit, commit)).toString('utf8'),
        40_000,
      );
    }

    const started: WorkflowRunView[] = [];
    for (const w of matching) {
      const yaml = await loadWorkflowSource(workspace.rootPath, w.id);
      if (!yaml) continue;
      const run = await this.launch(workspace, w.id, yaml, {
        workItem: { title: seed.title },
        packet,
        agentOverrides: {},
        actor: trigger,
        ...(head ? { head } : {}),
        ...(baseCommit ? { baseCommit } : {}),
      });
      const why = trigger === 'ready-session' ? 'a session finished' : 'a check failed';
      this.bus.emit('notify', {
        sessionId: seed.sessionId ?? '',
        title: 'A workflow started',
        body: `${w.name} (${why})`,
      });
      started.push(run);
    }
    return started;
  }

  async start(input: StartWorkflowInput): Promise<WorkflowRunView> {
    const workspace = this.workspace(input.workspaceId);
    const yaml = await loadWorkflowSource(workspace.rootPath, input.workflowId);
    if (yaml === null) throw new RpcError('not_found', 'Unknown workflow');
    return this.launch(workspace, input.workflowId, yaml, {
      workItem: input.workItem ?? {},
      agentOverrides: input.agentOverrides ?? {},
      ...(input.handOff ? { packet: input.handOff } : {}),
      actor: 'user',
    });
  }

  /** WF-11: one node on sample input, as a one-step run the run view shows like any other. */
  async testNode(input: {
    workspaceId: string;
    node: unknown;
    sample: Partial<HandOff>;
    workItem: Record<string, string>;
    agentOverrides: RunContext['agentOverrides'];
  }): Promise<WorkflowRunView> {
    const parsed = WorkflowNode.safeParse(input.node);
    if (!parsed.success)
      throw new RpcError(
        'invalid_workflow',
        `The step is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    const node = parsed.data;
    if (node.type === 'gate' || node.type === 'loop' || node.type === 'branch')
      throw new RpcError('not_testable', 'Gates, loops and branches have nothing to run on their own.');
    if (node.type === 'land')
      throw new RpcError('not_testable', 'Land steps only run after a gate inside a workflow.');
    const yaml = stringify({ name: `Test: ${node.title ?? node.id}`, nodes: [node] });
    return this.launch(this.workspace(input.workspaceId), `test:${node.id}`, yaml, {
      workItem: input.workItem,
      packet: input.sample,
      agentOverrides: input.agentOverrides,
      actor: 'user',
    });
  }

  private workspace(id: string) {
    const workspace = this.repos.workspaces.get(id);
    if (!workspace) throw new RpcError('not_found', 'Unknown workspace');
    return workspace;
  }

  private async launch(
    workspace: { id: string; rootPath: string },
    workflowId: string,
    yaml: string,
    opts: LaunchOptions,
  ): Promise<WorkflowRunView> {
    const { workItem, packet, agentOverrides } = opts;
    let wf: Workflow;
    try {
      wf = parseWorkflow(yaml);
    } catch (err) {
      const message =
        err instanceof WorkflowError
          ? err.problems
              .filter((p) => p.level === 'error')
              .map((p) => p.message)
              .join(' ')
          : (err as Error).message;
      throw new RpcError('invalid_workflow', `The workflow cannot run: ${message}`);
    }
    const baseCommit =
      opts.baseCommit ??
      (await revParse(workspace.rootPath, 'HEAD').catch(() => {
        throw new RpcError(
          'no_commit',
          'The repository needs at least one commit before a workflow can run.',
        );
      }));
    const id = randomUUID();
    const ctx: RunContext = {
      runId: id,
      workflowName: wf.name,
      workspaceId: workspace.id,
      repoRoot: workspace.rootPath,
      baseCommit,
      head: opts.head ?? null,
      agentOverrides,
      scratchWorktree: null,
    };
    const row = this.repos.workflowRuns.insert({
      id,
      workspaceId: workspace.id,
      workflowId,
      yaml,
      status: 'running',
      state: null,
      context: ctx,
    });
    const run = this.activate(row, wf, ctx, undefined);
    this.repos.audit.append({
      workspaceId: workspace.id,
      sessionId: null,
      actor: opts.actor === 'user' ? 'user' : 'workflow',
      action: opts.actor === 'user' ? 'workflow.started' : 'workflow.triggered',
      detail: {
        runId: id,
        workflow: workflowId,
        agentOverrides,
        ...(opts.actor !== 'user' ? { trigger: opts.actor } : {}),
      },
    });
    void run.runner.start(workItem, packet).catch((err) => this.fail(id, err as Error));
    return this.view(run, row.id);
  }

  async detail(workspaceId: string, workflowId: string): Promise<WorkflowDetail> {
    const workspace = this.workspace(workspaceId);
    const yaml = await loadWorkflowSource(workspace.rootPath, workflowId);
    if (yaml === null) throw new RpcError('not_found', 'Unknown workflow');
    const source = workflowId.startsWith('template:') ? 'template' : 'repository';
    const path = source === 'repository' ? `.ade/workflows/${workflowId.slice('repo:'.length)}` : null;
    let definition: unknown = null;
    try {
      definition = parse(yaml);
    } catch {
      definition = null;
    }
    return { summary: summarise(workflowId, source, path, yaml), yaml, definition };
  }

  /** WF-01 / WF-03: the editor saves YAML into the repository, so workflows are versioned with the code. */
  async save(workspaceId: string, file: string, definition: unknown): Promise<WorkflowSummary> {
    const workspace = this.workspace(workspaceId);
    const parsed = Workflow.safeParse(definition);
    if (!parsed.success)
      throw new RpcError(
        'invalid_workflow',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const yaml = stringify(parsed.data, { lineWidth: 0 });
    const dir = join(workspace.rootPath, '.ade', 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), yaml, 'utf8');
    this.repos.audit.append({
      workspaceId,
      sessionId: null,
      actor: 'user',
      action: 'workflow.saved',
      detail: { file },
    });
    return summarise(`repo:${file}`, 'repository', `.ade/workflows/${file}`, yaml);
  }

  /** Builds the runner, executors and store for a run (new, or reloaded after a restart). */
  private activate(
    row: WorkflowRunRow,
    wf: Workflow,
    ctx: RunContext,
    state: RunState | undefined,
  ): ActiveRun {
    const saveContext = (c: RunContext) =>
      this.repos.workflowRuns.save(row.id, active.runner.current.status, active.runner.current, c);
    const deps: ExecutorDeps = {
      ...this.deps,
      saveContext,
      claimSession: (id) => this.ownedSessions().add(id),
    };
    const store: RunStore = {
      save: (runId, _name, s) => this.repos.workflowRuns.save(runId, s.status, s, ctx),
      load: (runId) => (this.repos.workflowRuns.get(runId)?.state as RunState | null) ?? null,
    };
    const runner = new WorkflowRunner(
      wf,
      row.id,
      store,
      [
        new AgentExecutor(deps, ctx),
        new CommandExecutor(deps, ctx),
        new LandExecutor(deps, ctx),
        new ConnectorExecutor(),
      ],
      {
        onState: () => this.publish(row.id),
        onGate: (nodeId) => {
          const node = wf.nodes.find((n) => n.id === nodeId);
          this.bus.emit('notify', {
            sessionId: ctx.head?.sessionId ?? '',
            title: 'A workflow is waiting for you',
            body: `${wf.name}: ${node?.type === 'gate' ? node.question : nodeId}`,
          });
        },
        onPaused: (reason) =>
          this.bus.emit('notify', {
            sessionId: ctx.head?.sessionId ?? '',
            title: 'A workflow paused',
            body: `${wf.name}: ${reason}`,
          }),
      },
      state,
    );
    const active: ActiveRun = { runner, wf, ctx, workflowId: row.workflowId, createdAt: row.createdAt };
    this.active.set(row.id, active);
    return active;
  }

  private fail(runId: string, err: Error) {
    console.error(`[host] workflow run ${runId} failed`, err);
    const run = this.active.get(runId);
    if (!run) return;
    const state: RunState = {
      ...run.runner.current,
      status: 'failed',
      log: [...run.runner.current.log, `error: ${err.message}`],
    };
    this.repos.workflowRuns.save(runId, 'failed', state, run.ctx);
    this.active.delete(runId);
    this.publishRow(runId);
  }

  /** Runs that were live when ADE closed come back paused, so nothing restarts without the user (WF-07). */
  recover(): void {
    for (const row of this.repos.workflowRuns.inStatuses(LIVE_STATUSES)) {
      const state = row.state as RunState | null;
      if (state?.status === 'running') {
        const paused: RunState = {
          ...state,
          status: 'paused',
          pauseReason: 'ADE was closed while the run was running.',
        };
        this.repos.workflowRuns.save(row.id, 'paused', paused, row.context);
      }
    }
  }

  private load(runId: string): ActiveRun {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const row = this.repos.workflowRuns.get(runId);
    if (!row) throw new RpcError('not_found', 'Unknown workflow run');
    if (!LIVE_STATUSES.includes(row.status)) throw new RpcError('run_ended', 'This run has ended.');
    return this.activate(row, parseWorkflow(row.yaml), row.context as RunContext, row.state as RunState);
  }

  private act(runId: string, what: (run: ActiveRun) => Promise<void>): { ok: true } {
    const run = this.load(runId);
    void what(run).catch((err) => this.fail(runId, err as Error));
    return { ok: true };
  }

  decideGate(runId: string, nodeId: string, approved: boolean) {
    const run = this.load(runId);
    const s = run.runner.current;
    if (s.status !== 'waiting-gate' || s.current !== nodeId)
      throw new RpcError('not_waiting', 'That step is not waiting for a decision.');
    this.repos.audit.append({
      workspaceId: run.ctx.workspaceId,
      sessionId: run.ctx.head?.sessionId ?? null,
      actor: 'user',
      action: approved ? 'workflow.gate.approved' : 'workflow.gate.rejected',
      detail: { runId, nodeId },
    });
    return this.act(runId, (r) => r.runner.decideGate(nodeId, approved));
  }

  resume(runId: string) {
    if (this.load(runId).runner.current.status !== 'paused')
      throw new RpcError('not_paused', 'Only a paused run can resume.');
    return this.act(runId, (r) => r.runner.resume());
  }

  retryFrom(runId: string, nodeId: string) {
    const run = this.load(runId);
    if (!run.wf.nodes.some((n) => n.id === nodeId)) throw new RpcError('not_found', 'Unknown step');
    if (run.runner.current.status === 'running')
      throw new RpcError('busy', 'Wait for the running step to finish, or cancel the run.');
    return this.act(runId, (r) => r.runner.retryFrom(nodeId));
  }

  async cancel(runId: string): Promise<{ ok: true }> {
    const run = this.load(runId);
    await run.runner.cancel();
    this.repos.audit.append({
      workspaceId: run.ctx.workspaceId,
      sessionId: null,
      actor: 'user',
      action: 'workflow.cancelled',
      detail: { runId },
    });
    this.active.delete(runId);
    this.publishRow(runId);
    return { ok: true };
  }

  list(workspaceId: string): WorkflowRunView[] {
    return this.repos.workflowRuns.list(workspaceId).flatMap((row) => {
      const v = this.viewOf(row);
      return v ? [v] : [];
    });
  }

  get(runId: string): WorkflowRunView | null {
    const row = this.repos.workflowRuns.get(runId);
    return row ? this.viewOf(row) : null;
  }

  /** WF-06 inbox side: one item per gate waiting and per paused run. */
  inbox(): NeedsYouItem[] {
    const items: NeedsYouItem[] = [];
    for (const row of this.repos.workflowRuns.inStatuses(['waiting-gate', 'paused'])) {
      const state = row.state as RunState | null;
      if (!state) continue;
      const ctx = row.context as RunContext;
      const wf = safeParse(row.yaml);
      const node = wf?.nodes.find((n) => n.id === state.current);
      items.push({
        id: `workflow:${row.id}:${state.current ?? ''}`,
        sessionId: ctx.head?.sessionId ?? '',
        sessionTitle: ctx.workflowName,
        kind: row.status === 'paused' ? 'paused' : 'gate',
        title:
          row.status === 'paused'
            ? (state.pauseReason ?? 'The run paused')
            : node?.type === 'gate'
              ? node.question
              : 'Waiting for a decision',
        createdAt: row.createdAt,
        runId: row.id,
        ...(state.current ? { nodeId: state.current } : {}),
      });
    }
    return items;
  }

  private publish(runId: string) {
    if (this.disposed) return;
    const run = this.active.get(runId);
    if (run) {
      this.bus.emit('workflow.run', this.view(run, runId));
      const status = run.runner.current.status;
      if (status !== 'running' && status !== 'waiting-gate' && status !== 'paused') this.active.delete(runId);
    }
    this.refreshInbox();
  }

  private publishRow(runId: string) {
    if (this.disposed) return;
    const v = this.get(runId);
    if (v) this.bus.emit('workflow.run', v);
    this.refreshInbox();
  }

  private view(run: ActiveRun, runId: string): WorkflowRunView {
    return buildView(runId, run.ctx, run.workflowId, run.wf, run.runner.current, run.createdAt);
  }

  private viewOf(row: WorkflowRunRow): WorkflowRunView | null {
    const active = this.active.get(row.id);
    if (active) return this.view(active, row.id);
    const wf = safeParse(row.yaml);
    if (!wf) return null;
    const state = (row.state as RunState | null) ?? {
      ...emptyState(wf),
      status: row.status as RunState['status'],
    };
    return buildView(row.id, row.context as RunContext, row.workflowId, wf, state, row.createdAt);
  }

  /** Removes scratch worktrees of runs that ended. Session worktrees stay with their sessions. */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.ticker);
    for (const off of this.offs) off();
    for (const [runId, run] of this.active) {
      if (run.ctx.scratchWorktree && !LIVE_STATUSES.includes(run.runner.current.status)) {
        await git(['worktree', 'remove', '--force', run.ctx.scratchWorktree], {
          cwd: run.ctx.repoRoot,
        }).catch(() => undefined);
      }
      this.active.delete(runId);
    }
  }
}

function safeParse(yaml: string): Workflow | null {
  try {
    return parseWorkflow(yaml);
  } catch {
    return null;
  }
}

function emptyState(wf: Workflow): RunState {
  return {
    status: 'running',
    current: null,
    nodes: Object.fromEntries(
      wf.nodes.map((n) => [
        n.id,
        { status: 'pending', attempts: 0, sessionId: null, output: null, startedAt: null, endedAt: null },
      ]),
    ),
    loops: {},
    used: { turns: 0, minutes: 0, loops: 0, costUsd: 0 },
    packet: { summary: '', diff: '', checkOutput: '', workItem: {} },
    pauseReason: null,
    log: [],
  };
}

export function buildView(
  id: string,
  ctx: RunContext,
  workflowId: string,
  wf: Workflow,
  s: RunState,
  createdAt: string,
): WorkflowRunView {
  return {
    id,
    workspaceId: ctx.workspaceId,
    workflowId,
    workflowName: wf.name,
    status: s.status,
    current: s.current,
    pauseReason: s.pauseReason,
    nodes: wf.nodes.map((n) => {
      const nr = s.nodes[n.id];
      return {
        id: n.id,
        type: n.type,
        title: n.title ?? n.id,
        detail: detailOf(n),
        status: nr?.status ?? 'pending',
        attempts: nr?.attempts ?? 0,
        sessionId: nr?.sessionId ?? null,
        startedAt: nr?.startedAt ?? null,
        endedAt: nr?.endedAt ?? null,
        summary:
          n.type === 'gate' || n.type === 'loop' || n.type === 'branch' ? '' : (nr?.output?.summary ?? ''),
      };
    }),
    edges: wf.edges.map((e) => ({ from: e.from, to: e.to, when: e.when ?? null })),
    used: s.used,
    budgets: wf.budgets,
    log: s.log,
    createdAt,
  };
}

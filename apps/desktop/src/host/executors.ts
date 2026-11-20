import { join } from 'node:path';
import { findOnPath, killTree, spawnCommand, toSpawnable, type Command } from '@ade/acp-client';
import type { AgentId, PromptBlock, SessionEvent } from '@ade/contracts';
import { changedFiles, diffPatch, git, snapshot } from '@ade/git';
import {
  renderPrompt,
  type AgentNode,
  type CommandNode,
  type ConnectorNode,
  type ExecutionContext,
  type HandOff,
  type LandNode,
  type NodeExecutor,
  type NodeResult,
} from '@ade/workflow-engine';
import type { EventBus } from './bus.ts';
import type { Repositories } from './repositories.ts';
import type { ReviewService } from './review-service.ts';
import type { SessionService } from './session-service.ts';

/** Hand-off text limits: enough for an agent to act on, small enough for a prompt. */
const MAX_DIFF = 40_000;
const MAX_OUTPUT = 20_000;

export const tail = (text: string, max: number) =>
  text.length > max ? `[earlier output cut]\n${text.slice(-max)}` : text;

/** Where the run's work currently lives. Agent nodes move it forward; commands and land read it. */
export interface RunHead {
  sessionId: string | null;
  worktree: string;
  commit: string;
}

/** Per-run state the executors share. Persisted with the run so it survives a restart. */
export interface RunContext {
  runId: string;
  workflowName: string;
  workspaceId: string;
  repoRoot: string;
  /** The commit the run started from. Land diffs from here so every node's work lands together. */
  baseCommit: string;
  head: RunHead | null;
  agentOverrides: Partial<Record<AgentId, AgentId>>;
  /** Detached worktree for command nodes that run before any agent node. */
  scratchWorktree: string | null;
}

export interface ExecutorDeps {
  repos: Repositories;
  bus: EventBus;
  sessions: SessionService;
  review: ReviewService;
  worktreesDir: string;
  /** Turns `argv[0]` into something spawnable without a shell (resolves `.cmd` shims on Windows). */
  resolveCommand(argv: string[]): { command: Command; env: Record<string, string> } | null;
  /** Called when the context changes so the service can persist it. */
  saveContext(ctx: RunContext): void;
  /** Marks a session as started by a workflow, so it never fires workflow triggers itself. */
  claimSession(sessionId: string): void;
}

const text = (t: string): PromptBlock[] => [{ type: 'text', text: t }];

/**
 * Agent nodes start a normal session (same worktree, approvals, review and audit as any other session) from
 * where the previous node left off, wait for its first turn to end, and hand on its message and diff.
 */
export class AgentExecutor implements NodeExecutor<AgentNode> {
  readonly type = 'agent' as const;
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly ctx: RunContext,
  ) {}

  async execute(node: AgentNode, packet: HandOff, exec: ExecutionContext): Promise<NodeResult> {
    const agentId = this.ctx.agentOverrides[node.agent] ?? node.agent;
    const prompt = renderPrompt(node.prompt, packet);
    const base = this.ctx.head?.commit ?? this.ctx.baseCommit;

    let sessionId: string | null = null;
    const early: SessionEvent[] = [];
    let onEvent: ((e: SessionEvent) => void) | null = null;
    const offEvent = this.deps.bus.on('session.event', (e) => {
      if (sessionId === null) early.push(e);
      else if (e.sessionId === sessionId) onEvent?.(e);
    });
    let onState: ((state: string) => void) | null = null;
    const offState = this.deps.bus.on('session.changed', ({ session }) => {
      if (session.id === sessionId) onState?.(session.state);
    });

    try {
      const session = await this.deps.sessions.create({
        workspaceId: this.ctx.workspaceId,
        agentId,
        title: `${this.ctx.workflowName}: ${node.title ?? node.id}`,
        prompt: text(prompt),
        permissionProfile: node.profile,
        baseRef: base,
        ...(node.model ? { modelId: node.model } : {}),
        ...(packet.workItem.ref ? { workItemRef: packet.workItem.ref } : {}),
      });
      sessionId = session.id;
      this.deps.claimSession(session.id);
      exec.reportSession(session.id);

      const ended = await new Promise<{ stopReason: string; costUsd: number | null } | { failed: string }>(
        (resolve) => {
          const finish = (v: { stopReason: string; costUsd: number | null } | { failed: string }) => {
            exec.signal.removeEventListener('abort', abort);
            resolve(v);
          };
          const handle = (e: SessionEvent) => {
            if (e.type === 'turn.ended')
              finish({ stopReason: e.stopReason, costUsd: e.usage?.costUsd ?? null });
          };
          onEvent = handle;
          onState = (state) => {
            if (state === 'interrupted') finish({ failed: 'The session stopped before its turn ended.' });
            if (state === 'discarded') finish({ failed: 'The session was discarded.' });
          };
          const abort = () => {
            void this.deps.sessions.cancel(session.id).catch(() => undefined);
            finish({ failed: 'The run was cancelled.' });
          };
          exec.signal.addEventListener('abort', abort);
          for (const e of early.splice(0)) if (e.sessionId === session.id) handle(e);
          const now = this.deps.repos.sessions.get(session.id)?.state;
          if (now === 'interrupted') finish({ failed: 'The session stopped before its turn ended.' });
        },
      );

      if ('failed' in ended)
        return { outcome: 'fail', sessionId: session.id, packet: { summary: ended.failed } };

      const current = this.deps.repos.sessions.require(session.id);
      const turn = this.deps.repos.turns.list(session.id).at(-1);
      const endCommit =
        turn?.endCheckpoint ?? (await snapshot(current.worktreePath!, null, 'ADE workflow hand-off'));
      const diff = (await diffPatch(current.worktreePath!, base, endCommit)).toString('utf8');
      this.ctx.head = { sessionId: session.id, worktree: current.worktreePath!, commit: endCommit };
      this.deps.saveContext(this.ctx);

      return {
        outcome: ended.stopReason === 'end_turn' ? 'pass' : 'fail',
        sessionId: session.id,
        turns: 1,
        ...(ended.costUsd !== null ? { costUsd: ended.costUsd } : {}),
        packet: {
          summary:
            lastMessage(this.deps.repos.events.list(session.id)) ||
            `${node.id} finished (${ended.stopReason}).`,
          diff: tail(diff, MAX_DIFF),
        },
      };
    } catch (err) {
      return {
        outcome: 'fail',
        ...(sessionId ? { sessionId } : {}),
        packet: { summary: (err as Error).message },
      };
    } finally {
      offEvent();
      offState();
    }
  }
}

/** The agent's messages from its latest turn, which become the next node's `{{summary}}`. */
export function lastMessage(events: SessionEvent[]): string {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === 'turn.started') start = i;
  });
  return events
    .slice(start)
    .flatMap((e) => (e.type === 'agent.message' ? [e.text] : []))
    .join('\n\n')
    .trim();
}

/** Command nodes run an argument array (never a shell string) where the run's work is, and pass on exit 0. */
export class CommandExecutor implements NodeExecutor<CommandNode> {
  readonly type = 'command' as const;
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly ctx: RunContext,
  ) {}

  private async cwd(): Promise<string> {
    if (this.ctx.head) return this.ctx.head.worktree;
    if (!this.ctx.scratchWorktree) {
      const path = join(this.deps.worktreesDir, 'workflow-runs', this.ctx.runId);
      await git(['worktree', 'add', '--detach', path, this.ctx.baseCommit], { cwd: this.ctx.repoRoot });
      this.ctx.scratchWorktree = path;
      this.deps.saveContext(this.ctx);
    }
    return this.ctx.scratchWorktree;
  }

  async execute(node: CommandNode, _packet: HandOff, exec: ExecutionContext): Promise<NodeResult> {
    const resolved = this.deps.resolveCommand(node.run);
    if (!resolved)
      return {
        outcome: 'fail',
        packet: {
          checkOutput: `${node.run[0]} was not found on the PATH.`,
          summary: `${node.run[0]} was not found.`,
        },
      };
    const cwd = await this.cwd();
    const startedAt = new Date().toISOString();
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
      let out = '';
      const child = spawnCommand(
        { command: resolved.command.command, args: [...resolved.command.args, ...node.run.slice(1)] },
        {
          cwd,
          env: { ...process.env, ...resolved.env, CI: '1', FORCE_COLOR: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const add = (b: Buffer) => {
        out += b.toString('utf8');
        if (out.length > 400_000) out = out.slice(-200_000);
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      const abort = () => child.pid && void killTree(child.pid);
      exec.signal.addEventListener('abort', abort);
      child.on('error', (err) => resolve({ code: null, output: `${out}\n${err.message}` }));
      child.on('close', (c) => {
        exec.signal.removeEventListener('abort', abort);
        resolve({ code: c, output: out });
      });
    });
    // Visible in the run history like any other run (CR-04).
    this.deps.repos.runs.record(
      {
        runConfigId: null,
        sessionId: this.ctx.head?.sessionId ?? null,
        worktreePath: cwd,
        command: node.run,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: code,
        output,
      },
      this.ctx.workspaceId,
    );
    const pass = code === 0;
    return {
      outcome: pass ? 'pass' : 'fail',
      packet: {
        checkOutput: tail(output, MAX_OUTPUT),
        summary: `${node.run.join(' ')} ${pass ? 'passed' : `failed (exit ${code ?? 'none'})`}.`,
      },
    };
  }
}

/**
 * Land nodes only run after a gate the user approved (the schema requires one), which is the explicit user
 * action CLAUDE.md rule 4 asks for. Pull requests are not opened by ADE yet: the change is committed on the
 * session branch and the summary says so (RV-14 arrives in M7-T03).
 */
export class LandExecutor implements NodeExecutor<LandNode> {
  readonly type = 'land' as const;
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly ctx: RunContext,
  ) {}

  async execute(node: LandNode, packet: HandOff): Promise<NodeResult> {
    const head = this.ctx.head;
    if (!head?.sessionId)
      return {
        outcome: 'fail',
        packet: { summary: 'There is nothing to land: no agent node made changes.' },
      };
    const files = (
      await changedFiles(head.worktree, this.ctx.baseCommit, await snapshot(head.worktree, null, 'ADE land'))
    ).map((c) => c.path);
    if (!files.length)
      return { outcome: 'fail', packet: { summary: 'There is nothing to land: the run changed no files.' } };
    const message = packet.workItem.title ? `${packet.workItem.title}` : this.ctx.workflowName;
    const mode = node.mode === 'apply' ? 'apply' : 'commit';
    const session = this.deps.repos.sessions.require(head.sessionId);
    await this.deps.review.land(head.sessionId, mode, files, message, this.ctx.baseCommit);
    this.deps.repos.audit.append({
      workspaceId: this.ctx.workspaceId,
      sessionId: head.sessionId,
      actor: 'workflow',
      action: 'workflow.landed',
      detail: { runId: this.ctx.runId, mode: node.mode, files },
    });
    const summary =
      node.mode === 'apply'
        ? `Applied ${files.length} file(s) to your checkout.`
        : node.mode === 'commit'
          ? `Committed ${files.length} file(s) on ${session.branch}.`
          : `Committed ${files.length} file(s) on ${session.branch}. ADE does not open pull requests yet: push the branch and open one yourself.`;
    return { outcome: 'pass', sessionId: head.sessionId, packet: { summary } };
  }
}

/** Connector actions (comment, move a story) arrive with CO-05 to CO-10 in M7; until then the node says so. */
export class ConnectorExecutor implements NodeExecutor<ConnectorNode> {
  readonly type = 'connector' as const;
  async execute(node: ConnectorNode): Promise<NodeResult> {
    return {
      outcome: 'fail',
      packet: { summary: `The ${node.connector} action "${node.action}" is not supported yet.` },
    };
  }
}

/** Resolves a command name on the PATH and how to spawn it without a shell. */
export function commandResolver(node: Command, nodeEnv: Record<string, string>) {
  return (argv: string[]): { command: Command; env: Record<string, string> } | null => {
    const name = argv[0];
    if (!name) return null;
    const path = /[\\/]/.test(name) ? name : findOnPath(name);
    if (!path) return null;
    const command = toSpawnable(path, node.command);
    if (!command) return null;
    const usesNode = command.command === node.command;
    return {
      command: usesNode ? { command: command.command, args: [...node.args, ...command.args] } : command,
      env: usesNode ? nodeEnv : {},
    };
  };
}

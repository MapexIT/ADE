import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent, AgentRuntime, AgentSession, PermissionRequestInfo, McpServerSpec } from '@ade/acp-client';
import { AgentAuthRequiredError } from '@ade/acp-client';
import {
  RpcError,
  type AgentId,
  type CreateSessionInput,
  type DistributiveOmit,
  type NeedsYouItem,
  type NewSessionEvent,
  type PermissionDecision,
  type PromptBlock,
  type ProtocolMessage,
  type Session,
  type SessionState,
  type Turn,
} from '@ade/contracts';
import { bringChanges, copyFiles, createWorktree, revParse, slugify, snapshot } from '@ade/git';
import { ChunkCoalescer, isLive, isTerminal, nextState, type SessionTrigger } from '@ade/session-core';
import type { EventBus } from './bus.ts';
import { profilePolicy, type PermissionPolicy } from './permission-policy.ts';
import type { Repositories } from './repositories.ts';
import { readWorkspaceConfig, toArgv } from './workspace-config.ts';

export interface HostPaths {
  userData: string;
  worktrees: string;
  patches: string;
  fakeAgentState: string;
}

interface PendingPermission {
  info: PermissionRequestInfo;
  resolve: (d: PermissionDecision) => void;
}

interface LiveSession {
  agent: AgentSession;
  coalescer: ChunkCoalescer;
  turn: Turn | null;
  pending: Map<string, PendingPermission>;
  protocol: ProtocolMessage[];
  closing: boolean;
  turnTimer: NodeJS.Timeout | null;
}

export interface Limits {
  maxTurns: number;
  maxTurnMinutes: number;
}

type EventInput = DistributiveOmit<NewSessionEvent, 'sessionId'>;

const PROTOCOL_RING = 2000;
const checkpointRefName = (sessionId: string, index: number, at: 'start' | 'end') => `refs/ade/checkpoints/${sessionId}/${index}-${at}`;
const titleFrom = (content: PromptBlock[]) => {
  const text = content.find((b) => b.type === 'text')?.text ?? 'New session';
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? 'New session';
  return line.trim().slice(0, 80);
};

/**
 * Orchestrates sessions: worktree, setup, agent process, turns, checkpoints, permission requests, the queue
 * and the concurrency cap. Agent-neutral: it only talks to the `AgentRuntime` / `AgentSession` seam.
 */
export class SessionService {
  private readonly live = new Map<string, LiveSession>();
  private readonly bootOptions = new Map<string, { bringChanges: boolean; modeId?: string; modelId?: string; skills?: string[] }>();
  private readonly booting = new Set<string>();
  private disposed = false;
  /** Extra MCP servers to hand agents (connectors, M5). */
  mcpServersFor: (workspaceId: string) => McpServerSpec[] = () => [];

  constructor(
    private readonly repos: Repositories,
    private readonly bus: EventBus,
    private readonly runtimes: Map<AgentId, AgentRuntime>,
    private readonly paths: HostPaths,
    private readonly policy: PermissionPolicy = profilePolicy,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // ---------------------------------------------------------------- events and state

  private append(sessionId: string, event: EventInput, turnId: string | null = null) {
    if (this.disposed) return null;
    const stored = this.repos.events.append({ ...event, sessionId } as NewSessionEvent, turnId);
    this.bus.emit('session.event', stored);
    return stored;
  }

  /** Appends an event on behalf of another service so it is stored and published the same way. */
  record(sessionId: string, event: EventInput) {
    return this.append(sessionId, event);
  }

  private emitTransient(sessionId: string, event: EventInput) {
    this.bus.emit('session.event', { ...event, sessionId, seq: this.repos.events.lastSeq(sessionId), ts: new Date().toISOString() } as never);
  }

  /** Applies a state-machine trigger. Returns false (and changes nothing) when the transition is not allowed. */
  private fire(sessionId: string, trigger: SessionTrigger, reason: string | null = null): boolean {
    if (this.disposed) return false;
    const session = this.repos.sessions.require(sessionId);
    const to = nextState(session.state, trigger);
    if (to === null) return false;
    this.setState(session, to, reason);
    return true;
  }

  private setState(session: Session, to: SessionState, reason: string | null) {
    const updated = this.repos.sessions.update(session.id, { state: to, ...(isTerminal(to) ? { endedAt: new Date().toISOString() } : {}) });
    this.append(session.id, { type: 'session.state_changed', from: session.state, to, reason });
    this.bus.emit('session.changed', { workspaceId: updated.workspaceId, session: updated });
    this.refreshInbox();
    if (isLive(session.state) && !isLive(to)) setImmediate(() => this.maybeDequeue());
  }

  private notify(sessionId: string, title: string, body: string) {
    this.bus.emit('notify', { sessionId, title, body });
  }

  private audit(session: Session, action: string, detail: Record<string, unknown>, actor = 'user') {
    this.repos.audit.append({ workspaceId: session.workspaceId, sessionId: session.id, actor, action, detail });
  }

  limits(): Limits {
    return this.repos.settings.get<Limits>('limits', { maxTurns: 50, maxTurnMinutes: 60 });
  }

  concurrencyCap(): number {
    return Math.max(1, this.repos.settings.get<number>('concurrencyCap', 3));
  }

  // ---------------------------------------------------------------- queries

  protocol(sessionId: string): ProtocolMessage[] {
    return this.live.get(sessionId)?.protocol ?? [];
  }

  isLive(sessionId: string) {
    return this.live.has(sessionId);
  }

  hasActiveTurn(sessionId: string) {
    return !!this.live.get(sessionId)?.turn;
  }

  /** SK-01: copies named skills into the agent's skills folder in the worktree. Set by the composition root. */
  installSkills: ((repoRoot: string, worktree: string, agentId: AgentId, names: string[]) => Promise<string[]>) | null = null;

  /** Other services that add items to Needs you (workflow gates and paused runs). */
  readonly inboxSources: (() => NeedsYouItem[])[] = [];

  inbox(): NeedsYouItem[] {
    const items: NeedsYouItem[] = this.inboxSources.flatMap((source) => source());
    for (const [sessionId, live] of this.live) {
      const session = this.repos.sessions.get(sessionId);
      if (!session) continue;
      for (const [requestId, p] of live.pending) {
        items.push({
          id: requestId,
          sessionId,
          sessionTitle: session.title,
          kind: p.info.kind === 'think' ? 'question' : 'permission',
          title: p.info.title,
          createdAt: new Date().toISOString(),
        });
      }
    }
    for (const s of this.repos.sessions.inStates(['interrupted'])) {
      const last = this.repos.events.list(s.id).filter((e) => e.type === 'session.state_changed').at(-1);
      const reason = last?.type === 'session.state_changed' ? last.reason : null;
      items.push({
        id: `interrupted:${s.id}`,
        sessionId: s.id,
        sessionTitle: s.title,
        kind: reason?.startsWith('Setup') ? 'setup-failed' : 'interrupted',
        title: reason ?? 'The session was interrupted',
        createdAt: s.createdAt,
      });
    }
    return items;
  }

  refreshInbox() {
    if (this.disposed) return;
    this.bus.emit('inbox.changed', this.inbox());
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called once when the host starts: sessions that were live when ADE closed become Interrupted. */
  recover(): void {
    for (const s of this.repos.sessions.inStates(['starting', 'working', 'waiting-on-user'])) {
      this.repos.turns.closeDangling(s.id, 'interrupted');
      this.repos.permissions.cancelDangling(s.id);
      this.setState(s, 'interrupted', 'ADE was closed while the session was running');
    }
    setImmediate(() => this.maybeDequeue());
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const workspace = this.repos.workspaces.get(input.workspaceId);
    if (!workspace) throw new RpcError('not_found', 'Unknown workspace');
    const runtime = this.runtimes.get(input.agentId);
    if (!runtime) throw new RpcError('agent_unavailable', `Agent ${input.agentId} is not available`);
    const launchable = 'launchable' in runtime ? await (runtime as { launchable(): Promise<{ ok: boolean; reason?: string }> }).launchable() : { ok: true };
    if (!launchable.ok) throw new RpcError('agent_unavailable', launchable.reason ?? 'The agent cannot be started');

    const sandboxState = runtime.sandboxFor(input.permissionProfile, this.platform);
    if (input.permissionProfile === 'autonomous' && sandboxState !== 'sandboxed') {
      throw new RpcError('autonomous_requires_sandbox', 'Autonomous is only available when the session is sandboxed.');
    }
    const baseCommit = await revParse(workspace.rootPath, input.baseRef ?? 'HEAD').catch(() => {
      throw new RpcError('no_commit', 'The repository needs at least one commit before a session can start.');
    });

    const id = randomUUID();
    const title = input.title?.trim() || titleFrom(input.prompt);
    const slug = input.workItemRef ? `${slugify(input.workItemRef, 20)}-${slugify(title, 30)}` : `${slugify(title, 30)}-${id.slice(0, 6)}`;
    const liveCount = this.repos.sessions.inStates(['starting', 'working', 'waiting-on-user']).length;
    const state: SessionState = liveCount >= this.concurrencyCap() ? 'queued' : 'starting';
    const session: Session = {
      id,
      workspaceId: workspace.id,
      agentId: input.agentId,
      title,
      state,
      baseCommit,
      branch: `agent/${slug}`,
      worktreePath: join(this.paths.worktrees, `${slugify(workspace.name, 20)}-${workspace.id.slice(0, 6)}`, slug),
      permissionProfile: input.permissionProfile,
      sandboxState,
      agentSessionId: null,
      workItemRef: input.workItemRef ?? null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    };
    this.repos.sessions.insert(session);
    this.append(id, { type: 'session.state_changed', from: null, to: state, reason: state === 'queued' ? 'Waiting for a free slot' : null });
    this.repos.queue.push(id, input.prompt);
    this.bootOptions.set(id, { bringChanges: input.bringChanges ?? false, ...(input.modeId ? { modeId: input.modeId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.skills?.length ? { skills: input.skills } : {}) });
    this.audit(session, 'session.created', { agent: input.agentId, profile: input.permissionProfile, baseCommit, branch: session.branch });
    this.bus.emit('session.changed', { workspaceId: workspace.id, session });
    if (state === 'starting') void this.boot(id);
    return session;
  }

  private maybeDequeue() {
    if (this.disposed) return;
    const cap = this.concurrencyCap();
    let liveCount = this.repos.sessions.inStates(['starting', 'working', 'waiting-on-user']).length;
    for (const s of this.repos.sessions.inStates(['queued'])) {
      if (liveCount >= cap) break;
      if (this.fire(s.id, 'dequeue')) {
        liveCount++;
        void this.boot(s.id);
      }
    }
  }

  /** Worktree, setup script, optional "bring my changes", agent start, then the first prompt. */
  private async boot(sessionId: string): Promise<void> {
    if (this.booting.has(sessionId)) return;
    this.booting.add(sessionId);
    const opts = this.bootOptions.get(sessionId) ?? { bringChanges: false };
    this.bootOptions.delete(sessionId);
    try {
      const session = this.repos.sessions.require(sessionId);
      const workspace = this.repos.workspaces.get(session.workspaceId)!;
      await createWorktree({ repo: workspace.rootPath, baseCommit: session.baseCommit!, branch: session.branch!, path: session.worktreePath! });
      const setup = await this.runSetup(session, workspace.rootPath);
      if (!setup.ok) {
        this.fire(sessionId, 'crashed', `Setup failed: ${setup.message}`);
        this.notify(sessionId, 'Setup failed', session.title);
        return;
      }
      if (opts.bringChanges) {
        const res = await bringChanges(workspace.rootPath, session.worktreePath!);
        this.append(sessionId, { type: 'notice', level: 'info', text: `Brought ${res.files.length} changed file(s) from your checkout.` });
      }
      if (opts.skills?.length) {
        if (!this.installSkills) throw new Error('Skills are not available.');
        const copied = await this.installSkills(workspace.rootPath, session.worktreePath!, session.agentId, opts.skills);
        this.append(sessionId, { type: 'notice', level: 'info', text: `Loaded skills for this session: ${opts.skills.join(', ')}${copied.length < opts.skills.length ? ' (the repository already has some of them)' : ''}.` });
      }
      await this.startAgent(sessionId);
      if (opts.modeId) await this.setMode(sessionId, opts.modeId).catch(() => undefined);
      if (opts.modelId) {
        await this.live.get(sessionId)!.agent.setModel(opts.modelId);
        this.append(sessionId, { type: 'notice', level: 'info', text: `Using the model ${opts.modelId}.` });
      }
      await this.sendNext(sessionId);
    } catch (err) {
      const message = err instanceof AgentAuthRequiredError ? `${err.message} Open the agent's own terminal UI to sign in.` : (err as Error).message;
      this.append(sessionId, { type: 'notice', level: 'error', text: message });
      this.fire(sessionId, 'crashed', message.slice(0, 300));
      this.notify(sessionId, 'Session failed to start', message.slice(0, 200));
    } finally {
      this.booting.delete(sessionId);
    }
  }

  private async runSetup(session: Session, repoRoot: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const { config, error, exists } = await readWorkspaceConfig(repoRoot);
    if (error) {
      this.append(session.id, { type: 'notice', level: 'error', text: `.ade/workspace.yaml is invalid: ${error}` });
      return { ok: false, message: 'invalid .ade/workspace.yaml' };
    }
    if (!exists) return { ok: true };
    if (config.copy.length) {
      const copied = await copyFiles(repoRoot, session.worktreePath!, config.copy);
      this.append(session.id, { type: 'notice', level: 'info', text: `Copied ${copied.length} file(s) into the worktree.` });
    }
    for (const raw of config.setup) {
      const [cmd, ...args] = toArgv(raw);
      if (!cmd) continue;
      const started = Date.now();
      const res = await new Promise<{ code: number | null; output: string }>((done) => {
        execFile(cmd, args, { cwd: session.worktreePath!, timeout: config.setupTimeoutSeconds * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          done({ code, output: `${stdout}${stderr}`.slice(-4000) });
        });
      });
      const line = [cmd, ...args].join(' ');
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (res.code !== 0) {
        this.append(session.id, { type: 'notice', level: 'error', text: `Setup command failed (exit ${res.code}, ${seconds} s): ${line}\n${res.output}` });
        return { ok: false, message: line };
      }
      this.append(session.id, { type: 'notice', level: 'info', text: `Setup: ${line} (${seconds} s)` });
    }
    return { ok: true };
  }

  private async startAgent(sessionId: string, resume = false): Promise<LiveSession> {
    const session = this.repos.sessions.require(sessionId);
    const runtime = this.runtimes.get(session.agentId);
    if (!runtime) throw new Error(`Agent ${session.agentId} is not available`);
    const protocol: ProtocolMessage[] = [];
    const launch = (resumeSessionId: string | null) =>
      runtime.start({
        cwd: session.worktreePath!,
        permissionProfile: session.permissionProfile,
        mcpServers: this.mcpServersFor(session.workspaceId),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        baseEnv: { ...process.env, ADE_FAKE_STATE_DIR: this.paths.fakeAgentState },
        onProtocolMessage: (direction, body) => {
          protocol.push({ ts: new Date().toISOString(), direction, body });
          if (protocol.length > PROTOCOL_RING) protocol.splice(0, protocol.length - PROTOCOL_RING);
        },
      });
    let agent: AgentSession;
    let reloaded = false;
    if (resume && session.agentSessionId) {
      try {
        agent = await launch(session.agentSessionId);
        reloaded = agent.capabilities.loadSession;
      } catch {
        agent = await launch(null);
      }
    } else agent = await launch(null);
    const live: LiveSession = { agent, coalescer: new ChunkCoalescer(), turn: null, pending: new Map(), protocol, closing: false, turnTimer: null };
    this.live.set(sessionId, live);
    this.repos.sessions.update(sessionId, { agentSessionId: agent.agentSessionId });
    if (agent.modes.length && agent.currentModeId) this.append(sessionId, { type: 'mode.changed', modeId: agent.currentModeId, available: agent.modes });
    agent.onEvent((e) => this.onAgentEvent(sessionId, live, e));
    agent.onPermissionRequest((info, signal) => this.onPermissionRequest(sessionId, live, info, signal));
    void agent.exited.then((exit) => {
      if (this.live.get(sessionId) === live && !live.closing) this.onCrash(sessionId, live, exit.error ?? `The agent exited (code ${exit.code}).`);
    });
    if (resume) {
      this.append(sessionId, {
        type: 'notice',
        level: 'info',
        text: reloaded ? 'Reconnected to the agent session.' : 'The agent could not reload the conversation; it starts fresh in the same worktree.',
      });
    }
    return live;
  }

  private flush(sessionId: string, live: LiveSession) {
    for (const m of live.coalescer.flush()) {
      this.append(sessionId, m.kind === 'message' ? { type: 'agent.message', messageId: m.messageId, text: m.text } : { type: 'agent.thought', messageId: m.messageId, text: m.text }, live.turn?.id ?? null);
    }
  }

  private onAgentEvent(sessionId: string, live: LiveSession, e: AgentEvent) {
    if (e.type === 'agent.message.chunk' || e.type === 'agent.thought.chunk') {
      live.coalescer.push(e.type === 'agent.message.chunk' ? 'message' : 'thought', e.messageId, e.text);
      this.emitTransient(sessionId, e);
      return;
    }
    // Keep stored order equal to what the user saw: finish buffered text before the next item.
    this.flush(sessionId, live);
    this.append(sessionId, e, live.turn?.id ?? null);
  }

  private onPermissionRequest(sessionId: string, live: LiveSession, info: PermissionRequestInfo, signal: AbortSignal): Promise<PermissionDecision> {
    this.flush(sessionId, live);
    const session = this.repos.sessions.require(sessionId);
    this.repos.permissions.insert({ id: info.requestId, sessionId, turnId: live.turn?.id ?? null, toolCallId: info.toolCallId, title: info.title, options: info.options });
    this.append(sessionId, { type: 'permission.requested', requestId: info.requestId, toolCallId: info.toolCallId, title: info.title, kind: info.kind, detail: info.detail, options: info.options }, live.turn?.id ?? null);

    const auto = this.policy.autoAnswer(session.permissionProfile, info);
    if (auto) {
      this.recordDecision(sessionId, info.requestId, auto.decision, auto.decidedBy, null);
      this.audit(session, 'permission.decided', { requestId: info.requestId, title: info.title, decision: auto.decision }, auto.decidedBy);
      return Promise.resolve(auto.decision);
    }

    return new Promise<PermissionDecision>((resolve) => {
      live.pending.set(info.requestId, { info, resolve });
      signal.addEventListener('abort', () => this.decide(sessionId, info.requestId, { outcome: 'cancelled' }, 'system', null), { once: true });
      if (this.repos.sessions.require(sessionId).state === 'working') this.fire(sessionId, 'needs-user');
      else this.refreshInbox();
      this.notify(sessionId, info.kind === 'think' ? 'The agent has a question' : 'The agent needs your approval', info.title);
    });
  }

  private recordDecision(sessionId: string, requestId: string, decision: PermissionDecision, decidedBy: string, note: string | null) {
    this.repos.permissions.decide(requestId, decision, decidedBy);
    this.append(sessionId, { type: 'permission.decided', requestId, decision, decidedBy, note });
  }

  private decide(sessionId: string, requestId: string, decision: PermissionDecision, decidedBy: string, note: string | null): boolean {
    const live = this.live.get(sessionId);
    const pending = live?.pending.get(requestId);
    if (!live || !pending) return false;
    live.pending.delete(requestId);
    this.recordDecision(sessionId, requestId, decision, decidedBy, note);
    const session = this.repos.sessions.require(sessionId);
    this.audit(session, 'permission.decided', { requestId, title: pending.info.title, decision, note }, decidedBy);
    if (live.pending.size === 0 && session.state === 'waiting-on-user') this.fire(sessionId, 'user-answered');
    else this.refreshInbox();
    pending.resolve(decision);
    return true;
  }

  private onCrash(sessionId: string, live: LiveSession, error: string) {
    this.live.delete(sessionId);
    if (live.turnTimer) clearTimeout(live.turnTimer);
    for (const [requestId] of live.pending) this.recordDecision(sessionId, requestId, { outcome: 'cancelled' }, 'system', null);
    live.pending.clear();
    this.repos.turns.closeDangling(sessionId, 'crashed');
    this.append(sessionId, { type: 'notice', level: 'error', text: `The agent stopped unexpectedly: ${error.slice(0, 1000)}` });
    if (this.fire(sessionId, 'crashed', 'The agent stopped unexpectedly')) this.notify(sessionId, 'Session failed', this.repos.sessions.require(sessionId).title);
  }

  // ---------------------------------------------------------------- turns

  /** Sessions whose next turn is being set up; `live.turn` is only set after the start checkpoint. */
  private readonly sending = new Set<string>();

  private async sendNext(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live?.turn || this.sending.has(sessionId)) return;
    const session = this.repos.sessions.require(sessionId);
    if (!['starting', 'ready', 'interrupted'].includes(session.state)) return;
    const next = this.repos.queue.shift(sessionId);
    if (!next) return;
    this.sending.add(sessionId);
    let started = false;
    try {
      // runTurn runs the whole turn and may start the next one itself, so the flag is cleared as soon as this
      // turn is live, and only cleared here when it never started.
      await this.runTurn(sessionId, next.content, () => {
        started = true;
        this.sending.delete(sessionId);
      });
    } finally {
      if (!started) this.sending.delete(sessionId);
    }
  }

  private async runTurn(sessionId: string, content: PromptBlock[], onStarted?: () => void): Promise<void> {
    let session = this.repos.sessions.require(sessionId);
    const limits = this.limits();
    if (this.repos.turns.list(sessionId).length >= limits.maxTurns) {
      this.append(sessionId, { type: 'notice', level: 'warning', text: `This session reached its limit of ${limits.maxTurns} turns.` });
      return;
    }
    let live = this.live.get(sessionId);
    if (!live) live = await this.startAgent(sessionId, true);
    session = this.repos.sessions.require(sessionId);

    const index = this.repos.turns.list(sessionId).length;
    const startCommit = await snapshot(session.worktreePath!, checkpointRefName(sessionId, index, 'start'), `ADE turn ${index} start`).catch(() => null);
    const turn = this.repos.turns.start(sessionId, startCommit);
    live.turn = turn;
    onStarted?.();
    this.append(sessionId, { type: 'user.message', content, queued: false }, turn.id);
    this.append(sessionId, { type: 'turn.started', turnId: turn.id, index: turn.index }, turn.id);
    if (startCommit) this.append(sessionId, { type: 'checkpoint.created', turnId: turn.id, ref: startCommit, at: 'start' }, turn.id);
    if (session.state === 'interrupted') this.fire(sessionId, 'prompt', 'Reopened');
    else this.fire(sessionId, 'prompt');

    live.turnTimer = setTimeout(() => {
      this.append(sessionId, { type: 'notice', level: 'warning', text: `The turn hit the ${limits.maxTurnMinutes} minute limit and was cancelled.` });
      void this.cancel(sessionId);
    }, limits.maxTurnMinutes * 60_000);

    let stopReason: string;
    try {
      stopReason = await live.agent.prompt(content);
    } catch (err) {
      stopReason = 'error';
      this.flush(sessionId, live);
      this.append(sessionId, { type: 'notice', level: 'error', text: (err as Error).message.slice(0, 2000) }, turn.id);
    }
    if (live.turnTimer) clearTimeout(live.turnTimer);
    live.turnTimer = null;
    if (this.live.get(sessionId) !== live) return; // crashed meanwhile; onCrash handled it

    this.flush(sessionId, live);
    for (const [requestId] of live.pending) this.decide(sessionId, requestId, { outcome: 'cancelled' }, 'system', null);
    const endCommit = await snapshot(session.worktreePath!, checkpointRefName(sessionId, index, 'end'), `ADE turn ${index} end`).catch(() => null);
    this.repos.turns.end(turn.id, stopReason, endCommit);
    if (endCommit) this.append(sessionId, { type: 'checkpoint.created', turnId: turn.id, ref: endCommit, at: 'end' }, turn.id);
    this.append(sessionId, { type: 'turn.ended', turnId: turn.id, stopReason, usage: live.agent.usage }, turn.id);
    live.turn = null;
    const state = this.repos.sessions.require(sessionId).state;
    if (state === 'waiting-on-user') this.fire(sessionId, 'user-answered');
    this.fire(sessionId, 'turn-ended');

    const queued = this.repos.queue.list(sessionId).length;
    if (queued === 0) {
      if (stopReason === 'error') this.notify(sessionId, 'Turn failed', session.title);
      else if (stopReason !== 'cancelled') this.notify(sessionId, 'Session finished a turn', session.title);
    }
    await this.sendNext(sessionId);
  }

  // ---------------------------------------------------------------- user actions

  /** SR-01 / SR-02: send now when idle, otherwise store as a queued message. */
  async prompt(sessionId: string, content: PromptBlock[]): Promise<{ id: string; queued: boolean }> {
    const session = this.repos.sessions.require(sessionId);
    if (isTerminal(session.state)) throw new RpcError('session_ended', 'This session has ended.');
    const id = this.repos.queue.push(sessionId, content);
    const busy = this.hasActiveTurn(sessionId) || ['queued', 'starting', 'working', 'waiting-on-user'].includes(session.state);
    if (!busy) void this.sendNext(sessionId).catch((err: Error) => this.append(sessionId, { type: 'notice', level: 'error', text: err.message }));
    else this.bus.emit('session.changed', { workspaceId: session.workspaceId, session });
    return { id, queued: busy };
  }

  queued(sessionId: string) {
    return this.repos.queue.list(sessionId);
  }

  editQueued(sessionId: string, id: string, content: PromptBlock[]) {
    if (!this.repos.queue.edit(sessionId, id, content)) throw new RpcError('not_found', 'That message was already sent.');
    const session = this.repos.sessions.require(sessionId);
    this.bus.emit('session.changed', { workspaceId: session.workspaceId, session });
  }

  unqueue(sessionId: string, id: string) {
    if (!this.repos.queue.remove(sessionId, id)) throw new RpcError('not_found', 'That message was already sent.');
    const session = this.repos.sessions.require(sessionId);
    this.bus.emit('session.changed', { workspaceId: session.workspaceId, session });
  }

  /** Cancels the running turn. The agent answers with `cancelled`, pending requests are cancelled, a checkpoint is taken. */
  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live?.turn) return;
    await live.agent.cancel();
  }

  /** SR-03: cancel the turn and send `content` as soon as it has ended. */
  async interrupt(sessionId: string, content: PromptBlock[]): Promise<void> {
    this.repos.queue.push(sessionId, content, true);
    if (this.hasActiveTurn(sessionId)) await this.cancel(sessionId);
    else await this.sendNext(sessionId);
  }

  answerPermission(sessionId: string, requestId: string, optionId: string | null, note?: string): void {
    const decision: PermissionDecision = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    if (note?.trim()) this.repos.queue.push(sessionId, [{ type: 'text', text: note.trim() }]);
    if (!this.decide(sessionId, requestId, decision, 'user', note?.trim() || null)) {
      throw new RpcError('not_pending', 'That request is no longer waiting for an answer.');
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) throw new RpcError('not_live', 'The agent is not running.');
    if (!live.agent.modes.some((m) => m.id === modeId)) throw new RpcError('unknown_mode', 'The agent does not offer that mode.');
    await live.agent.setMode(modeId);
    this.append(sessionId, { type: 'mode.changed', modeId, available: null });
  }

  /** Stops the agent process tree (used before landing or discarding, and on shutdown). */
  async stopAgent(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.closing = true;
    if (live.turnTimer) clearTimeout(live.turnTimer);
    this.live.delete(sessionId);
    await live.agent.close();
  }

  /** Moves a session to a terminal state after a land or discard. */
  async finish(sessionId: string, trigger: 'land' | 'discard'): Promise<void> {
    await this.stopAgent(sessionId);
    const session = this.repos.sessions.require(sessionId);
    if (session.state === 'interrupted') this.fire(sessionId, 'reopen', 'Reopened at the last checkpoint');
    if (!this.fire(sessionId, trigger)) throw new RpcError('invalid_state', `A ${session.state} session cannot be ${trigger === 'land' ? 'landed' : 'discarded'}.`);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.live.keys()].map((id) => this.stopAgent(id)));
  }
}

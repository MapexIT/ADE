import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentEvent, AgentRuntime, AgentSession, LaunchWrapper, PermissionRequestInfo, McpServerSpec } from '@ade/acp-client';
import { AgentAuthRequiredError } from '@ade/acp-client';
import {
  AGENT_LABELS,
  RpcError,
  type AgentId,
  type Containment,
  type ContainmentStatus,
  type PermissionRule,
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
import { bringChanges, changedFiles, copyFiles, createWorktree, currentBranch, diffPatch, revParse, slugify, snapshot } from '@ade/git';
import { ChunkCoalescer, isLive, isTerminal, nextState, type SessionTrigger } from '@ade/session-core';
import type { EventBus } from './bus.ts';
import { profilePolicy, type PermissionPolicy } from './permission-policy.ts';
import type { Repositories } from './repositories.ts';
import { readWorkspaceConfig, toArgv } from './workspace-config.ts';
import { ruleAnswer, rulesKey } from './workspace-rules.ts';

/** CN-07: the host sandbox as the session service needs it (implemented by `ContainmentService`). */
export interface SandboxProvider {
  /** False when new sessions never use the sandbox unless asked (Windows), so no probe is needed. */
  readonly mayDefaultOn: boolean;
  status(): Promise<ContainmentStatus>;
  wrapperFor(session: Session, repoRoot: string, extraWritable?: string[]): Promise<LaunchWrapper | null>;
  release(sessionId: string): Promise<void>;
}

/** CN-08: the setting that allows one session at a time to work in the user's checkout. Off by default. */
export const RUN_IN_PLACE_SETTING = 'sessions.runInPlace';
export const snapshotRefName = (sessionId: string) => `refs/ade/snapshots/${sessionId}`;

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
  mcpServersFor: (workspaceId: string, sessionId: string) => McpServerSpec[] | Promise<McpServerSpec[]> = () => [];
  /** CN-07: set by the composition root when the host sandbox is wired. */
  sandbox: SandboxProvider | null = null;

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

  /** AP-06: the workspace's allow and deny rules. */
  rules(workspaceId: string): PermissionRule[] {
    return this.repos.settings.get<PermissionRule[]>(rulesKey(workspaceId), []);
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

  async create(input: CreateSessionInput, extra: { compareGroup?: string } = {}): Promise<Session> {
    const workspace = this.repos.workspaces.get(input.workspaceId);
    if (!workspace) throw new RpcError('not_found', 'Unknown workspace');
    const runtime = this.runtimes.get(input.agentId);
    if (!runtime) throw new RpcError('agent_unavailable', `Agent ${input.agentId} is not available`);
    const launchable = 'launchable' in runtime ? await (runtime as { launchable(): Promise<{ ok: boolean; reason?: string }> }).launchable() : { ok: true };
    if (!launchable.ok) throw new RpcError('agent_unavailable', launchable.reason ?? 'The agent cannot be started');

    const containment = await this.containmentFor(input.agentId, input.hostSandbox);
    const sandboxState = containment !== 'none' ? 'sandboxed' : runtime.sandboxFor(input.permissionProfile, this.platform);
    if (input.permissionProfile === 'autonomous' && sandboxState !== 'sandboxed') {
      throw new RpcError('autonomous_requires_sandbox', 'Autonomous is only available when the session is sandboxed.');
    }
    const inPlace = input.inPlace ?? false;
    if (inPlace) this.checkInPlace(workspace.id, input);
    let baseCommit = await revParse(workspace.rootPath, input.baseRef ?? 'HEAD').catch(() => {
      throw new RpcError('no_commit', 'The repository needs at least one commit before a session can start.');
    });

    const id = randomUUID();
    const title = input.title?.trim() || titleFrom(input.prompt);
    const slug = input.workItemRef ? `${slugify(input.workItemRef, 20)}-${slugify(title, 30)}` : `${slugify(title, 30)}-${id.slice(0, 6)}`;
    let branch: string | null = `agent/${slug}`;
    let worktreePath = join(this.paths.worktrees, `${slugify(workspace.name, 20)}-${workspace.id.slice(0, 6)}`, slug);
    if (inPlace) {
      // CN-08: the snapshot (tracked and untracked files, without touching the user's index) is the base that
      // review diffs against and that "Discard" restores.
      baseCommit = await snapshot(workspace.rootPath, snapshotRefName(id), 'ADE snapshot before a session worked in place', true);
      branch = await currentBranch(workspace.rootPath);
      worktreePath = workspace.rootPath;
    }
    const liveCount = this.repos.sessions.inStates(['starting', 'working', 'waiting-on-user']).length;
    const state: SessionState = liveCount >= this.concurrencyCap() ? 'queued' : 'starting';
    const session: Session = {
      id,
      workspaceId: workspace.id,
      agentId: input.agentId,
      title,
      state,
      baseCommit,
      branch,
      worktreePath,
      permissionProfile: input.permissionProfile,
      sandboxState,
      containment,
      inPlace,
      compareGroup: extra.compareGroup ?? null,
      agentSessionId: null,
      workItemRef: input.workItemRef ?? null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    };
    this.repos.sessions.insert(session);
    this.append(id, { type: 'session.state_changed', from: null, to: state, reason: state === 'queued' ? 'Waiting for a free slot' : null });
    this.repos.queue.push(id, input.prompt);
    this.bootOptions.set(id, { bringChanges: input.bringChanges ?? false, ...(input.modeId ? { modeId: input.modeId } : {}), ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.skills?.length ? { skills: input.skills } : {}) });
    this.audit(session, 'session.created', { agent: input.agentId, profile: input.permissionProfile, baseCommit, branch: session.branch, containment, inPlace });
    this.bus.emit('session.changed', { workspaceId: workspace.id, session });
    if (state === 'starting') void this.boot(id);
    return session;
  }

  /** CN-07: which sandbox the new session runs in. Left out, the platform default applies. */
  private async containmentFor(agentId: AgentId, requested: boolean | undefined): Promise<Containment> {
    if (requested === false || (requested === undefined && !this.sandbox?.mayDefaultOn)) return 'none';
    const status = this.sandbox ? await this.sandbox.status() : null;
    const wanted = requested ?? status?.defaultOn ?? false;
    if (!wanted) return 'none';
    if (!status?.available || status.kind === 'none') {
      throw new RpcError('sandbox_unavailable', status?.reason ?? 'The host sandbox is not available on this machine.');
    }
    if (!status.agents.includes(agentId)) {
      throw new RpcError(
        'sandbox_unavailable',
        status.kind === 'wsl'
          ? `${AGENT_LABELS[agentId]} is not installed inside ${status.distro}. Install its ACP adapter there first.`
          : `${AGENT_LABELS[agentId]} cannot run inside the sandbox.`,
      );
    }
    return status.kind;
  }

  /** CN-08: opt-in, one session at a time per checkout, and nothing that needs a separate worktree. */
  private checkInPlace(workspaceId: string, input: CreateSessionInput) {
    if (!this.repos.settings.get<boolean>(RUN_IN_PLACE_SETTING, false)) {
      throw new RpcError('in_place_off', 'Working in your checkout is off. Turn it on in Settings first.');
    }
    if (input.bringChanges || input.skills?.length || input.baseRef) {
      throw new RpcError('in_place_conflict', 'A session in your checkout cannot bring changes, load skills or start from another commit.');
    }
    const busy = this.repos.sessions.list(workspaceId).find((s) => s.inPlace && !isTerminal(s.state));
    if (busy) throw new RpcError('in_place_busy', `"${busy.title}" is already working in your checkout. Land or discard it first.`);
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
      if (session.inPlace) {
        this.append(sessionId, { type: 'notice', level: 'warning', text: 'This session works in your checkout. Discard puts every file back to the snapshot taken when it started.' });
        await this.startAgent(sessionId);
        await this.sendNext(sessionId);
        return;
      }
      await createWorktree({
        repo: workspace.rootPath,
        baseCommit: session.baseCommit!,
        branch: session.branch!,
        path: session.worktreePath!,
        relativePaths: session.containment === 'wsl',
      });
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
    const workspace = this.repos.workspaces.get(session.workspaceId)!;
    let wrapper: LaunchWrapper | null = null;
    if (session.containment !== 'none') {
      if (!this.sandbox) throw new Error('The host sandbox is not available; the session will not start without it.');
      wrapper = await this.sandbox.wrapperFor(session, workspace.rootPath, [this.paths.fakeAgentState]);
    }
    const mcpServers = await this.mcpServersFor(session.workspaceId, sessionId);
    const launch = (resumeSessionId: string | null) =>
      runtime.start({
        ...(wrapper ? { wrapper } : {}),
        cwd: session.worktreePath!,
        permissionProfile: session.permissionProfile,
        mcpServers,
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

    // AP-06: workspace rules answer first; then the permission profile. Every automatic answer is logged.
    const byRule = ruleAnswer(this.rules(session.workspaceId), info);
    const auto = byRule ?? this.policy.autoAnswer(session.permissionProfile, info);
    if (auto) {
      this.recordDecision(sessionId, info.requestId, auto.decision, auto.decidedBy, byRule ? `Workspace rule: ${byRule.rule.decision} "${byRule.rule.pattern}"` : null);
      this.audit(
        session,
        'permission.decided',
        { requestId: info.requestId, title: info.title, decision: auto.decision, ...(byRule ? { rule: byRule.rule } : {}) },
        auto.decidedBy,
      );
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
    // In-place sessions take raw snapshots so the user's line endings survive undo and discard (CN-08).
    const startCommit = await snapshot(session.worktreePath!, checkpointRefName(sessionId, index, 'start'), `ADE turn ${index} start`, session.inPlace).catch(() => null);
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
    const endCommit = await snapshot(session.worktreePath!, checkpointRefName(sessionId, index, 'end'), `ADE turn ${index} end`, session.inPlace).catch(() => null);
    this.repos.turns.end(turn.id, stopReason, endCommit);
    if (endCommit) this.inBackground(this.checkOverlap(sessionId, endCommit));
    if (stopReason !== 'cancelled' && stopReason !== 'error' && this.afterTurn && this.repos.queue.list(sessionId).length === 0) {
      this.inBackground(this.afterTurn(sessionId));
    }
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

  // ---------------------------------------------------------------- parallel work (M7-T02)

  /** PL-03: one prompt to two or three agents, each in its own worktree, grouped for side-by-side review. */
  async compare(input: Omit<CreateSessionInput, 'agentId'> & { agentIds: AgentId[] }): Promise<Session[]> {
    const ids = [...new Set(input.agentIds)];
    if (ids.length < 2) throw new RpcError('invalid', 'Choose two or three different agents to compare.');
    const compareGroup = randomUUID();
    const title = input.title?.trim() || titleFrom(input.prompt);
    const { agentIds: _ignored, ...rest } = input;
    const created: Session[] = [];
    for (const agentId of ids) {
      created.push(await this.create({ ...rest, agentId, inPlace: false, title: `${title} (${AGENT_LABELS[agentId]})` }, { compareGroup }));
    }
    return created;
  }

  /** Work started after a turn that nobody awaits; shutdown waits for it so no Git process outlives the host. */
  private readonly pending = new Set<Promise<unknown>>();

  private inBackground(work: Promise<unknown>) {
    const p = work.catch(() => undefined).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** PL-04: changed paths per session at its last checkpoint, and the overlaps already reported. */
  private readonly touched = new Map<string, Set<string>>();
  private readonly flaggedOverlaps = new Set<string>();

  /** PL-04: after each turn, flag files this session and another live session in the same workspace both changed. */
  private async checkOverlap(sessionId: string, checkpoint: string): Promise<void> {
    if (this.disposed) return;
    const session = this.repos.sessions.require(sessionId);
    if (!session.baseCommit || !session.worktreePath) return;
    const files = new Set((await changedFiles(session.worktreePath, session.baseCommit, checkpoint)).map((c) => c.path));
    this.touched.set(sessionId, files);
    for (const other of this.repos.sessions.list(session.workspaceId)) {
      if (other.id === sessionId || isTerminal(other.state)) continue;
      const theirs = this.touched.get(other.id);
      if (!theirs) continue;
      const pair = [sessionId, other.id].sort().join(':');
      const fresh = [...files].filter((f) => theirs.has(f) && !this.flaggedOverlaps.has(`${pair}:${f}`));
      if (!fresh.length) continue;
      for (const f of fresh) this.flaggedOverlaps.add(`${pair}:${f}`);
      const list = fresh.slice(0, 10).join(', ') + (fresh.length > 10 ? ` and ${fresh.length - 10} more` : '');
      this.append(sessionId, { type: 'notice', level: 'warning', text: `Overlap: "${other.title}" also changed ${list}. Landing both may conflict.` });
      this.append(other.id, { type: 'notice', level: 'warning', text: `Overlap: "${session.title}" also changed ${list}. Landing both may conflict.` });
      this.notify(sessionId, 'Two sessions changed the same files', `${session.title} and ${other.title}: ${list}`);
    }
  }

  /** PL-04: current overlaps in a workspace, for the sessions list. */
  overlaps(workspaceId: string): { sessionId: string; otherSessionId: string; files: string[] }[] {
    const live = this.repos.sessions.list(workspaceId).filter((s) => !isTerminal(s.state) && this.touched.has(s.id));
    const out: { sessionId: string; otherSessionId: string; files: string[] }[] = [];
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const a = this.touched.get(live[i]!.id)!;
        const files = [...this.touched.get(live[j]!.id)!].filter((f) => a.has(f));
        if (files.length) out.push({ sessionId: live[i]!.id, otherSessionId: live[j]!.id, files });
      }
    return out;
  }

  /**
   * SR-07: the same worktree and branch continue with another agent. The new agent gets the previous agent's
   * last message and the diff so far; the timeline keeps both agents' history.
   */
  async handOff(sessionId: string, agentId: AgentId, note?: string): Promise<Session> {
    const session = this.repos.sessions.require(sessionId);
    if (isTerminal(session.state)) throw new RpcError('session_ended', 'This session has ended.');
    if (this.hasActiveTurn(sessionId) || this.booting.has(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish or cancel it first.');
    if (agentId === session.agentId) throw new RpcError('invalid', 'Choose a different agent.');
    const runtime = this.runtimes.get(agentId);
    if (!runtime) throw new RpcError('agent_unavailable', `Agent ${agentId} is not available`);
    if (session.containment !== 'none') {
      const status = await this.sandbox?.status();
      if (!status?.agents.includes(agentId)) throw new RpcError('sandbox_unavailable', `${AGENT_LABELS[agentId]} cannot run in this session's sandbox.`);
    }
    const lastMessage = this.repos.events.list(sessionId).flatMap((e) => (e.type === 'agent.message' ? [e.text] : [])).at(-1) ?? '';
    let diff = '';
    if (session.worktreePath && session.baseCommit) {
      const now = await snapshot(session.worktreePath, null, 'ADE hand-off', session.inPlace);
      diff = (await diffPatch(session.worktreePath, session.baseCommit, now)).toString('utf8');
    }
    const from = session.agentId;
    await this.stopAgent(sessionId);
    const updated = this.repos.sessions.update(sessionId, { agentId, agentSessionId: null });
    this.append(sessionId, { type: 'notice', level: 'info', text: `Handed off from ${AGENT_LABELS[from]} to ${AGENT_LABELS[agentId]}.` });
    this.audit(updated, 'session.handed_off', { from, to: agentId });
    this.bus.emit('session.changed', { workspaceId: updated.workspaceId, session: updated });
    const prompt = [
      `You are continuing work that ${AGENT_LABELS[from]} started in this worktree. Do not redo what is already done.`,
      note?.trim() ? `The user says: ${note.trim()}` : '',
      lastMessage ? `${AGENT_LABELS[from]}'s last message:\n${lastMessage.slice(-8000)}` : '',
      diff ? `Changes so far (diff against the base commit):\n${diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n[diff truncated]` : diff}` : 'No files have changed yet.',
    ]
      .filter(Boolean)
      .join('\n\n');
    this.repos.queue.push(sessionId, [{ type: 'text', text: prompt }]);
    try {
      await this.startAgent(sessionId);
    } catch (err) {
      this.append(sessionId, { type: 'notice', level: 'error', text: (err as Error).message });
      this.fire(sessionId, 'crashed', 'The new agent could not start');
      return this.repos.sessions.require(sessionId);
    }
    void this.sendNext(sessionId);
    return this.repos.sessions.require(sessionId);
  }

  /** RV-10: runs after every finished turn when nothing else is queued (the workspace's checks). Set by the composition root. */
  afterTurn: ((sessionId: string) => Promise<void>) | null = null;

  /**
   * Sends one prompt and returns the agent's reply once the turn ends (RV-13). The exchange stays in the
   * timeline like any other turn.
   */
  async ask(sessionId: string, text: string, timeoutMs = 10 * 60_000): Promise<string> {
    const session = this.repos.sessions.require(sessionId);
    if (isTerminal(session.state)) throw new RpcError('session_ended', 'This session has ended.');
    if (this.hasActiveTurn(sessionId) || this.repos.queue.list(sessionId).length || ['starting', 'working', 'waiting-on-user', 'queued'].includes(session.state)) {
      throw new RpcError('busy', 'Wait for the agent to finish first.');
    }
    const from = this.repos.events.lastSeq(sessionId);
    const ended = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new RpcError('timeout', 'The agent did not answer in time.'));
      }, timeoutMs);
      const off = this.bus.on('session.event', (e) => {
        if (e.sessionId !== sessionId || e.seq <= from) return;
        const crashed = e.type === 'session.state_changed' && (e.to === 'interrupted' || isTerminal(e.to));
        if (e.type === 'turn.ended' || crashed) {
          clearTimeout(timer);
          off();
          if (crashed) reject(new RpcError('agent_failed', 'The agent stopped before answering.'));
          else resolve();
        }
      });
    });
    await this.prompt(sessionId, [{ type: 'text', text }]);
    await ended;
    const reply = this.repos.events.list(sessionId).filter((e) => e.seq > from && e.type === 'agent.message').at(-1);
    return reply?.type === 'agent.message' ? reply.text : '';
  }

  /** SR-08: stops ADE's agent process so the agent's own terminal UI can resume the same conversation. */
  async detach(sessionId: string): Promise<{ agentSessionId: string | null }> {
    const session = this.repos.sessions.require(sessionId);
    if (this.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish or cancel it first.');
    if (this.live.has(sessionId)) {
      await this.stopAgent(sessionId);
      this.append(sessionId, { type: 'notice', level: 'info', text: "Stopped ADE's connection so the agent's own terminal UI can continue. Sending a message here reconnects." });
    }
    return { agentSessionId: session.agentSessionId };
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
    await this.sandbox?.release(sessionId).catch(() => undefined);
    const session = this.repos.sessions.require(sessionId);
    if (session.state === 'interrupted') this.fire(sessionId, 'reopen', 'Reopened at the last checkpoint');
    if (!this.fire(sessionId, trigger)) throw new RpcError('invalid_state', `A ${session.state} session cannot be ${trigger === 'land' ? 'landed' : 'discarded'}.`);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.live.keys()].map((id) => this.stopAgent(id)));
    await Promise.all([...this.pending]);
  }
}

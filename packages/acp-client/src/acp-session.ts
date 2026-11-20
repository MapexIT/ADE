import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { AgentCapabilities, PermissionDecision, PromptBlock, SessionMode } from '@ade/contracts';
import {
  client as acpClient,
  ndJsonStream,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type InitializeResponse,
  type McpServer,
  type SessionConfigOption,
  type SessionModeState,
  type Stream,
} from '@agentclientprotocol/sdk';
import { redactSecrets } from './env.ts';
import { mapSessionUpdate, readUsage, toAcpContent, toToolKind, type UsageSnapshot } from './mapping.ts';
import { killTree, spawnCommand, type Command } from './process.ts';
import type { AgentEvent, AgentSession, McpServerSpec, PermissionHandler, StartOptions, StopReason } from './types.ts';

export const ADE_CLIENT_INFO = { name: 'ade', title: 'ADE', version: '0.1.0' };

/** Thrown when the agent refuses to start a session because the user is not signed in. */
export class AgentAuthRequiredError extends Error {
  constructor(message = 'The agent needs you to sign in through its own flow.') {
    super(message);
    this.name = 'AgentAuthRequiredError';
  }
}

function tap(stream: Stream, log: ((direction: 'in' | 'out', body: string) => void) | undefined): Stream {
  if (!log) return stream;
  const incoming = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      log('in', redactSecrets(JSON.stringify(msg)));
      controller.enqueue(msg);
    },
  });
  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      log('out', redactSecrets(JSON.stringify(msg)));
      controller.enqueue(msg);
    },
  });
  void outgoing.readable.pipeTo(stream.writable).catch(() => undefined);
  return { readable: stream.readable.pipeThrough(incoming), writable: outgoing.writable };
}

interface LocalTerminal {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
}

const toMcp = (s: McpServerSpec): McpServer =>
  'url' in s
    ? { type: 'http', name: s.name, url: s.url, headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })) }
    : { name: s.name, command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) };

/**
 * Adapter from the official ACP SDK to ADE's `AgentSession`. One instance owns one agent process.
 * ADE advertises `fs` and `terminal`; when the agent uses them, the operation runs inside the worktree
 * and any path outside it is refused.
 */
export class AcpAgentSession implements AgentSession {
  capabilities!: AgentCapabilities;
  agentSessionId = '';
  modes: SessionMode[] = [];
  currentModeId: string | null = null;
  readonly exited: Promise<{ code: number | null; error: string | null }>;

  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private permissionHandler: PermissionHandler | null = null;
  private readonly pendingPermissions = new Map<string, AbortController>();
  private readonly terminals = new Map<string, LocalTerminal>();
  private connection!: ClientConnection;
  private messageCounter = 0;
  private lastUsage: UsageSnapshot | null = null;
  private closed = false;
  private stderr = '';

  private readonly child: ChildProcess;
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly opts: StartOptions;

  private constructor(child: ChildProcess, cwd: string, env: Record<string, string>, opts: StartOptions) {
    this.child = child;
    this.cwd = cwd;
    this.env = env;
    this.opts = opts;
    this.exited = new Promise((done) => {
      child.once('error', (err) => done({ code: null, error: err.message }));
      child.once('exit', (code) => {
        const crashed = !this.closed && code !== 0;
        done({ code, error: crashed ? this.stderr.slice(-2000) || `Agent exited with code ${code}` : null });
      });
    });
    child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get usage(): UsageSnapshot | null {
    return this.lastUsage;
  }

  /** Spawns the agent, runs `initialize`, then `session/new` (or `session/load` when resuming). */
  static async start(cmd: Command, env: Record<string, string>, opts: StartOptions): Promise<AcpAgentSession> {
    const child = spawnCommand(cmd, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = new AcpAgentSession(child, opts.cwd, env, opts);
    try {
      await session.connect();
      return session;
    } catch (err) {
      await session.close();
      throw err;
    }
  }

  private emit(event: AgentEvent) {
    for (const l of this.listeners) l(event);
  }

  private nextMessageId() {
    return `m${++this.messageCounter}`;
  }

  private inside(path: string): string {
    const full = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
    const rel = relative(this.cwd, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new RequestError(-32602, `Refused: ${path} is outside the session worktree`);
    return full;
  }

  private async connect() {
    const stream = tap(
      ndJsonStream(
        Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
      ),
      this.opts.onProtocolMessage,
    );
    let currentMessage = this.nextMessageId();

    const app = acpClient({ name: 'ade' })
      .onNotification('session/update', ({ params }) => {
        const update = params.update;
        if (update.sessionUpdate === 'tool_call') currentMessage = this.nextMessageId();
        const usage = readUsage(update);
        if (usage) this.lastUsage = usage;
        if (update.sessionUpdate === 'current_mode_update') this.currentModeId = update.currentModeId;
        for (const e of mapSessionUpdate(update, currentMessage)) this.emit(e);
        if (update.sessionUpdate === 'tool_call') currentMessage = this.nextMessageId();
      })
      .onRequest('session/request_permission', async ({ params, signal }) => {
        const requestId = randomUUID();
        const controller = new AbortController();
        signal.addEventListener('abort', () => controller.abort());
        this.pendingPermissions.set(requestId, controller);
        try {
          const raw = params.toolCall.rawInput as { command?: unknown } | undefined;
          const detail = raw && typeof raw.command === 'string' ? raw.command : Array.isArray(raw?.command) ? raw.command.join(' ') : null;
          const handler = this.permissionHandler;
          const decision: PermissionDecision = handler
            ? await handler(
                {
                  requestId,
                  toolCallId: params.toolCall.toolCallId,
                  title: params.toolCall.title ?? 'Permission requested',
                  kind: params.toolCall.kind ? toToolKind(params.toolCall.kind) : null,
                  detail,
                  options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
                },
                controller.signal,
              )
            : { outcome: 'cancelled' };
          return { outcome: decision };
        } finally {
          this.pendingPermissions.delete(requestId);
        }
      })
      .onRequest('fs/read_text_file', async ({ params }) => {
        const text = await readFile(this.inside(params.path), 'utf8');
        if (params.line == null && params.limit == null) return { content: text };
        const lines = text.split('\n');
        const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: lines.slice(start, params.limit != null ? start + params.limit : undefined).join('\n') };
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        const full = this.inside(params.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, params.content);
        return {};
      })
      .onRequest('terminal/create', async ({ params }) => {
        const cwd = params.cwd ? this.inside(params.cwd) : this.cwd;
        const env = { ...this.env, ...Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])) };
        const child = spawnCommand({ command: params.command, args: params.args ?? [] }, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const id = randomUUID();
        const limit = (params as { outputByteLimit?: number | null }).outputByteLimit ?? 1_000_000;
        const term: LocalTerminal = {
          child,
          output: '',
          truncated: false,
          limit,
          exitStatus: null,
          exit: new Promise((done) => {
            child.once('error', () => done({ exitCode: null, signal: null }));
            child.once('exit', (code, sig) => done({ exitCode: code, signal: sig }));
          }),
        };
        void term.exit.then((s) => (term.exitStatus = s));
        const onData = (d: Buffer) => {
          const chunk = d.toString();
          term.output += chunk;
          if (term.output.length > term.limit) {
            term.output = term.output.slice(term.output.length - term.limit);
            term.truncated = true;
          }
          this.opts.onTerminalOutput?.(id, chunk);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        this.terminals.set(id, term);
        return { terminalId: id };
      })
      .onRequest('terminal/output', ({ params }) => {
        const t = this.terminals.get(params.terminalId);
        if (!t) throw new RequestError(-32602, 'Unknown terminal');
        return { output: t.output, truncated: t.truncated, exitStatus: t.exitStatus };
      })
      .onRequest('terminal/wait_for_exit', async ({ params }) => {
        const t = this.terminals.get(params.terminalId);
        if (!t) throw new RequestError(-32602, 'Unknown terminal');
        return await t.exit;
      })
      .onRequest('terminal/kill', async ({ params }) => {
        const t = this.terminals.get(params.terminalId);
        if (t?.child.pid) await killTree(t.child.pid);
        return {};
      })
      .onRequest('terminal/release', async ({ params }) => {
        const t = this.terminals.get(params.terminalId);
        if (t && t.exitStatus === null && t.child.pid) await killTree(t.child.pid);
        this.terminals.delete(params.terminalId);
        return {};
      });

    this.connection = app.connect(stream);
    const agent = this.connection.agent;

    const init: InitializeResponse = await agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: ADE_CLIENT_INFO,
    });
    const caps = init.agentCapabilities ?? {};
    this.capabilities = {
      protocolVersion: init.protocolVersion,
      loadSession: caps.loadSession ?? false,
      promptImage: caps.promptCapabilities?.image ?? false,
      promptEmbeddedContext: caps.promptCapabilities?.embeddedContext ?? false,
      mcpHttp: caps.mcpCapabilities?.http ?? false,
      authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
      ...(init.agentInfo?.name ? { agentName: init.agentInfo.name } : {}),
      ...(init.agentInfo?.version ? { agentVersion: init.agentInfo.version } : {}),
    };

    // HTTP servers are passed only to agents that advertise HTTP MCP support (ACP session setup).
    const mcpServers = (this.opts.mcpServers ?? []).filter((s) => !('url' in s) || this.capabilities.mcpHttp).map(toMcp);
    let modes: SessionModeState | null | undefined;
    let configOptions: SessionConfigOption[] | null | undefined;
    try {
      if (this.opts.resumeSessionId && this.capabilities.loadSession) {
        const res = await agent.request('session/load', { sessionId: this.opts.resumeSessionId, cwd: this.cwd, mcpServers });
        this.agentSessionId = this.opts.resumeSessionId;
        modes = res?.modes;
        configOptions = res?.configOptions;
      } else {
        const res = await agent.request('session/new', { cwd: this.cwd, mcpServers });
        this.agentSessionId = res.sessionId;
        modes = res.modes;
        configOptions = res.configOptions;
      }
    } catch (err) {
      // ACP reserves -32000 for "authentication required".
      if (err instanceof RequestError && err.code === -32000) throw new AgentAuthRequiredError(err.message);
      throw err;
    }
    this.readModels(configOptions);
    if (modes) {
      this.modes = modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null }));
      this.currentModeId = modes.currentModeId;
      this.emit({ type: 'mode.changed', modeId: modes.currentModeId, available: this.modes });
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPermissionRequest(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  async prompt(content: PromptBlock[]): Promise<StopReason> {
    const res = await this.connection.agent.request('session/prompt', {
      sessionId: this.agentSessionId,
      prompt: toAcpContent(content, this.capabilities.promptEmbeddedContext),
    });
    return res.stopReason;
  }

  /** Sends `session/cancel` and answers every pending permission request as cancelled (ACP requirement). */
  async cancel(): Promise<void> {
    for (const c of this.pendingPermissions.values()) c.abort();
    await this.connection.agent.notify('session/cancel', { sessionId: this.agentSessionId });
  }

  async setMode(modeId: string): Promise<void> {
    await this.connection.agent.request('session/set_mode', { sessionId: this.agentSessionId, modeId });
    this.currentModeId = modeId;
  }

  private modelOptionId: string | null = null;
  models: { id: string; name: string }[] = [];
  currentModelId: string | null = null;

  private readModels(options: SessionConfigOption[] | null | undefined) {
    const opt = options?.find((o) => o.category === 'model' && o.type === 'select');
    if (!opt || opt.type !== 'select') return;
    this.modelOptionId = opt.id;
    this.currentModelId = String(opt.currentValue);
    this.models = opt.options.flatMap((o) => ('group' in o ? o.options : [o])).map((o) => ({ id: o.value, name: o.name }));
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.modelOptionId || !this.models.some((m) => m.id === modelId)) throw new Error(`The agent does not offer the model ${modelId}.`);
    const res = await this.connection.agent.request('session/set_config_option', { sessionId: this.agentSessionId, configId: this.modelOptionId, value: modelId });
    this.readModels(res?.configOptions);
    this.currentModelId = modelId;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.terminals.values()) if (t.child.pid && t.exitStatus === null) await killTree(t.child.pid);
    this.terminals.clear();
    try {
      this.connection?.close();
    } catch {
      // ignore
    }
    if (this.child.pid && this.child.exitCode === null) await killTree(this.child.pid);
  }
}

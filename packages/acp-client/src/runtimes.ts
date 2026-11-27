import { AGENT_LABELS, type AgentId, type PermissionProfile, type SandboxState, type SessionMode } from '@ade/contracts';
import { listAgentSessions, type ListedSession } from './session-list.ts';
import { AcpAgentSession } from './acp-session.ts';
import { buildAgentEnv, type EnvPolicy } from './env.ts';
import { findOnPath, runForOutput, toSpawnable, type Command } from './process.ts';
import type { AgentInstallInfo, AgentRuntime, AgentSession, LaunchWrapper, StartOptions } from './types.ts';

/**
 * Where the bundled ACP adapters live. The host supplies this because the location differs between
 * development (node_modules) and the packaged app (resources).
 */
export interface AdapterLocator {
  /** Absolute path of the adapter's JS entry point, or null when it is not bundled. */
  adapterEntry(pkg: '@agentclientprotocol/claude-agent-acp' | '@agentclientprotocol/codex-acp'): string | null;
  /** A node binary for running JS adapters. In Electron this is the app binary with ELECTRON_RUN_AS_NODE. */
  nodeCommand(): Command;
  /** Extra env needed for `nodeCommand` (for example ELECTRON_RUN_AS_NODE=1). */
  nodeEnv(): Record<string, string>;
}

interface Descriptor {
  id: AgentId;
  /** The user's install, used for health and version (sign-in happens in this binary's own flow). */
  binary: string | null;
  /** False when the bundled adapter brings its own agent runtime (Claude Code and Codex adapters do). */
  requiresBinary: boolean;
  versionArgs: string[];
  envPolicy: EnvPolicy;
  /** How to start the ACP server for this agent. */
  launch(install: AgentInstallInfo | null, locator: AdapterLocator): { cmd: Command; env: Record<string, string> } | null;
  /**
   * CN-07: the command inside a foreign OS (WSL). ADE's bundled adapters ship Windows binaries, so there the
   * user installs the agent's ACP adapter in the distribution (`npm i -g @agentclientprotocol/claude-agent-acp`).
   */
  foreignLaunch?(wrapper: LaunchWrapper): Command;
  /**
   * CN-04: how this agent's own sandbox is switched on for a profile on a platform, and the honest state that
   * results. Absent means the agent has no sandbox ADE can switch on (the session is not sandboxed).
   */
  agentSandbox?(profile: PermissionProfile, platform: NodeJS.Platform): AgentSandbox;
}

/** CN-04: launch settings for an agent's own sandbox. Facts and sources are in docs/DECISIONS.md. */
export interface AgentSandbox {
  state: SandboxState;
  env?: Record<string, string>;
  sessionMeta?: Record<string, unknown>;
}

/**
 * Codex (codex-acp 2.8, Codex 0.170): `INITIAL_AGENT_MODE` picks a preset of approval policy and sandbox. Every
 * profile maps to a sandboxed preset; full access is never chosen. Commands run in Codex's sandbox, verified on
 * Linux (writes outside the workspace fail, also nested inside ADE's bubblewrap). On Windows the sandbox depends
 * on Codex's own `windows.sandbox` setup, which ADE cannot confirm through the adapter, so it is not claimed.
 */
export const CODEX_MODES: Record<PermissionProfile, string> = {
  ask: 'read-only',
  'read-only': 'read-only',
  'auto-edit': 'workspace-write',
  autonomous: 'agent',
};

export function codexSandbox(profile: PermissionProfile, platform: NodeJS.Platform): AgentSandbox {
  return { state: platform === 'linux' ? 'commands-sandboxed' : 'not-sandboxed', env: { INITIAL_AGENT_MODE: CODEX_MODES[profile] } };
}

/**
 * Claude Code (claude-agent-acp 0.109, Agent SDK 0.3.328): `_meta.claudeCode.options.sandbox` on `session/new`.
 * With `enabled: true` the SDK fails closed (`failIfUnavailable` defaults to true): without bubblewrap the
 * session errors instead of running commands unsandboxed. `allowUnsandboxedCommands: false` removes the model's
 * `dangerouslyDisableSandbox` escape. Linux only: native Windows needs a one-time `/sandbox install` and macOS
 * is not verified yet.
 */
export function claudeSandbox(_profile: PermissionProfile, platform: NodeJS.Platform): AgentSandbox {
  if (platform !== 'linux') return { state: 'not-sandboxed' };
  return {
    state: 'commands-sandboxed',
    sessionMeta: { claudeCode: { options: { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } } } },
  };
}

/** Permission profile -> the agent mode ids that implement it, in preference order (matched by id, not by agent). */
// Mode ids observed in the M0 probe (docs/spike): Claude Code advertises default, acceptEdits, plan, auto and
// bypassPermissions; Codex advertises read-only (asks before edits), workspace-write, agent and agent-full-access.
// The host's permission policy still enforces the profile, so "ask" and "read-only" may share a mode.
const PROFILE_MODES: Record<PermissionProfile, string[]> = {
  ask: ['default', 'ask', 'read-only'],
  'auto-edit': ['acceptEdits', 'workspace-write', 'auto-edit'],
  // Never Codex's agent-full-access: it switches Codex's sandbox off (CN-04).
  autonomous: ['bypassPermissions', 'agent'],
  'read-only': ['plan', 'read-only', 'readonly'],
};

export function pickModeForProfile(profile: PermissionProfile, modes: SessionMode[]): string | null {
  for (const id of PROFILE_MODES[profile]) if (modes.some((m) => m.id === id)) return id;
  return null;
}

/** Template for every ACP-speaking agent. Per-agent differences live in its descriptor only. */
export class AcpRuntime implements AgentRuntime {
  readonly label: string;
  private readonly d: Descriptor;
  private readonly locator: AdapterLocator;

  constructor(d: Descriptor, locator: AdapterLocator) {
    this.d = d;
    this.locator = locator;
    this.label = AGENT_LABELS[d.id];
  }

  get id(): AgentId {
    return this.d.id;
  }

  async detect(): Promise<AgentInstallInfo | null> {
    if (!this.d.binary) return null;
    const path = findOnPath(this.d.binary);
    if (!path) return null;
    const cmd = toSpawnable(path, this.locator.nodeCommand().command);
    const version = cmd ? await runForOutput(cmd, this.d.versionArgs, 10_000, { ...process.env, ...this.locator.nodeEnv() }) : null;
    return { id: this.d.id, path, version: version?.split(/\r?\n/)[0]?.trim() ?? null };
  }

  /** Whether ADE can start this agent's ACP server at all (adapter bundled and binary found). */
  async launchable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const install = await this.detect();
    if (this.d.requiresBinary && !install) return { ok: false, reason: `${this.label} is not installed.` };
    if (!this.d.launch(install, this.locator)) return { ok: false, reason: `The ${this.label} adapter is not bundled with this build.` };
    return { ok: true };
  }

  /** The command to start inside a foreign OS, or null when this agent cannot run there. */
  foreignCommand(wrapper: LaunchWrapper): Command | null {
    return this.d.foreignLaunch?.(wrapper) ?? null;
  }

  async start(opts: StartOptions): Promise<AgentSession> {
    // CN-04: the agent's own sandbox. Inside WSL the agent runs on Linux, whatever the host is.
    const sandbox = this.d.agentSandbox?.(opts.permissionProfile, opts.wrapper?.kind === 'wsl' ? 'linux' : process.platform);
    const withMeta: StartOptions = sandbox?.sessionMeta ? { ...opts, sessionMeta: sandbox.sessionMeta } : opts;
    if (opts.wrapper?.foreign) {
      const cmd = this.foreignCommand(opts.wrapper);
      if (!cmd) throw new Error(`${this.label} cannot run inside ${opts.wrapper.kind.toUpperCase()}.`);
      return this.connect(cmd, { ...buildAgentEnv(opts.baseEnv ?? process.env, this.d.envPolicy), ...sandbox?.env }, withMeta);
    }
    const install = await this.detect();
    const launch = this.d.launch(install, this.locator);
    if (!launch) throw new Error(`${this.label} cannot be started: it is not installed or its adapter is missing.`);
    const env = { ...buildAgentEnv(opts.baseEnv ?? process.env, this.d.envPolicy), ...launch.env, ...sandbox?.env };
    return this.connect(launch.cmd, env, withMeta);
  }

  /** SR-10: the conversations this agent's CLI keeps for `cwd`, or null when the agent cannot list them. */
  async listSessions(cwd: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<ListedSession[] | null> {
    const install = await this.detect();
    const launch = this.d.launch(install, this.locator);
    if (!launch) return null;
    return listAgentSessions(launch.cmd, { ...buildAgentEnv(baseEnv, this.d.envPolicy), ...launch.env }, cwd);
  }

  private async connect(cmd: Command, env: Record<string, string>, opts: StartOptions): Promise<AgentSession> {
    const session = await AcpAgentSession.start(cmd, env, opts);
    const mode = pickModeForProfile(opts.permissionProfile, session.modes);
    if (mode && mode !== session.currentModeId) await session.setMode(mode);
    return session;
  }

  /** Honest safety (rule 5): only what the agent's verified sandbox settings enforce; otherwise "not sandboxed". */
  sandboxFor(profile: PermissionProfile, platform: NodeJS.Platform): SandboxState {
    return this.d.agentSandbox?.(profile, platform).state ?? 'not-sandboxed';
  }
}

const nodeLaunch = (locator: AdapterLocator, entry: string | null, args: string[] = []) =>
  entry ? { cmd: { command: locator.nodeCommand().command, args: [...locator.nodeCommand().args, entry, ...args] }, env: locator.nodeEnv() } : null;

export function createRuntimes(locator: AdapterLocator, opts: { fakeAgentEntry?: string } = {}): Map<AgentId, AcpRuntime> {
  const descriptors: Descriptor[] = [
    {
      id: 'opencode',
      binary: 'opencode',
      requiresBinary: true,
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['OPENCODE_'], names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] },
      launch: (install) => {
        if (!install) return null;
        const cmd = toSpawnable(install.path, locator.nodeCommand().command);
        return cmd ? { cmd: { command: cmd.command, args: [...cmd.args, 'acp'] }, env: locator.nodeEnv() } : null;
      },
      foreignLaunch: () => ({ command: 'opencode', args: ['acp'] }),
    },
    {
      id: 'claude-code',
      binary: 'claude',
      requiresBinary: false,
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['CLAUDE_CODE_', 'ANTHROPIC_'], names: ['CLAUDE_CONFIG_DIR'] },
      launch: () => nodeLaunch(locator, locator.adapterEntry('@agentclientprotocol/claude-agent-acp')),
      // Bin names from the adapters' package.json (claude-agent-acp 0.109, codex-acp 2.8).
      foreignLaunch: () => ({ command: 'claude-agent-acp', args: [] }),
      agentSandbox: claudeSandbox,
    },
    {
      id: 'codex',
      binary: 'codex',
      requiresBinary: false,
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['CODEX_'], names: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] },
      launch: () => nodeLaunch(locator, locator.adapterEntry('@agentclientprotocol/codex-acp')),
      foreignLaunch: () => ({ command: 'codex-acp', args: [] }),
      agentSandbox: codexSandbox,
    },
  ];
  if (opts.fakeAgentEntry) {
    const entry = opts.fakeAgentEntry;
    descriptors.push({
      id: 'fake',
      binary: null,
      requiresBinary: false,
      versionArgs: [],
      envPolicy: { prefixes: ['ADE_FAKE_'] },
      launch: () => nodeLaunch(locator, entry),
      // The fake agent is plain JavaScript, so a `node` inside the distribution can run ADE's copy.
      foreignLaunch: (wrapper) => ({ command: 'node', args: [wrapper.toAgentPath(entry)] }),
    });
  }
  return new Map(descriptors.map((d) => [d.id, new AcpRuntime(d, locator)]));
}

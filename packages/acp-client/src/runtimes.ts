import { AGENT_LABELS, type AgentId, type PermissionProfile, type SandboxState, type SessionMode } from '@ade/contracts';
import { AcpAgentSession } from './acp-session.ts';
import { buildAgentEnv, type EnvPolicy } from './env.ts';
import { findOnPath, runForOutput, toSpawnable, type Command } from './process.ts';
import type { AgentInstallInfo, AgentRuntime, AgentSession, StartOptions } from './types.ts';

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
  versionArgs: string[];
  envPolicy: EnvPolicy;
  /** How to start the ACP server for this agent. */
  launch(install: AgentInstallInfo | null, locator: AdapterLocator): { cmd: Command; env: Record<string, string> } | null;
}

/** Permission profile -> the agent mode ids that implement it, in preference order (matched by id, not by agent). */
const PROFILE_MODES: Record<PermissionProfile, string[]> = {
  ask: ['default', 'ask', 'build', 'auto'],
  'auto-edit': ['acceptEdits', 'auto-edit', 'autoEdit', 'auto'],
  autonomous: ['bypassPermissions', 'full-access', 'yolo', 'autonomous'],
  'read-only': ['plan', 'read-only', 'readonly', 'read_only'],
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
    if (this.d.binary && !install) return { ok: false, reason: `${this.label} is not installed.` };
    if (!this.d.launch(install, this.locator)) return { ok: false, reason: `The ${this.label} adapter is not bundled with this build.` };
    return { ok: true };
  }

  async start(opts: StartOptions): Promise<AgentSession> {
    const install = await this.detect();
    const launch = this.d.launch(install, this.locator);
    if (!launch) throw new Error(`${this.label} cannot be started: it is not installed or its adapter is missing.`);
    const env = { ...buildAgentEnv(opts.baseEnv ?? process.env, this.d.envPolicy), ...launch.env };
    const session = await AcpAgentSession.start(launch.cmd, env, opts);
    const mode = pickModeForProfile(opts.permissionProfile, session.modes);
    if (mode && mode !== session.currentModeId) await session.setMode(mode);
    return session;
  }

  /**
   * Honest safety (rule 5): no agent sandbox is switched on by ADE until the spike verifies how each adapter
   * accepts sandbox settings at launch (docs/DECISIONS.md). Until then every session is "not sandboxed".
   */
  sandboxFor(_profile: PermissionProfile, _platform: NodeJS.Platform): SandboxState {
    return 'not-sandboxed';
  }
}

const nodeLaunch = (locator: AdapterLocator, entry: string | null, args: string[] = []) =>
  entry ? { cmd: { command: locator.nodeCommand().command, args: [...locator.nodeCommand().args, entry, ...args] }, env: locator.nodeEnv() } : null;

export function createRuntimes(locator: AdapterLocator, opts: { fakeAgentEntry?: string } = {}): Map<AgentId, AcpRuntime> {
  const descriptors: Descriptor[] = [
    {
      id: 'opencode',
      binary: 'opencode',
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['OPENCODE_'], names: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] },
      launch: (install) => {
        if (!install) return null;
        const cmd = toSpawnable(install.path, locator.nodeCommand().command);
        return cmd ? { cmd: { command: cmd.command, args: [...cmd.args, 'acp'] }, env: locator.nodeEnv() } : null;
      },
    },
    {
      id: 'claude-code',
      binary: 'claude',
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['CLAUDE_CODE_', 'ANTHROPIC_'], names: ['CLAUDE_CONFIG_DIR'] },
      launch: () => nodeLaunch(locator, locator.adapterEntry('@agentclientprotocol/claude-agent-acp')),
    },
    {
      id: 'codex',
      binary: 'codex',
      versionArgs: ['--version'],
      envPolicy: { prefixes: ['CODEX_'], names: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] },
      launch: () => nodeLaunch(locator, locator.adapterEntry('@agentclientprotocol/codex-acp')),
    },
  ];
  if (opts.fakeAgentEntry) {
    const entry = opts.fakeAgentEntry;
    descriptors.push({
      id: 'fake',
      binary: null,
      versionArgs: [],
      envPolicy: { prefixes: ['ADE_FAKE_'] },
      launch: () => nodeLaunch(locator, entry),
    });
  }
  return new Map(descriptors.map((d) => [d.id, new AcpRuntime(d, locator)]));
}

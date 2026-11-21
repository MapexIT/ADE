import type {
  AgentCapabilities,
  AgentId,
  DistributiveOmit,
  NewSessionEvent,
  PermissionDecision,
  PermissionOption,
  PermissionProfile,
  PromptBlock,
  SandboxState,
  SessionMode,
  ToolKind,
} from '@ade/contracts';

/** Session events as the agent layer produces them; the host adds `sessionId`, `seq` and `ts`. */
export type AgentEvent = DistributiveOmit<NewSessionEvent, 'sessionId'>;

export interface AgentInstallInfo {
  id: AgentId;
  /** Executable or script that was found. */
  path: string;
  version: string | null;
}

/**
 * CN-07: Decorator around how a process is started, so the agent and every command it asks ADE to run end up
 * inside an OS sandbox (bubblewrap) or inside another OS (WSL). Implemented by the host.
 */
export interface LaunchWrapper {
  readonly kind: 'bubblewrap' | 'wsl';
  /** True when the agent must be the one installed inside the wrapper's OS rather than ADE's bundled adapter. */
  readonly foreign: boolean;
  /** The path the agent sees for a host path, and back. */
  toAgentPath(hostPath: string): string;
  toHostPath(agentPath: string): string;
  /** `cwd` is a host path. Returns what to spawn on the host. */
  wrap(cmd: { command: string; args: string[] }, opts: { cwd: string; env: Record<string, string> }): {
    cmd: { command: string; args: string[] };
    cwd: string;
    env: Record<string, string>;
  };
}

export type McpServerSpec =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; headers: Record<string, string> };

export interface StartOptions {
  /** Absolute path of the session worktree. Every agent process runs here. */
  cwd: string;
  permissionProfile: PermissionProfile;
  mcpServers?: McpServerSpec[];
  /** Resume an earlier agent session with `session/load` when the agent supports it. */
  resumeSessionId?: string;
  /** Source environment to filter through the allow-list. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Raw protocol messages, for the protocol inspector (WA-05). Credentials are redacted before this is called. */
  onProtocolMessage?: (direction: 'in' | 'out', body: string) => void;
  /** CN-07: runs the agent, and the commands it asks ADE to run, inside a sandbox or WSL. */
  wrapper?: LaunchWrapper;
  /** CN-04: `_meta` for `session/new` and `session/load`, set by the runtime (the agent's own sandbox settings). */
  sessionMeta?: Record<string, unknown>;
}

export interface PermissionRequestInfo {
  requestId: string;
  toolCallId: string;
  title: string;
  kind: ToolKind | null;
  detail: string | null;
  options: PermissionOption[];
}

export type PermissionHandler = (request: PermissionRequestInfo, signal: AbortSignal) => Promise<PermissionDecision>;

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** One running agent conversation. Implementations adapt a concrete protocol (ACP) to this seam. */
export interface AgentSession {
  readonly capabilities: AgentCapabilities;
  readonly agentSessionId: string;
  readonly modes: SessionMode[];
  readonly currentModeId: string | null;
  /** Models from the agent's `model` config option (ACP session config options); empty when not offered. */
  readonly models: { id: string; name: string }[];
  readonly currentModelId: string | null;
  readonly pid: number | null;
  /** Latest usage the agent reported (HI-03), or null when it reports none. */
  readonly usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  prompt(content: PromptBlock[]): Promise<StopReason>;
  cancel(): Promise<void>;
  setMode(modeId: string): Promise<void>;
  /** WF-09: picks a model through `session/set_config_option`. Throws when the agent does not offer it. */
  setModel(modelId: string): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onPermissionRequest(handler: PermissionHandler): void;
  /** TM-04: stops a command the agent started through `terminal/create` (its whole process tree). */
  killCommand(terminalId: string): Promise<boolean>;
  /** Resolves when the agent process exits, with an error when it crashed. */
  readonly exited: Promise<{ code: number | null; error: string | null }>;
  close(): Promise<void>;
}

/** Strategy for one agent: how to find it and how to start it. Nothing outside this decides per agent. */
export interface AgentRuntime {
  readonly id: AgentId;
  readonly label: string;
  detect(): Promise<AgentInstallInfo | null>;
  start(opts: StartOptions): Promise<AgentSession>;
  /** Sandbox state for a profile on this platform. Never optimistic: unverified means not sandboxed. */
  sandboxFor(profile: PermissionProfile, platform: NodeJS.Platform): SandboxState;
}

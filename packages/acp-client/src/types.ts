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
  /** Commands the agent runs through the client (`terminal/*`), for TM-04. */
  onTerminalOutput?: (terminalId: string, chunk: string) => void;
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
  readonly pid: number | null;
  /** Latest usage the agent reported (HI-03), or null when it reports none. */
  readonly usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  prompt(content: PromptBlock[]): Promise<StopReason>;
  cancel(): Promise<void>;
  setMode(modeId: string): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  onPermissionRequest(handler: PermissionHandler): void;
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

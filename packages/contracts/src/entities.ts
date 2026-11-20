import { z } from 'zod';

/** Agents ADE knows how to launch. `fake` is the scripted test agent and is never shown in production builds. */
export const AgentId = z.enum(['codex', 'claude-code', 'opencode', 'fake']);
export type AgentId = z.infer<typeof AgentId>;

export const PRODUCT_AGENTS = ['codex', 'claude-code', 'opencode'] as const satisfies readonly AgentId[];

export const AGENT_LABELS: Record<AgentId, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  fake: 'Fake agent',
};

export const SessionState = z.enum([
  'queued',
  'starting',
  'working',
  'waiting-on-user',
  'ready',
  'interrupted',
  'landed',
  'discarded',
]);
export type SessionState = z.infer<typeof SessionState>;

export const PermissionProfile = z.enum(['ask', 'auto-edit', 'autonomous', 'read-only']);
export type PermissionProfile = z.infer<typeof PermissionProfile>;

export const SandboxState = z.enum(['sandboxed', 'commands-sandboxed', 'not-sandboxed']);
export type SandboxState = z.infer<typeof SandboxState>;

export const AgentHealth = z.enum(['ready', 'needs-sign-in', 'not-installed']);
export type AgentHealth = z.infer<typeof AgentHealth>;

/** Capabilities come from the ACP `initialize` response. Nothing here is hard-coded per agent. */
export const AgentCapabilities = z.object({
  protocolVersion: z.number().int(),
  loadSession: z.boolean(),
  promptImage: z.boolean(),
  promptEmbeddedContext: z.boolean(),
  mcpHttp: z.boolean(),
  authMethods: z.array(z.object({ id: z.string(), name: z.string() })),
  agentName: z.string().optional(),
  agentVersion: z.string().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

export const AgentInstall = z.object({
  id: AgentId,
  path: z.string(),
  version: z.string().nullable(),
  health: AgentHealth,
  detectedAt: z.string(),
});
export type AgentInstall = z.infer<typeof AgentInstall>;

export const AgentStatus = z.object({
  id: AgentId,
  label: z.string(),
  health: AgentHealth,
  path: z.string().nullable(),
  version: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Workspace = z.object({
  id: z.string(),
  rootPath: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const SessionMode = z.object({ id: z.string(), name: z.string(), description: z.string().nullable() });
export type SessionMode = z.infer<typeof SessionMode>;

export const Usage = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export type Usage = z.infer<typeof Usage>;

export const Session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: AgentId,
  title: z.string(),
  state: SessionState,
  baseCommit: z.string().nullable(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  permissionProfile: PermissionProfile,
  sandboxState: SandboxState,
  agentSessionId: z.string().nullable(),
  workItemRef: z.string().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

export const Turn = z.object({
  id: z.string(),
  sessionId: z.string(),
  index: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  startCheckpoint: z.string().nullable(),
  endCheckpoint: z.string().nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const PermissionOptionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>;

export const PermissionOption = z.object({ optionId: z.string(), name: z.string(), kind: PermissionOptionKind });
export type PermissionOption = z.infer<typeof PermissionOption>;

export const PermissionDecision = z.union([
  z.object({ outcome: z.literal('selected'), optionId: z.string() }),
  z.object({ outcome: z.literal('cancelled') }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionRequest = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  toolCallId: z.string(),
  title: z.string(),
  options: z.array(PermissionOption),
  decision: PermissionDecision.nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const RunConfig = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  command: z.array(z.string()).min(1),
  cwd: z.string(),
  source: z.enum(['detected', 'user']),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const Run = z.object({
  id: z.string(),
  runConfigId: z.string().nullable(),
  sessionId: z.string().nullable(),
  worktreePath: z.string(),
  command: z.array(z.string()),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
});
export type Run = z.infer<typeof Run>;

export const AuditEntry = z.object({
  id: z.string(),
  ts: z.string(),
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const FileChange = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'binary']),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type FileChange = z.infer<typeof FileChange>;

export const WorkItem = z.object({
  ref: z.string(),
  source: z.enum(['shortcut', 'github']),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  url: z.string().nullable(),
  group: z.string().nullable(),
});
export type WorkItem = z.infer<typeof WorkItem>;

import { z } from 'zod';
import {
  AgentId,
  AgentStatus,
  AuditEntry,
  FileChange,
  PermissionProfile,
  Run,
  RunConfig,
  Session,
  Turn,
  WorkItem,
  Workspace,
} from './entities.ts';
import { PromptBlock, SessionEvent, ToolKind } from './events.ts';
import { defineApi, defineTopics, method } from './rpc.ts';

const Id = z.string().min(1).max(200);

/** SK-03: portable Agent Skills names (lower-case kebab case, 1 to 64 characters). */
export const SkillName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'use lower-case letters, digits and single dashes').max(64);
const AbsPath = z.string().min(1).max(4096);
const Ok = z.object({ ok: z.literal(true) });

export const NeedsYouItem = z.object({
  id: z.string(),
  /** The session the item belongs to; for workflow items, the run's latest session or an empty string. */
  sessionId: z.string(),
  sessionTitle: z.string(),
  kind: z.enum(['permission', 'question', 'setup-failed', 'interrupted', 'limit', 'gate', 'paused']),
  /** Set for workflow gates and paused runs. */
  runId: z.string().optional(),
  nodeId: z.string().optional(),
  title: z.string(),
  createdAt: z.string(),
});
export type NeedsYouItem = z.infer<typeof NeedsYouItem>;

export const FileEntry = z.object({ path: z.string(), name: z.string(), isDir: z.boolean() });
export type FileEntry = z.infer<typeof FileEntry>;

export const FileContent = z.object({ path: z.string(), content: z.string(), mtimeMs: z.number() });
export type FileContent = z.infer<typeof FileContent>;

export const CreateSessionInput = z.object({
  workspaceId: Id,
  agentId: AgentId,
  title: z.string().max(200).optional(),
  prompt: z.array(PromptBlock).min(1),
  permissionProfile: PermissionProfile,
  baseRef: z.string().max(200).optional(),
  bringChanges: z.boolean().default(false),
  workItemRef: z.string().max(200).optional(),
  modeId: z.string().max(200).optional(),
  /** WF-09: a model from the agent's model option; the session fails to start when the agent does not offer it. */
  modelId: z.string().max(200).optional(),
  /** SK-01: skills (by name) copied into the agent's skills folder in the worktree for this session only. */
  skills: z.array(SkillName).max(20).optional(),
  /**
   * CN-07: run inside the host sandbox. Left out, Linux uses it whenever it works and Windows does not (WSL
   * sessions are opt-in because the agent must be installed inside the distribution).
   */
  hostSandbox: z.boolean().optional(),
  /** CN-08: work in the real checkout after a snapshot. Needs the "run in place" setting; one session at a time. */
  inPlace: z.boolean().optional(),
});
export type CreateSessionInput = z.input<typeof CreateSessionInput>;

/** CN-07: whether this machine can run sessions inside an OS-enforced sandbox, and why not. */
export const ContainmentStatus = z.object({
  kind: z.enum(['bubblewrap', 'wsl', 'none']),
  available: z.boolean(),
  /** Why it is unavailable, in words for the user. */
  reason: z.string().nullable(),
  /** The WSL distribution sessions run in. */
  distro: z.string().nullable(),
  /** Whether new sessions use it unless the user says otherwise. */
  defaultOn: z.boolean(),
  /** Agents that can be started inside it (WSL needs each agent installed in the distribution). */
  agents: z.array(AgentId),
});
export type ContainmentStatus = z.infer<typeof ContainmentStatus>;

/** TM-07: a named command for this workspace's terminals. */
export const SavedCommand = z.object({
  id: Id,
  name: z.string().trim().min(1).max(100),
  command: z.string().trim().min(1).max(2000),
});
export type SavedCommand = z.infer<typeof SavedCommand>;

/** AP-06: a workspace rule that answers matching permission requests without asking. */
export const PermissionRule = z.object({
  id: Id,
  decision: z.enum(['allow', 'deny']),
  /** The request's tool kind, or any. */
  kind: z.union([ToolKind, z.literal('any')]),
  /** Matched against the request title and command, ignoring case. `*` matches anything. */
  pattern: z.string().trim().min(1).max(500),
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const SessionDetail = z.object({
  session: Session,
  turns: z.array(Turn),
  events: z.array(SessionEvent),
  queued: z.array(z.object({ id: z.string(), content: z.array(PromptBlock) })),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const DiffText = z.object({ path: z.string(), oldText: z.string(), newText: z.string(), binary: z.boolean() });
export type DiffText = z.infer<typeof DiffText>;

export const ProtocolMessage = z.object({
  ts: z.string(),
  direction: z.enum(['in', 'out']),
  body: z.string(),
});
export type ProtocolMessage = z.infer<typeof ProtocolMessage>;

export const WorkflowSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(['template', 'repository']),
  path: z.string().nullable(),
  /** WF-10: how the workflow is meant to start. */
  trigger: z.enum(['manual', 'work-item', 'failed-check', 'ready-session', 'terminal-command']),
  /** Agents its steps name, so a picker can offer stand-ins for agents that are not ready (WF-09). */
  agents: z.array(AgentId),
  nodes: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), detail: z.string() })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), when: z.enum(['pass', 'fail']).nullable() })),
  problems: z.array(z.object({ level: z.enum(['error', 'warning']), message: z.string(), nodeId: z.string().nullable() })),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummary>;

export const WorkflowRunStatus = z.enum(['running', 'waiting-gate', 'paused', 'succeeded', 'failed', 'cancelled']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatus>;

/** WF-06: one workflow run as the run view shows it. */
export const WorkflowRunView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: WorkflowRunStatus,
  current: z.string().nullable(),
  pauseReason: z.string().nullable(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      detail: z.string(),
      status: z.enum(['pending', 'running', 'passed', 'failed', 'waiting', 'skipped']),
      attempts: z.number(),
      sessionId: z.string().nullable(),
      startedAt: z.number().nullable(),
      endedAt: z.number().nullable(),
      summary: z.string(),
    }),
  ),
  edges: WorkflowSummary.shape.edges,
  used: z.object({ turns: z.number(), minutes: z.number(), loops: z.number(), costUsd: z.number() }),
  budgets: z.object({ minutes: z.number().optional(), turns: z.number().optional(), loops: z.number().optional(), costUsd: z.number().optional() }),
  log: z.array(z.string()),
  createdAt: z.string(),
});
export type WorkflowRunView = z.infer<typeof WorkflowRunView>;

export const HandOffSample = z.object({ summary: z.string().max(200_000).default(''), diff: z.string().max(400_000).default(''), checkOutput: z.string().max(200_000).default('') });

export const StartWorkflowInput = z.object({
  workspaceId: Id,
  workflowId: z.string().min(1).max(300),
  workItem: z.record(z.string(), z.string().max(20_000)).default({}),
  /** WF-09: run a node written for one agent with another, for example when that agent is not installed. */
  agentOverrides: z.partialRecord(AgentId, AgentId).default({}),
  /** Seeds the first step's hand-off, for example a failed command's output as `{{checkOutput}}`. */
  handOff: HandOffSample.partial().optional(),
});
export type StartWorkflowInput = z.input<typeof StartWorkflowInput>;

export const WorkflowDetail = z.object({ summary: WorkflowSummary, yaml: z.string(), definition: z.unknown() });
export type WorkflowDetail = z.infer<typeof WorkflowDetail>;



/** SK-02: one skill as the library shows it. */
export const Skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** repository: `.ade/skills`; personal: ADE's own library; installed: an agent's own skills folder. */
  location: z.enum(['repository', 'personal', 'installed']),
  /** For installed skills, the agent folder it was found in. */
  agentFolder: z.string().nullable(),
  path: z.string(),
  /** SK-05: agents whose user skills folder holds a copy ADE synced. */
  syncedTo: z.array(z.enum(['claude-code', 'codex', 'opencode'])),
  problems: z.array(z.string()),
});
export type Skill = z.infer<typeof Skill>;

/** Requests served by the host utility process. */
export const hostApi = defineApi({
  'app.ping': method(z.object({}), z.object({ pid: z.number(), startedAt: z.string() })),

  'workspace.list': method(z.object({}), z.array(Workspace)),
  'workspace.open': method(z.object({ path: AbsPath }), Workspace),
  'workspace.setupFile': method(z.object({ workspaceId: Id }), z.object({ exists: z.boolean(), content: z.string() })),

  'settings.get': method(z.object({ key: z.string().min(1).max(100) }), z.object({ value: z.unknown() })),
  'settings.set': method(z.object({ key: z.string().min(1).max(100), value: z.unknown() }), Ok),

  'agents.status': method(z.object({ refresh: z.boolean().default(false) }), z.array(AgentStatus)),
  'containment.status': method(z.object({ refresh: z.boolean().default(false) }), ContainmentStatus),
  'commands.list': method(z.object({ workspaceId: Id }), z.array(SavedCommand)),
  'commands.save': method(z.object({ workspaceId: Id, commands: z.array(SavedCommand).max(100) }), Ok),
  'rules.list': method(z.object({ workspaceId: Id }), z.array(PermissionRule)),
  'rules.save': method(z.object({ workspaceId: Id, rules: z.array(PermissionRule).max(200) }), Ok),

  'sessions.list': method(z.object({ workspaceId: Id }), z.array(Session)),
  'sessions.get': method(z.object({ sessionId: Id }), SessionDetail),
  'sessions.create': method(CreateSessionInput, Session),
  'sessions.prompt': method(z.object({ sessionId: Id, content: z.array(PromptBlock).min(1) }), Ok),
  'sessions.queue': method(z.object({ sessionId: Id, content: z.array(PromptBlock).min(1) }), z.object({ id: z.string() })),
  'sessions.unqueue': method(z.object({ sessionId: Id, id: Id }), Ok),
  'sessions.editQueued': method(z.object({ sessionId: Id, id: Id, content: z.array(PromptBlock).min(1) }), Ok),
  'sessions.cancel': method(z.object({ sessionId: Id }), Ok),
  'sessions.interrupt': method(z.object({ sessionId: Id, content: z.array(PromptBlock).min(1) }), Ok),
  'sessions.answerPermission': method(
    z.object({ sessionId: Id, requestId: Id, optionId: z.string().nullable(), note: z.string().max(10_000).optional() }),
    Ok,
  ),
  'sessions.setMode': method(z.object({ sessionId: Id, modeId: z.string().min(1) }), Ok),
  'sessions.changes': method(z.object({ sessionId: Id, turnIndex: z.number().int().nullable() }), z.array(FileChange)),
  'sessions.diff': method(
    z.object({ sessionId: Id, path: z.string().min(1), turnIndex: z.number().int().nullable() }),
    DiffText,
  ),
  'sessions.undoTurn': method(z.object({ sessionId: Id, turnIndex: z.number().int().nonnegative() }), Ok),
  'sessions.land': method(
    z.object({ sessionId: Id, mode: z.enum(['apply', 'commit']), files: z.array(z.string()).min(1), message: z.string().optional() }),
    Ok,
  ),
  'sessions.discard': method(z.object({ sessionId: Id }), z.object({ patchPath: z.string().nullable() })),
  'sessions.protocol': method(z.object({ sessionId: Id }), z.array(ProtocolMessage)),
  /** PL-03: one prompt to two or three agents, each in its own worktree. */
  'sessions.compare': method(
    CreateSessionInput.omit({ agentId: true, inPlace: true, modelId: true, modeId: true }).extend({ agentIds: z.array(AgentId).min(2).max(3) }),
    z.array(Session),
  ),
  /** SR-07: the same worktree continues with another agent, given the last message and the diff. */
  'sessions.handOff': method(z.object({ sessionId: Id, agentId: AgentId, note: z.string().max(10_000).optional() }), Session),
  /** SR-08: stops ADE's agent process so the agent's own UI can resume the conversation. */
  /** PL-04: live sessions in a workspace that changed the same files. */
  'sessions.overlaps': method(
    z.object({ workspaceId: Id }),
    z.array(z.object({ sessionId: z.string(), otherSessionId: z.string(), files: z.array(z.string()) })),
  ),
  'sessions.detach': method(z.object({ sessionId: Id }), z.object({ agentSessionId: z.string().nullable() })),

  'inbox.list': method(z.object({}), z.array(NeedsYouItem)),

  'files.list': method(z.object({ root: AbsPath }), z.array(FileEntry)),
  'files.read': method(z.object({ path: AbsPath }), FileContent),
  'files.write': method(
    z.object({ path: AbsPath, content: z.string(), expectedMtimeMs: z.number().nullable(), sessionId: Id.optional() }),
    z.union([z.object({ ok: z.literal(true), mtimeMs: z.number() }), z.object({ ok: z.literal(false), conflict: z.literal(true) })]),
  ),

  'runs.configs': method(z.object({ workspaceId: Id }), z.array(RunConfig)),
  'runs.saveConfig': method(RunConfig.omit({ id: true, source: true }).extend({ id: Id.optional() }), RunConfig),
  'runs.record': method(Run.omit({ id: true }), Run),
  'runs.history': method(z.object({ workspaceId: Id }), z.array(Run)),

  'audit.list': method(z.object({ workspaceId: Id }), z.array(AuditEntry)),

  'workflows.list': method(z.object({ workspaceId: Id.nullable() }), z.array(WorkflowSummary)),
  'workflows.start': method(StartWorkflowInput, WorkflowRunView),
  'workflows.get': method(z.object({ workspaceId: Id, workflowId: z.string().min(1).max(300) }), WorkflowDetail),
  /** WF-01: saves an edited workflow to `.ade/workflows/<file>`. Structural problems are returned, not refused. */
  'workflows.save': method(z.object({ workspaceId: Id, file: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}\.ya?ml$/i), definition: z.unknown() }), WorkflowSummary),
  /** WF-11: runs one node on sample input as a one-step run. */
  'workflows.testNode': method(
    z.object({ workspaceId: Id, node: z.unknown(), sample: HandOffSample.default({ summary: '', diff: '', checkOutput: '' }), workItem: z.record(z.string(), z.string()).default({}), agentOverrides: z.partialRecord(AgentId, AgentId).default({}) }),
    WorkflowRunView,
  ),
  'workflows.runs': method(z.object({ workspaceId: Id }), z.array(WorkflowRunView)),
  'workflows.decideGate': method(z.object({ runId: Id, nodeId: z.string(), approved: z.boolean() }), Ok),
  'workflows.resume': method(z.object({ runId: Id }), Ok),
  'workflows.retryFrom': method(z.object({ runId: Id, nodeId: z.string() }), Ok),
  'workflows.cancel': method(z.object({ runId: Id }), Ok),
  'skills.list': method(z.object({ workspaceId: Id.nullable() }), z.array(Skill)),
  'skills.read': method(z.object({ workspaceId: Id.nullable(), id: z.string() }), z.object({ skill: Skill, content: z.string() })),
  'skills.save': method(
    z.object({
      workspaceId: Id.nullable(),
      location: z.enum(['repository', 'personal']),
      name: SkillName,
      description: z.string().min(1).max(1024),
      body: z.string().max(200_000),
      overwrite: z.boolean().default(false),
    }),
    Skill,
  ),
  'skills.draft': method(
    z.object({ workspaceId: Id, agentId: AgentId, name: SkillName, description: z.string().min(1).max(4000), fromSessionId: Id.optional() }),
    Session,
  ),
  'skills.sync': method(z.object({ workspaceId: Id.nullable(), id: z.string(), enabled: z.boolean() }), Skill),
  'workItems.sources': method(z.object({}), z.array(z.object({ source: z.enum(['shortcut', 'github']), connected: z.boolean() }))),
  'workItems.list': method(z.object({ source: z.enum(['shortcut', 'github']), query: z.string().optional() }), z.array(WorkItem)),
});
export type HostApi = typeof hostApi;

export const SessionsChanged = z.object({ workspaceId: z.string(), session: Session });

/** Streams published by the host. */
export const hostTopics = defineTopics({
  'session.event': SessionEvent,
  'session.changed': SessionsChanged,
  'inbox.changed': z.array(NeedsYouItem),
  'workflow.run': WorkflowRunView,
  'notify': z.object({ sessionId: z.string(), title: z.string(), body: z.string() }),
});
export type HostTopics = typeof hostTopics;

export const ShellKind = z.enum(['pwsh', 'powershell', 'bash', 'zsh', 'fish', 'git-bash']);
export type ShellKind = z.infer<typeof ShellKind>;

export const TerminalKind = z.enum(['smart', 'plain', 'agent-ui']);
export type TerminalKind = z.infer<typeof TerminalKind>;

export const CommandBlock = z.object({
  id: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  exitCode: z.number().int().nullable(),
  output: z.string(),
});
export type CommandBlock = z.infer<typeof CommandBlock>;

export const TerminalInfo = z.object({
  id: z.string(),
  kind: TerminalKind,
  shell: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  title: z.string(),
  pid: z.number().nullable(),
  smart: z.boolean(),
  agentState: z.enum(['none', 'working', 'waiting', 'finished']),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

/** Requests served by the pty utility process. */
export const ptyApi = defineApi({
  'pty.shells': method(z.object({}), z.array(z.object({ id: ShellKind, label: z.string(), path: z.string() }))),
  'pty.create': method(
    z.object({
      kind: TerminalKind,
      shell: ShellKind.optional(),
      cwd: AbsPath,
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(2).max(1000),
      sessionId: z.string().nullable(),
      command: z.array(z.string()).optional(),
      title: z.string().optional(),
    }),
    TerminalInfo,
  ),
  'pty.write': method(z.object({ id: Id, data: z.string().max(1_000_000) }), Ok),
  'pty.resize': method(z.object({ id: Id, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }), Ok),
  'pty.kill': method(z.object({ id: Id }), Ok),
  'pty.killSession': method(z.object({ sessionId: Id }), Ok),
  'pty.list': method(z.object({}), z.array(TerminalInfo)),
  'pty.blocks': method(z.object({ id: Id }), z.array(CommandBlock)),
  'pty.run': method(
    z.object({ command: z.array(z.string()).min(1), cwd: AbsPath, sessionId: z.string().nullable(), runId: Id }),
    z.object({ terminalId: z.string() }),
  ),
});
export type PtyApi = typeof ptyApi;

export const ptyTopics = defineTopics({
  'pty.data': z.object({ id: z.string(), data: z.string() }),
  'pty.block': z.object({ id: z.string(), block: CommandBlock }),
  'pty.exit': z.object({ id: z.string(), exitCode: z.number().int().nullable() }),
  'pty.changed': TerminalInfo,
  'pty.runFinished': z.object({ runId: z.string(), exitCode: z.number().int().nullable(), output: z.string() }),
});
export type PtyTopics = typeof ptyTopics;

/** Requests served by Electron main (things only main may do). Invoked through `ipcRenderer.invoke`. */
export const mainApi = defineApi({
  'main.pickDirectory': method(z.object({ title: z.string().max(200).optional() }), z.object({ path: z.string().nullable() })),
  'main.openExternal': method(z.object({ url: z.url({ protocol: /^https?$/ }) }), Ok),
  'main.openInEditor': method(z.object({ path: AbsPath }), Ok),
  'main.notify': method(z.object({ title: z.string().max(200), body: z.string().max(1000), sessionId: z.string().optional() }), Ok),
  'main.credentials.status': method(
    z.object({}),
    z.object({ available: z.boolean(), backend: z.string(), stored: z.array(z.string()) }),
  ),
  'main.credentials.set': method(z.object({ key: z.enum(['shortcut', 'github']), secret: z.string().min(1).max(10_000) }), Ok),
  'main.credentials.delete': method(z.object({ key: z.enum(['shortcut', 'github']) }), Ok),
  'main.info': method(
    z.object({}),
    z.object({ version: z.string(), platform: z.string(), userData: z.string(), isPackaged: z.boolean() }),
  ),
  'main.restartProcess': method(z.object({ which: z.enum(['host', 'pty']) }), Ok),
});
export type MainApi = typeof mainApi;

export const mainTopics = defineTopics({
  'process.status': z.object({ which: z.enum(['host', 'pty']), status: z.enum(['up', 'restarting', 'down']) }),
  'focus.session': z.object({ sessionId: z.string() }),
});
export type MainTopics = typeof mainTopics;

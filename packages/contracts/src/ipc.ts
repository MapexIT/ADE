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
import { PromptBlock, SessionEvent } from './events.ts';
import { defineApi, defineTopics, method } from './rpc.ts';

const Id = z.string().min(1).max(200);
const AbsPath = z.string().min(1).max(4096);
const Ok = z.object({ ok: z.literal(true) });

export const NeedsYouItem = z.object({
  id: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  kind: z.enum(['permission', 'question', 'setup-failed', 'limit']),
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
});
export type CreateSessionInput = z.input<typeof CreateSessionInput>;

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

/** Requests served by the host utility process. */
export const hostApi = defineApi({
  'app.ping': method(z.object({}), z.object({ pid: z.number(), startedAt: z.string() })),

  'workspace.list': method(z.object({}), z.array(Workspace)),
  'workspace.open': method(z.object({ path: AbsPath }), Workspace),
  'workspace.setupFile': method(z.object({ workspaceId: Id }), z.object({ exists: z.boolean(), content: z.string() })),

  'settings.get': method(z.object({ key: z.string().min(1).max(100) }), z.object({ value: z.unknown() })),
  'settings.set': method(z.object({ key: z.string().min(1).max(100), value: z.unknown() }), Ok),

  'agents.status': method(z.object({ refresh: z.boolean().default(false) }), z.array(AgentStatus)),

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

  'workItems.list': method(z.object({ source: z.enum(['shortcut', 'github']), query: z.string().optional() }), z.array(WorkItem)),
});
export type HostApi = typeof hostApi;

export const SessionsChanged = z.object({ workspaceId: z.string(), session: Session });

/** Streams published by the host. */
export const hostTopics = defineTopics({
  'session.event': SessionEvent,
  'session.changed': SessionsChanged,
  'inbox.changed': z.array(NeedsYouItem),
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

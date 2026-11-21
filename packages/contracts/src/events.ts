import { z } from 'zod';
import { PermissionDecision, PermissionOption, SessionMode, SessionState, Usage } from './entities.ts';

/** Content a user sends in a prompt. Mapped onto ACP content blocks by the agent layer. */
export const PromptBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('resource'),
    uri: z.string(),
    name: z.string(),
    text: z.string(),
    mimeType: z.string().nullable(),
  }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
]);
export type PromptBlock = z.infer<typeof PromptBlock>;

export const ToolKind = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type ToolStatus = z.infer<typeof ToolStatus>;

export const ToolContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('diff'), path: z.string(), oldText: z.string().nullable(), newText: z.string() }),
  z.object({ type: z.literal('terminal'), terminalId: z.string() }),
]);
export type ToolContent = z.infer<typeof ToolContent>;

export const PlanEntry = z.object({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type PlanEntry = z.infer<typeof PlanEntry>;

export const AvailableCommand = z.object({ name: z.string(), description: z.string() });
export type AvailableCommand = z.infer<typeof AvailableCommand>;

const base = { sessionId: z.string(), seq: z.number().int().nonnegative(), ts: z.string() };

/**
 * Every event in a session. Persisted append-only; UI state is derived from these (see `projectSession`).
 * Raw chunks are streamed live but coalesced into one message event before storage.
 */
export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('user.message'), content: z.array(PromptBlock), queued: z.boolean() }),
  z.object({ ...base, type: z.literal('turn.started'), turnId: z.string(), index: z.number().int() }),
  z.object({
    ...base,
    type: z.literal('turn.ended'),
    turnId: z.string(),
    stopReason: z.string(),
    usage: Usage.nullable(),
  }),
  z.object({ ...base, type: z.literal('agent.message.chunk'), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal('agent.thought.chunk'), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal('agent.message'), messageId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal('agent.thought'), messageId: z.string(), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool.call'),
    toolCallId: z.string(),
    title: z.string(),
    kind: ToolKind,
    status: ToolStatus,
    content: z.array(ToolContent),
    locations: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal('tool.update'),
    toolCallId: z.string(),
    title: z.string().nullable(),
    status: ToolStatus.nullable(),
    content: z.array(ToolContent).nullable(),
  }),
  z.object({ ...base, type: z.literal('plan.updated'), entries: z.array(PlanEntry) }),
  /** HI-08: the agent took a screenshot of the preview; `file` is in ADE's screenshots folder. */
  z.object({ ...base, type: z.literal('preview.screenshot'), url: z.string(), file: z.string() }),
  z.object({
    ...base,
    type: z.literal('permission.requested'),
    requestId: z.string(),
    toolCallId: z.string(),
    title: z.string(),
    kind: ToolKind.nullable(),
    detail: z.string().nullable(),
    options: z.array(PermissionOption),
  }),
  z.object({
    ...base,
    type: z.literal('permission.decided'),
    requestId: z.string(),
    decision: PermissionDecision,
    decidedBy: z.string(),
    note: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal('commands.available'), commands: z.array(AvailableCommand) }),
  z.object({
    ...base,
    type: z.literal('mode.changed'),
    modeId: z.string(),
    available: z.array(SessionMode).nullable(),
  }),
  z.object({ ...base, type: z.literal('checkpoint.created'), turnId: z.string(), ref: z.string(), at: z.enum(['start', 'end']) }),
  z.object({
    ...base,
    type: z.literal('session.state_changed'),
    from: SessionState.nullable(),
    to: SessionState,
    reason: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal('session.landed'), mode: z.enum(['apply', 'commit']), files: z.array(z.string()) }),
  z.object({ ...base, type: z.literal('session.discarded'), patchPath: z.string().nullable() }),
  z.object({ ...base, type: z.literal('run.finished'), runId: z.string(), exitCode: z.number().int().nullable() }),
  z.object({ ...base, type: z.literal('notice'), level: z.enum(['info', 'warning', 'error']), text: z.string() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent['type'];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the store has assigned `seq` and `ts`. */
export type NewSessionEvent = DistributiveOmit<SessionEvent, 'seq' | 'ts'>;

/** Events that are streamed live but not persisted (they are coalesced into a message event). */
export const TRANSIENT_EVENTS: ReadonlySet<SessionEventType> = new Set(['agent.message.chunk', 'agent.thought.chunk']);

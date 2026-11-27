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

/**
 * GN-01: how a turn's prompt is generated before the agent sees it. `io` sends it as written. The others reason
 * first: `cot` asks for step-by-step reasoning; `cot-sc` samples several reasoning paths and keeps the most
 * consistent; `got` searches a graph of thoughts (generate, score, aggregate, refine); `foa` evolves a fleet of
 * candidate plans (genetic particle filtering). Extra reasoning runs the same agent read-only and changes nothing.
 */
export const ReasoningMethod = z.enum(['io', 'cot', 'cot-sc', 'got', 'foa']);
export type ReasoningMethod = z.infer<typeof ReasoningMethod>;

export const ReasoningSettings = z.object({
  method: ReasoningMethod,
  /** CoT-SC: reasoning paths sampled. */
  samples: z.number().int().min(2).max(7).default(3),
  /** Graph of Thought: thoughts generated at the first step. */
  branches: z.number().int().min(2).max(5).default(3),
  /** Fleet of Agents: agents in the fleet. */
  agents: z.number().int().min(2).max(6).default(3),
  /** Fleet of Agents: rounds of selection and mutation. */
  generations: z.number().int().min(1).max(3).default(1),
});
export type ReasoningSettings = z.infer<typeof ReasoningSettings>;

/** WA-10: the shapes of repetition loop watch recognises within one turn. */
export const LoopPattern = z.enum(['repeated-action', 'failing-command', 'edit-ping-pong']);
export type LoopPattern = z.infer<typeof LoopPattern>;
export const LoopLevel = z.enum(['warning', 'severe']);
export type LoopLevel = z.infer<typeof LoopLevel>;

/** RV-16: what a claim is about. `verified` is a general "I verified/tested it". */
export const VerifyCategory = z.enum(['tests', 'build', 'lint', 'types', 'verified']);
export type VerifyCategory = z.infer<typeof VerifyCategory>;
export const ClaimStatus = z.enum(['supported', 'stale', 'contradicted', 'unseen']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;
export const ReceiptClaim = z.object({
  category: VerifyCategory,
  /** The agent's sentence, cleaned and redacted. */
  quote: z.string().max(240),
  status: ClaimStatus,
  /** For example "npm test (exit 1)"; null when no such command was seen. */
  evidence: z.string().max(300).nullable(),
});
export type ReceiptClaim = z.infer<typeof ReceiptClaim>;
export const ReceiptFindingKind = z.enum(['phantom-edit', 'tests-skipped', 'tests-deleted', 'unreported-change']);
export type ReceiptFindingKind = z.infer<typeof ReceiptFindingKind>;
export const ReceiptFinding = z.object({
  kind: ReceiptFindingKind,
  /** `unreported-change` is a note; the rest are warnings. */
  level: z.enum(['warning', 'note']),
  paths: z.array(z.string().max(400)).max(20),
  /** Paths beyond the 20 listed. */
  more: z.number().int().nonnegative(),
  detail: z.string().max(300).nullable(),
});
export type ReceiptFinding = z.infer<typeof ReceiptFinding>;
export const ReceiptFacts = z.object({
  /** Null when a checkpoint of the turn is missing. */
  filesChanged: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  editsReported: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  commandsFailed: z.number().int().nonnegative(),
});
export type ReceiptFacts = z.infer<typeof ReceiptFacts>;
/** RV-16: one of ADE's own checks (RV-10) as a receipt records it. */
export const ReceiptCheck = z.object({
  name: z.string().max(200),
  categories: z.array(VerifyCategory).max(4),
  exitCode: z.number().int().nullable(),
});
export type ReceiptCheck = z.infer<typeof ReceiptCheck>;

export const ReasoningStepStatus = z.enum(['running', 'done', 'failed']);

/**
 * ED-05: where a user message came from. Set by the host when the message is sent; older events have none.
 * `reject-note` is the note sent after "Reject with a note"; `after-undo` the first prompt after an undone turn.
 */
export const MessageOrigin = z.enum(['composer', 'interrupt', 'review-comment', 'reject-note', 'loop-redirect', 'after-undo']);
export type MessageOrigin = z.infer<typeof MessageOrigin>;

const base = { sessionId: z.string(), seq: z.number().int().nonnegative(), ts: z.string() };

/**
 * Every event in a session. Persisted append-only; UI state is derived from these (see `projectSession`).
 * Raw chunks are streamed live but coalesced into one message event before storage.
 */
export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('user.message'), content: z.array(PromptBlock), queued: z.boolean(), origin: MessageOrigin.optional() }),
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
  /** TM-04: a command the agent asked ADE to run (ACP `terminal/create`). Its output streams live. */
  z.object({ ...base, type: z.literal('command.started'), terminalId: z.string(), command: z.string(), cwd: z.string() }),
  z.object({ ...base, type: z.literal('command.output'), terminalId: z.string(), chunk: z.string() }),
  /** The final output tail (secrets redacted); `killed` when someone stopped it before it finished. */
  z.object({
    ...base,
    type: z.literal('command.exited'),
    terminalId: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    output: z.string(),
    truncated: z.boolean(),
    killed: z.boolean(),
  }),
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
  /** GN-01: a reasoning run before a turn. Steps form a graph through `parents`. */
  z.object({ ...base, type: z.literal('reasoning.started'), runId: z.string(), method: ReasoningMethod, plannedCalls: z.number().int().nonnegative() }),
  z.object({
    ...base,
    type: z.literal('reasoning.step'),
    runId: z.string(),
    stepId: z.string(),
    phase: z.string(),
    label: z.string(),
    parents: z.array(z.string()),
    status: ReasoningStepStatus,
    score: z.number().nullable(),
    detail: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('reasoning.finished'),
    runId: z.string(),
    outcome: z.enum(['sent', 'cancelled', 'failed']),
    approach: z.string().nullable(),
    calls: z.number().int().nonnegative(),
  }),
  /** WA-10: the agent seems to be repeating itself in this turn. Recorded when a level is first reached. */
  z.object({
    ...base,
    type: z.literal('loop.detected'),
    turnId: z.string(),
    pattern: LoopPattern,
    subject: z.string().max(300),
    count: z.number().int().positive(),
    level: LoopLevel,
    detail: z.string().max(200).nullable(),
  }),
  /** WA-10: the user said it is not a loop; no more loop events in this turn. */
  z.object({ ...base, type: z.literal('loop.dismissed'), turnId: z.string() }),
  /** RV-16: what the agent said set against what ADE saw and Git changed, recorded when a turn ends normally. */
  z.object({
    ...base,
    type: z.literal('receipt.issued'),
    turnId: z.string(),
    turnIndex: z.number().int(),
    facts: ReceiptFacts,
    claims: z.array(ReceiptClaim).max(8),
    findings: z.array(ReceiptFinding).max(8),
    /** Categories (never `verified`) whose latest run in this turn passed after the last reported change. */
    passed: z.array(VerifyCategory).max(4),
  }),
  /** RV-16: ADE's own checks finished; they cover every turn up to `turnIndex`. */
  z.object({ ...base, type: z.literal('receipt.checked'), turnId: z.string(), turnIndex: z.number().int(), checks: z.array(ReceiptCheck).max(20) }),
  /** RV-16: the user marked that turn's receipt as checked. */
  z.object({ ...base, type: z.literal('receipt.acknowledged'), turnId: z.string() }),
  z.object({ ...base, type: z.literal('notice'), level: z.enum(['info', 'warning', 'error']), text: z.string() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent['type'];
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the store has assigned `seq` and `ts`. */
export type NewSessionEvent = DistributiveOmit<SessionEvent, 'seq' | 'ts'>;

/** Events that are streamed live but not persisted (they are coalesced into a message event). */
export const TRANSIENT_EVENTS: ReadonlySet<SessionEventType> = new Set(['agent.message.chunk', 'agent.thought.chunk', 'command.output']);

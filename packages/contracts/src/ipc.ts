import { z } from 'zod';
import {
  AgentId,
  AgentInstallPlan,
  AgentInstallState,
  AgentStatus,
  AuditEntry,
  FileChange,
  PermissionProfile,
  Run,
  RunConfig,
  Session,
  SessionState,
  Turn,
  WorkItem,
  WorkItemRole,
  CliSession,
  Workspace,
} from './entities.ts';
import { MessageOrigin, PromptBlock, ReasoningSettings, SessionEvent, ToolKind } from './events.ts';
import { Lesson, LessonAdvice, LessonDraft, LessonFiles, LessonRehearsal } from './lessons.ts';
import { defineApi, defineTopics, method } from './rpc.ts';
import { IntegrateChanged, IntegrateInputs, IntegrateLandItem, IntegrateLandResult, IntegrateOverview, IntegrateTrial } from './integrate.ts';

const Id = z.string().min(1).max(200);

/** SK-03: portable Agent Skills names (lower-case kebab case, 1 to 64 characters). */
export const SkillName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'use lower-case letters, digits and single dashes').max(64);
const AbsPath = z.string().min(1).max(4096);
const Ok = z.object({ ok: z.literal(true) });

const McpName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'use letters, digits, dashes and underscores');
const McpValues = z.record(z.string(), z.string()).default({});

/**
 * ST-05 / CO-10: an MCP server: a command (stdio) or a URL (streamable HTTP). Values may name environment variables
 * (`$NAME` or `${NAME}`), read from ADE's environment at launch, so no secret has to be written down.
 */
export const McpServerConfig = z.union([
  z.object({ name: McpName, command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]), env: McpValues }),
  z.object({ name: McpName, url: z.url({ protocol: /^https?$/ }), headers: McpValues }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** CO-13: where a server comes from: the user's own list, the repository's .ade/workspace.yaml, or ADE itself. */
export const McpSource = z.enum(['personal', 'workspace', 'built-in']);
export type McpSource = z.infer<typeof McpSource>;

/** CO-13: one server as the MCP manager lists it. Values of env and headers are never included, only their names. */
export const McpServerEntry = z.object({
  source: McpSource,
  name: z.string(),
  kind: z.enum(['stdio', 'http']),
  /** The command line or the URL. */
  target: z.string(),
  enabled: z.boolean(),
  editable: z.boolean(),
  checkable: z.boolean(),
  /** Variables or connections it needs that are missing; a server with any is not passed to agents. */
  missing: z.array(z.string()),
  keys: z.array(z.string()),
  note: z.string().nullable(),
  /** The full definition, for editing (personal servers only). */
  config: McpServerConfig.nullable(),
});
export type McpServerEntry = z.infer<typeof McpServerEntry>;

export const McpCheck = z.object({
  ok: z.boolean(),
  tools: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
  error: z.string().nullable(),
  ms: z.number(),
  checkedAt: z.string(),
});
export type McpCheck = z.infer<typeof McpCheck>;

/** HI-12: a branch in the branch graph. `ahead` and `behind` count commits against the checkout's HEAD. */
export const GitBranch = z.object({
  name: z.string(),
  kind: z.enum(['local', 'remote']),
  head: z.string(),
  current: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  /** The worktree this branch is checked out in, if any. */
  worktree: z.string().nullable(),
  session: z.object({ id: z.string(), title: z.string(), state: SessionState, agentId: z.string() }).nullable(),
});
export type GitBranch = z.infer<typeof GitBranch>;

export const GitCommit = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  /** Unix seconds. */
  time: z.number(),
  subject: z.string(),
  /** Branch, remote and tag names pointing here; `HEAD` marks the checkout. */
  refs: z.array(z.object({ name: z.string(), kind: z.enum(['head', 'local', 'remote', 'tag']) })),
});
export type GitCommit = z.infer<typeof GitCommit>;

export const GitGraph = z.object({
  head: z.string().nullable(),
  currentBranch: z.string().nullable(),
  branches: z.array(GitBranch),
  commits: z.array(GitCommit),
  truncated: z.boolean(),
});
export type GitGraph = z.infer<typeof GitGraph>;

/** HI-12: one commit in full, with the files it changed against its first parent (or against nothing, for a root). */
export const GitCommitDetail = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  time: z.number(),
  committer: z.string(),
  committerTime: z.number(),
  message: z.string(),
  files: z.array(FileChange),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetail>;

const CommitHash = z.string().regex(/^[0-9a-f]{7,64}$/, 'a commit hash');

/** Secrets main keeps in the OS credential store and hands to the host in memory (rule 7). */
export const ConnectorSecret = z.enum(['shortcut', 'github', 'telegram', 'telegram-password']);
export type ConnectorSecret = z.infer<typeof ConnectorSecret>;

/**
 * CO-12: the Telegram notifier. `active` is true while ADE is listening to the bot; `chats` counts the chats signed
 * in with /auth (in memory only, for at most three hours each). Never carries the token or the password.
 */
export const TelegramStatus = z.object({
  tokenStored: z.boolean(),
  passwordSet: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  bot: z.string().nullable(),
  chats: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type TelegramStatus = z.infer<typeof TelegramStatus>;

/** GN-02: one text box on the prompt board. Position and size are in board pixels. */
export const PromptBox = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
  text: z.string().max(100_000),
  x: z.number().min(0).max(20_000),
  y: z.number().min(0).max(20_000),
  w: z.number().min(160).max(4000),
  h: z.number().min(96).max(4000),
  /** Selected boxes are the prompt's input, in reading order (top to bottom, then left to right). */
  selected: z.boolean(),
});
export type PromptBox = z.infer<typeof PromptBox>;

/** GN-01 / GN-02: a session's composer, kept across restarts: chat or board, and the generation method. */
export const ComposerState = z.object({
  mode: z.enum(['chat', 'board']),
  reasoning: ReasoningSettings,
});
export type ComposerState = z.infer<typeof ComposerState>;

/** GN-02: the prompt board, shared by every session of a workspace and kept across restarts. */
export const PromptBoxes = z.array(PromptBox).max(100);

/** WA-10: loop watch. Stored under the settings key `loops`; read with `LoopSettings.parse(value ?? {})`. */
export const LoopSettings = z.object({ enabled: z.boolean().default(true), stopTurn: z.boolean().default(false) });
export type LoopSettings = z.infer<typeof LoopSettings>;

/** RV-16: turn receipts. Stored under the settings key `receipts`; read with `ReceiptSettings.parse(value ?? {})`. */
export const ReceiptSettings = z.object({ enabled: z.boolean().default(true), notify: z.boolean().default(true) });
export type ReceiptSettings = z.infer<typeof ReceiptSettings>;

export const NeedsYouItem = z.object({
  id: z.string(),
  /** The session the item belongs to; for workflow items, the run's latest session or an empty string. */
  sessionId: z.string(),
  sessionTitle: z.string(),
  kind: z.enum(['permission', 'question', 'setup-failed', 'interrupted', 'limit', 'gate', 'paused', 'loop', 'review', 'reviewed']),
  /** AP-07: set for pull requests waiting on the user's review (`sessionId` is then empty). */
  url: z.string().url().optional(),
  /** AP-08: for `reviewed` items, the pull request and its latest review; a newer review brings a dismissed one back. */
  reviewKey: z.string().optional(),
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
  /** GN-01: how the first prompt is generated. Anything but IO reasons once the session is ready, then sends. */
  reasoning: ReasoningSettings.optional(),
  /** SR-10: continue this conversation from the agent's own CLI (its ACP session id) instead of starting a new one. */
  continueFrom: z.string().min(1).max(300).optional(),
  /** ED-05: the first-prompt lessons to send; left out, every enabled one is sent. */
  lessonIds: z.array(Id).max(50).optional(),
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

/** RV-10: which run configurations are a workspace's checks, and whether they run after every turn. */
export const CheckSettings = z.object({ configIds: z.array(Id).max(20), afterTurn: z.boolean() });
export type CheckSettings = z.infer<typeof CheckSettings>;

export const CheckResult = z.object({
  configId: z.string(),
  name: z.string(),
  command: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  /** The end of the output. */
  output: z.string(),
  runId: z.string(),
  finishedAt: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** RV-11: how far the user's checkout moved since the session started, and what would conflict. */
export const BaseStatus = z.object({
  base: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  behind: z.number().int(),
  conflicts: z.array(z.string()),
});
export type BaseStatus = z.infer<typeof BaseStatus>;

/** RV-14: a second agent's read-only pre-review. */
export const ReviewAssessment = z.object({
  agentId: AgentId,
  ranking: z.array(z.object({ path: z.string(), risk: z.enum(['high', 'medium', 'low']), reason: z.string() })),
  /** The agent's reply, shown when it could not be read as a ranking. */
  raw: z.string(),
  createdAt: z.string(),
});
export type ReviewAssessment = z.infer<typeof ReviewAssessment>;

/** RV-15: one file's diff against the base, as `git diff --raw` identifies it: "<oldMode> <newMode> <oldSha> <newSha>". */
export const ReviewFingerprint = z.string().regex(/^[0-7]{6} [0-7]{6} [0-9a-f]{40,64} [0-9a-f]{40,64}$/);
/** RV-15: not reviewed, reviewed as it is now, or changed since it was reviewed. */
export const ReviewState = z.enum(['unreviewed', 'reviewed', 'changed']);
export type ReviewState = z.infer<typeof ReviewState>;
/** RV-15: the review state of every file in a session's change set (all turns). */
export const ReviewProgress = z.object({
  files: z.array(z.object({ path: z.string(), fingerprint: ReviewFingerprint, state: ReviewState, markedAt: z.string().nullable() })),
  reviewed: z.number().int(),
  total: z.number().int(),
});
export type ReviewProgress = z.infer<typeof ReviewProgress>;

/** CO-05 and CO-08: what ADE does to a session's work item. Shortcut moves name workflow state ids. Off by default. */
export const SyncSettings = z.object({
  moveOnStart: z.number().int().nullable(),
  moveOnPullRequest: z.number().int().nullable(),
  moveOnMerge: z.number().int().nullable(),
  /** Post a summary (and the pull request link) to the work item when the session lands or opens a pull request. */
  progressNotes: z.boolean(),
  /** Add "Closes <issue>" to pull requests for GitHub issues, so GitHub closes them on merge. */
  closeIssues: z.boolean(),
});
export type SyncSettings = z.infer<typeof SyncSettings>;

/** CO-06 and CO-07: a session's pull request as GitHub reports it. */
export const PullRequestStatus = z.object({
  url: z.string(),
  number: z.number().int().nullable(),
  state: z.string(),
  reviewDecision: z.string().nullable(),
  checks: z.array(z.object({ name: z.string(), bucket: z.string(), link: z.string(), workflow: z.string() })),
});
export type PullRequestStatus = z.infer<typeof PullRequestStatus>;

/** CO-09: a Shortcut iteration or a GitHub Projects board, with the sessions working on each item. */
export const BoardSettings = z.object({
  source: z.enum(['shortcut', 'github']),
  /** CO-09: the repository chosen first ("owner/name"); the board shows only its items. */
  githubRepo: z.string().max(200).nullable().default(null),
  /** The project's owner and number; both null shows the repository's open issues and pull requests. */
  githubOwner: z.string().max(100).nullable(),
  githubProject: z.number().int().positive().nullable(),
});
export type BoardSettings = z.infer<typeof BoardSettings>;

export const Board = z.object({
  title: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      items: z.array(
        z.object({
          ref: z.string(),
          title: z.string(),
          url: z.string().nullable(),
          sessions: z.array(z.object({ id: z.string(), title: z.string(), state: z.string() })),
        }),
      ),
    }),
  ),
});
export type Board = z.infer<typeof Board>;

/**
 * CO-14: what ADE can see of the user's GitHub and Shortcut set-up, so an empty work item screen can say what
 * is missing. Read locally from `gh` and `git config`; nothing is sent anywhere.
 */
export const ConnectionStatus = z.object({
  github: z.object({
    cli: z.object({ installed: z.boolean(), version: z.string().nullable() }),
    /** The account `gh` (or a stored token) signs in as; null when it is not signed in. */
    account: z.object({ login: z.string(), id: z.number().int().nullable(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
    tokenStored: z.boolean(),
    /** Why the account could not be read, as `gh` put it. */
    problem: z.string().nullable(),
  }),
  shortcut: z.object({ tokenStored: z.boolean() }),
  /** The identity Git commits with, from the open repository's config (or the global one). */
  git: z.object({ installed: z.boolean(), name: z.string().nullable(), email: z.string().nullable() }),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** SM-11: one command from a terminal, a run or an agent. */
export const HistoryEntry = z.object({
  command: z.string(),
  cwd: z.string().nullable(),
  source: z.enum(['terminal', 'run', 'agent']),
  sessionId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  at: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** SM-18: one problem ADE recognised in a finished command block (an error, a warning or a failed test). */
export const ProblemTool = z.enum(['tsc', 'eslint', 'cc', 'msbuild', 'rustc', 'python', 'pytest', 'jstest', 'gotest']);
export type ProblemTool = z.infer<typeof ProblemTool>;
export const Problem = z.object({
  tool: ProblemTool,
  severity: z.enum(['error', 'warning', 'failure']),
  /** Relative to the worktree root with `/` when `inside`; otherwise the path as the tool printed it. */
  path: z.string().max(1024).nullable(),
  inside: z.boolean(),
  line: z.number().int().positive().nullable(),
  column: z.number().int().positive().nullable(),
  code: z.string().max(200).nullable(),
  message: z.string().max(500),
  /** Tool, path and code (or the normalised message); never the line, so a moved problem keeps its identity. */
  fingerprint: z.string().max(1500),
});
export type Problem = z.infer<typeof Problem>;

/** SM-18: the problems of one run of a command in one scope (a session worktree, or the checkout when null). */
export const ProblemSnapshot = z.object({
  commandKey: z.string().max(500),
  sessionId: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  turnCount: z.number().int().nullable(),
  cut: z.boolean(),
  at: z.string(),
  problems: z.array(Problem).max(500),
});
export type ProblemSnapshot = z.infer<typeof ProblemSnapshot>;

/** SM-13: the terminals of a workspace with their scrollback, restored on request. */
export const TerminalLayout = z.object({
  terminals: z
    .array(
      z.object({
        kind: z.enum(['smart', 'plain']),
        shell: z.string().max(40).nullable(),
        cwd: AbsPath,
        sessionId: z.string().nullable(),
        title: z.string().max(200),
        scrollback: z.string().max(200_000),
      }),
    )
    .max(12),
  activeIndex: z.number().int().min(-1),
  savedAt: z.string(),
});
export type TerminalLayout = z.infer<typeof TerminalLayout>;

/** CR-11: a named set of variables for runs. Secret values live in the OS credential store, never here. */
export const EnvSet = z.object({
  id: Id,
  name: z.string().trim().min(1).max(100),
  vars: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'use letters, digits and underscores').max(100),
        /** Plain value; empty for secrets. */
        value: z.string().max(10_000),
        secret: z.boolean(),
      }),
    )
    .max(100),
});
export type EnvSet = z.infer<typeof EnvSet>;

export const ScratchLanguage = z.enum(['javascript', 'typescript', 'python', 'csharp']);
export type ScratchLanguage = z.infer<typeof ScratchLanguage>;

/** ED-04: which instruction files each agent reads in a repository, and where they disagree. */
export const InstructionStatus = z.object({
  agents: z.array(
    z.object({
      agentId: AgentId,
      files: z.array(z.object({ path: z.string(), scope: z.enum(['project', 'user', 'nested']), note: z.string().nullable() })),
    }),
  ),
  problems: z.array(z.string()),
});
export type InstructionStatus = z.infer<typeof InstructionStatus>;

/** HI-06: sessions whose conversation matches a search, with snippets. */
export const SessionSearchResult = z.object({
  sessionId: z.string(),
  title: z.string(),
  agentId: AgentId,
  state: z.string(),
  matches: z.array(z.object({ kind: z.enum(['you', 'agent', 'tool', 'notice']), snippet: z.string(), at: z.string() })),
});
export type SessionSearchResult = z.infer<typeof SessionSearchResult>;

/** ED-03: a diagnostic from a language server, zero-based like LSP. */
export const LspDiagnostic = z.object({
  line: z.number().int(),
  character: z.number().int(),
  endLine: z.number().int(),
  endCharacter: z.number().int(),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  message: z.string(),
  source: z.string().nullable(),
});
export type LspDiagnostic = z.infer<typeof LspDiagnostic>;

const LspPosition = z.object({ path: AbsPath, line: z.number().int().min(0), character: z.number().int().min(0) });

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

/** AP-09: what kind of command a shape is. `never` is not offered as an allow rule. */
export const RuleRisk = z.enum(['read', 'project', 'exact', 'never']);
export type RuleRisk = z.infer<typeof RuleRisk>;
export const RuleCaveat = z.enum(['repo-script', 'not-a-sandbox']);
export type RuleCaveat = z.infer<typeof RuleCaveat>;
export const RuleExample = z.object({ text: z.string().max(300), count: z.number().int().positive() });
export type RuleExample = z.infer<typeof RuleExample>;
export const RuleConflict = z.object({
  text: z.string().max(300),
  ts: z.string(),
  sessionTitle: z.string().max(200),
  decided: z.enum(['allowed', 'rejected']),
});
export type RuleConflict = z.infer<typeof RuleConflict>;
/** AP-09: a rule replayed over the requests the user decided by hand in this repository. */
export const RuleRehearsal = z.object({
  /** Requests the user answered by hand, in the history window. */
  considered: z.number().int().nonnegative(),
  /** Of those, the ones this rule would have answered. */
  wouldAnswer: z.number().int().nonnegative(),
  agree: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  conflicts: z.array(RuleConflict).max(5),
  covers: z.array(RuleExample).max(10),
  moreCovers: z.number().int().nonnegative(),
  /** The text matches, but the chain rule keeps asking. */
  heldBack: z.number().int().nonnegative(),
  /** Agent ids among the answered requests. */
  agents: z.array(z.string()).max(10),
});
export type RuleRehearsal = z.infer<typeof RuleRehearsal>;
export const RuleSuggestion = z.object({
  /** `<decision>:<shape key>`. */
  key: z.string().max(200),
  decision: z.enum(['allow', 'deny']),
  kind: z.literal('execute'),
  /** Recommended: the narrowest pattern that covers the evidence. */
  pattern: z.string().max(500),
  /** `<stem> *` when `pattern` is exact and the risk allows it. */
  wider: z.string().max(500).nullable(),
  risk: RuleRisk,
  caveats: z.array(RuleCaveat).max(4),
  evidence: z.object({
    allowed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    agents: z.array(z.string()).max(10),
    lastTs: z.string(),
    lastRequestId: z.string(),
  }),
  rehearsal: RuleRehearsal,
});
export type RuleSuggestion = z.infer<typeof RuleSuggestion>;
export const RuleUsage = z.object({
  ruleId: Id,
  answered: z.number().int().nonnegative(),
  lastTs: z.string().nullable(),
  /** The rule is at least 30 days old and has not answered in 30 days. */
  unused: z.boolean(),
  /** Commands it answered that the user never approved by hand. */
  unseen: z.array(RuleExample).max(10),
  rehearsal: RuleRehearsal,
});
export type RuleUsage = z.infer<typeof RuleUsage>;
/** Stored under the settings key `ruleAdvice`; read with `RuleAdviceSettings.parse(value ?? {})`. */
export const RuleAdviceSettings = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().int().min(2).max(20).default(3),
});
export type RuleAdviceSettings = z.infer<typeof RuleAdviceSettings>;
export const RuleAdvice = z.object({
  suggestions: z.array(RuleSuggestion).max(10),
  usage: z.array(RuleUsage).max(200),
  requests: z.number().int().nonnegative(),
});
export type RuleAdvice = z.infer<typeof RuleAdvice>;

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
  /** WF-17: `cycle` marks the edge that closes a cycle; `maxRounds` is then how often the run may go round it. */
  edges: z.array(z.object({ from: z.string(), to: z.string(), when: z.enum(['pass', 'fail']).nullable(), cycle: z.boolean().default(false), maxRounds: z.number().int().nullable().default(null) })),
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
  /** WF-16: every step running or waiting at a gate (parallel branches). */
  active: z.array(z.string()).default([]),
  /** WF-17: rounds used per cycle, keyed by the index of the edge that closes it. */
  rounds: z.record(z.string(), z.number()).default({}),
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
  'agents.installPlans': method(z.object({}), z.array(AgentInstallPlan)),
  /** Starts the install and returns at once; progress arrives on the `agents.install` topic. */
  'agents.install': method(z.object({ agentId: AgentId }), AgentInstallState),
  'agents.installStates': method(z.object({}), z.array(AgentInstallState)),
  'containment.status': method(z.object({ refresh: z.boolean().default(false) }), ContainmentStatus),
  'commands.list': method(z.object({ workspaceId: Id }), z.array(SavedCommand)),
  'commands.save': method(z.object({ workspaceId: Id, commands: z.array(SavedCommand).max(100) }), Ok),
  'rules.list': method(z.object({ workspaceId: Id }), z.array(PermissionRule)),
  'rules.save': method(z.object({ workspaceId: Id, rules: z.array(PermissionRule).max(200) }), Ok),
  /** AP-09: rule suggestions from the user's decisions, and each rule's usage and rehearsal. */
  'rules.advice': method(z.object({ workspaceId: Id }), RuleAdvice),
  'rules.rehearse': method(z.object({ workspaceId: Id, rule: PermissionRule }), RuleRehearsal),
  'rules.adopt': method(z.object({ workspaceId: Id, key: z.string().min(1).max(200), rule: PermissionRule }), Ok),
  'rules.dismissSuggestion': method(z.object({ workspaceId: Id, key: z.string().min(1).max(200), forever: z.boolean() }), Ok),
  /** ED-05: lessons in the user's own words, delivered to every agent; suggestions from repeated corrections. */
  'lessons.list': method(z.object({ workspaceId: Id }), z.array(Lesson)),
  'lessons.save': method(z.object({ workspaceId: Id, lessons: z.array(Lesson).max(50) }), Ok),
  'lessons.advice': method(z.object({ workspaceId: Id }), LessonAdvice),
  /** `key` is a suggestion's key, or "manual" for a lesson added without evidence. */
  'lessons.adopt': method(z.object({ workspaceId: Id, key: z.string().min(1).max(200), lesson: LessonDraft }), Lesson),
  'lessons.dismiss': method(z.object({ workspaceId: Id, key: z.string().min(1).max(200), forever: z.boolean() }), Ok),
  'lessons.rehearse': method(z.object({ workspaceId: Id, pattern: z.string().trim().min(1).max(500) }), LessonRehearsal),
  /** Writes the marked block into AGENTS.md (and CLAUDE.md when asked) in the checkout, as an uncommitted change. */
  'lessons.writeFiles': method(z.object({ workspaceId: Id, alsoClaude: z.boolean().default(false) }), LessonFiles),

  'sessions.list': method(z.object({ workspaceId: Id }), z.array(Session)),
  'sessions.get': method(z.object({ sessionId: Id }), SessionDetail),
  'sessions.create': method(CreateSessionInput, Session),
  /** HI-13: deletes ended (landed or discarded) sessions and their stored history; all ended ones without ids. */
  'sessions.deleteEnded': method(z.object({ workspaceId: Id, sessionIds: z.array(Id).min(1).max(500).optional() }), z.object({ deleted: z.array(Id) })),
  /** SR-10: conversations started in the agents' own CLIs in this repository, newest first, that ADE can continue. */
  'sessions.cliList': method(
    z.object({ workspaceId: Id }),
    z.object({ sessions: z.array(CliSession), problems: z.array(z.object({ agentId: AgentId, message: z.string() })) }),
  ),
  'sessions.prompt': method(z.object({ sessionId: Id, content: z.array(PromptBlock).min(1), origin: MessageOrigin.optional() }), Ok),
  /**
   * GN-01: sends a prompt through a reasoning method. `io` behaves like `sessions.prompt`; the others reason in the
   * background (progress arrives as `reasoning.*` events) and then send the result. `reasoning` is true when that
   * background run started.
   */
  'sessions.promptReasoned': method(
    z.object({ sessionId: Id, content: z.array(PromptBlock).min(1), settings: ReasoningSettings }),
    z.object({ reasoning: z.boolean() }),
  ),
  'sessions.queue': method(z.object({ sessionId: Id, content: z.array(PromptBlock).min(1), origin: MessageOrigin.optional() }), z.object({ id: z.string() })),
  'sessions.unqueue': method(z.object({ sessionId: Id, id: Id }), Ok),
  'sessions.editQueued': method(z.object({ sessionId: Id, id: Id, content: z.array(PromptBlock).min(1) }), Ok),
  'sessions.cancel': method(z.object({ sessionId: Id }), Ok),
  /** WA-10: "Not a loop": no more loop warnings in the session's current turn. */
  'sessions.dismissLoop': method(z.object({ sessionId: Id }), Ok),
  /** RV-16: "Mark as checked": closes every open item of that turn's receipt. */
  'sessions.acknowledgeReceipt': method(z.object({ sessionId: Id, turnId: z.string().min(1).max(200) }), Ok),
  /** TM-04: stops a command the agent is running through ADE. `killed` is false when it had already ended. */
  'sessions.killCommand': method(z.object({ sessionId: Id, terminalId: z.string().min(1).max(200) }), z.object({ killed: z.boolean() })),
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
  'sessions.baseStatus': method(z.object({ sessionId: Id }), BaseStatus),
  /** RV-11: moves the session onto the checkout's current commit; conflicts stay as markers for the agent. */
  'sessions.rebase': method(z.object({ sessionId: Id, askAgent: z.boolean().default(false) }), BaseStatus),
  /** RV-12: commit the selected files, push the branch and open a pull request with the GitHub CLI. */
  'sessions.pullRequest': method(
    z.object({
      sessionId: Id,
      files: z.array(z.string()).min(1),
      title: z.string().trim().min(1).max(250),
      body: z.string().max(60_000).default(''),
      message: z.string().max(10_000).optional(),
      draft: z.boolean().default(false),
    }),
    z.object({ url: z.string() }),
  ),
  /** RV-13: asks the session's own agent for a commit message (one turn in the timeline). */
  'sessions.draftCommitMessage': method(z.object({ sessionId: Id, hint: z.string().max(2000).optional() }), z.object({ message: z.string() })),
  /** RV-14: another agent pre-reviews the diff read-only and ranks files by risk. */
  'sessions.reviewAssist': method(z.object({ sessionId: Id, agentId: AgentId, focus: z.string().max(2000).optional() }), ReviewAssessment),
  'sessions.reviewAssessment': method(z.object({ sessionId: Id }), ReviewAssessment.nullable()),
  'sessions.reviewProgress': method(z.object({ sessionId: Id }), ReviewProgress),
  'sessions.markReviewed': method(
    z.object({ sessionId: Id, files: z.array(z.object({ path: z.string().min(1).max(4096), fingerprint: ReviewFingerprint })).min(1).max(5000) }),
    ReviewProgress,
  ),
  'sessions.unmarkReviewed': method(z.object({ sessionId: Id, paths: z.array(z.string().min(1).max(4096)).min(1).max(5000) }), ReviewProgress),
  'sessions.diffSinceReviewed': method(z.object({ sessionId: Id, path: z.string().min(1).max(4096) }), DiffText),
  'sessions.pullRequestStatus': method(z.object({ sessionId: Id }), PullRequestStatus.nullable()),
  /** RV-12: commits what changed since and pushes it to the open pull request's branch. */
  'sessions.pushUpdate': method(z.object({ sessionId: Id, message: z.string().trim().min(1).max(10_000) }), Ok),
  /** CO-06: the pull request's review comments, as one prompt. */
  'sessions.sendReviewComments': method(z.object({ sessionId: Id }), z.object({ count: z.number().int() })),
  /** CO-07: failing GitHub Actions jobs and their logs, as one prompt. */
  'sessions.sendFailedChecks': method(z.object({ sessionId: Id }), z.object({ count: z.number().int() })),
  'sync.settings': method(z.object({ workspaceId: Id }), SyncSettings),
  'sync.save': method(z.object({ workspaceId: Id, settings: SyncSettings }), Ok),
  'connectors.status': method(z.object({ workspaceId: Id.nullable() }), ConnectionStatus),
  'connectors.shortcutStates': method(z.object({}), z.array(z.object({ id: z.number().int(), name: z.string(), type: z.string() }))),
  'board.settings': method(z.object({ workspaceId: Id }), BoardSettings),
  'board.save': method(z.object({ workspaceId: Id, settings: BoardSettings }), Ok),
  'board.get': method(z.object({ workspaceId: Id }), Board),
  /** CO-09: repositories to pick from: this workspace's own GitHub repository first, then the user's. */
  'board.repositories': method(z.object({ workspaceId: Id }), z.object({ current: z.string().nullable(), repos: z.array(z.string()) })),
  /** CO-09: the GitHub projects linked to a repository. `problem` explains an empty list (for example a missing scope). */
  'board.projects': method(
    z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
    z.object({ projects: z.array(z.object({ owner: z.string(), number: z.number(), title: z.string() })), problem: z.string().nullable() }),
  ),
  /** CO-10: personal MCP servers (YAML, the same shape as `mcpServers` in .ade/workspace.yaml) for every session. */
  'mcp.personal': method(z.object({}), z.object({ yaml: z.string() })),
  'mcp.savePersonal': method(z.object({ yaml: z.string().max(20_000) }), Ok),
  /** CO-13: every server a session in this workspace would receive, with its status. */
  'mcp.list': method(
    z.object({ workspaceId: Id.nullable() }),
    z.object({ servers: z.array(McpServerEntry), workspaceFile: z.object({ path: z.string(), exists: z.boolean(), error: z.string().nullable() }).nullable() }),
  ),
  /** Adds a personal server, or replaces the one called `original`. */
  'mcp.save': method(z.object({ original: McpName.nullable(), server: McpServerConfig }), Ok),
  'mcp.remove': method(z.object({ name: McpName }), Ok),
  'mcp.setEnabled': method(z.object({ workspaceId: Id.nullable(), source: McpSource, name: z.string().min(1).max(64), enabled: z.boolean() }), Ok),
  /** Connects to the server, lists its tools and disconnects. A command runs on this machine for the check. */
  'mcp.check': method(z.object({ workspaceId: Id.nullable(), source: McpSource, name: z.string().min(1).max(64) }), McpCheck),
  'history.record': method(
    z.object({ workspaceId: Id.nullable(), sessionId: Id.nullable(), command: z.string().min(1).max(10_000), cwd: z.string().max(4096).nullable(), exitCode: z.number().int().nullable() }),
    Ok,
  ),
  /**
   * SM-18: stores the problems of a finished block and returns the previous snapshot of the same command in the same
   * scope, read before this one is stored, and (for a session) the checkout's latest. Stores nothing for a command
   * that has no problems and never had any.
   */
  'problems.record': method(
    z.object({
      workspaceId: Id,
      sessionId: Id.nullable(),
      commandKey: z.string().trim().min(1).max(500),
      exitCode: z.number().int().nullable(),
      turnCount: z.number().int().nonnegative().nullable(),
      cut: z.boolean(),
      problems: z.array(Problem).max(500),
    }),
    z.object({ previous: ProblemSnapshot.nullable(), checkout: ProblemSnapshot.nullable() }),
  ),
  'history.search': method(z.object({ workspaceId: Id.optional(), query: z.string().max(500) }), z.array(HistoryEntry)),
  /** HI-13: forgets commands typed in terminals (the given ones, or all). Runs and agent commands go with their run or session. */
  'history.clear': method(z.object({ workspaceId: Id.optional(), commands: z.array(z.string().max(10_000)).min(1).max(500).optional() }), z.object({ deleted: z.number().int() })),
  /** SM-10: an agent drafts one command for a question, read-only; it is never run without the user. */
  'terminal.draftCommand': method(
    z.object({ agentId: AgentId, question: z.string().trim().min(1).max(2000), cwd: AbsPath, shell: z.string().max(40) }),
    z.object({ command: z.string().nullable(), reply: z.string() }),
  ),
  'files.readImage': method(z.object({ path: AbsPath }), z.object({ dataUrl: z.string() })),
  'composer.get': method(z.object({ sessionId: Id }), ComposerState.nullable()),
  'composer.save': method(z.object({ sessionId: Id, state: ComposerState }), Ok),
  /** HI-12: the repository's branches and their commits, newest first in topological order. Read-only. */
  'git.graph': method(z.object({ workspaceId: Id, limit: z.number().int().min(20).max(2000).default(400), remotes: z.boolean().default(false) }), GitGraph),
  'git.commit': method(z.object({ workspaceId: Id, hash: CommitHash }), GitCommitDetail),
  /** One file of a commit, before and after (the first parent's version on the left). */
  'git.commitDiff': method(z.object({ workspaceId: Id, hash: CommitHash, path: z.string().min(1).max(4096), oldPath: z.string().max(4096).nullable() }), DiffText),
  'telegram.status': method(z.object({}), TelegramStatus),
  'telegram.setEnabled': method(z.object({ enabled: z.boolean() }), TelegramStatus),
  /** Sends a test message to every signed-in chat. */
  'telegram.test': method(z.object({}), z.object({ sent: z.number().int() })),
  'promptBoard.get': method(z.object({ workspaceId: Id }), PromptBoxes),
  'promptBoard.save': method(z.object({ workspaceId: Id, boxes: PromptBoxes }), Ok),
  'layout.get': method(z.object({ workspaceId: Id }), TerminalLayout.nullable()),
  'layout.save': method(z.object({ workspaceId: Id, layout: TerminalLayout }), Ok),
  /** CR-07: writes a snippet into a fresh scratch folder and says how to run it (and whether that is sandboxed). */
  'scratch.prepare': method(
    z.object({ language: ScratchLanguage, code: z.string().max(200_000) }),
    z.object({ dir: z.string(), file: z.string(), command: z.array(z.string()), env: z.record(z.string(), z.string()), sandboxed: z.boolean(), note: z.string().nullable() }),
  ),
  /** CR-05: a selection saved as a file next to nothing, so it can run with the file's interpreter. */
  'scratch.write': method(z.object({ extension: z.string().regex(/^[a-z0-9]{1,8}$/), content: z.string().max(200_000) }), z.object({ path: z.string() })),
  'envSets.list': method(z.object({ workspaceId: Id }), z.array(EnvSet)),
  'envSets.save': method(z.object({ workspaceId: Id, sets: z.array(EnvSet).max(50) }), Ok),
  'instructions.status': method(z.object({ workspaceId: Id }), InstructionStatus),
  'history.sessions': method(z.object({ workspaceId: Id.optional(), query: z.string().trim().min(2).max(500) }), z.array(SessionSearchResult)),
  /** HI-07: the audit log as JSON with secrets and local paths redacted. */
  'audit.export': method(z.object({ workspaceId: Id }), z.object({ fileName: z.string(), content: z.string() })),
  'lsp.open': method(z.object({ path: AbsPath, text: z.string().max(5_000_000) }), z.object({ server: z.string().nullable(), reason: z.string().nullable() })),
  'lsp.change': method(z.object({ path: AbsPath, text: z.string().max(5_000_000) }), Ok),
  'lsp.close': method(z.object({ path: AbsPath }), Ok),
  'lsp.diagnostics': method(z.object({ path: AbsPath }), z.array(LspDiagnostic)),
  'lsp.hover': method(LspPosition, z.object({ contents: z.string() }).nullable()),
  'lsp.definition': method(LspPosition, z.array(z.object({ path: z.string(), line: z.number().int(), character: z.number().int() }))),
  /** HI-08: a screenshot the agent took of the preview, for the timeline. */
  'screenshots.read': method(z.object({ file: z.string().regex(/^[\w-]+\.png$/) }), z.object({ dataUrl: z.string() })),
  'checks.settings': method(z.object({ workspaceId: Id }), CheckSettings),
  'checks.saveSettings': method(z.object({ workspaceId: Id, settings: CheckSettings }), Ok),
  'checks.run': method(z.object({ sessionId: Id }), z.array(CheckResult)),
  'checks.results': method(z.object({ sessionId: Id }), z.array(CheckResult)),
  /** PL-04: live sessions in a workspace that changed the same files. */
  'sessions.overlaps': method(
    z.object({ workspaceId: Id }),
    z.array(z.object({ sessionId: z.string(), otherSessionId: z.string(), files: z.array(z.string()) })),
  ),
  'sessions.detach': method(z.object({ sessionId: Id }), z.object({ agentSessionId: z.string().nullable() })),

  'inbox.list': method(z.object({}), z.array(NeedsYouItem)),
  /** AP-08: squash and merge one of the user's reviewed pull requests (only from its button in Needs you). */
  'github.squashMerge': method(z.object({ url: z.string().url().max(500) }), Ok),
  /** AP-08: hide a reviewed pull request until it is reviewed again. */
  'github.dismissReview': method(z.object({ url: z.string().url().max(500) }), Ok),

  'files.list': method(z.object({ root: AbsPath }), z.array(FileEntry)),
  'files.read': method(z.object({ path: AbsPath }), FileContent),
  'files.write': method(
    z.object({ path: AbsPath, content: z.string(), expectedMtimeMs: z.number().nullable(), sessionId: Id.optional() }),
    z.union([z.object({ ok: z.literal(true), mtimeMs: z.number() }), z.object({ ok: z.literal(false), conflict: z.literal(true) })]),
  ),

  'runs.configs': method(z.object({ workspaceId: Id }), z.array(RunConfig)),
  'runs.saveConfig': method(RunConfig.omit({ id: true, source: true }).extend({ id: Id.optional() }), RunConfig),
  /** `workspaceId` names the workspace when the folder is outside it (scratchpad and selection runs). */
  'runs.record': method(Run.omit({ id: true }).extend({ workspaceId: Id.optional() }), Run),
  'runs.history': method(z.object({ workspaceId: Id }), z.array(Run)),
  /** CR-15: deletes the given runs from the workspace's history, or all of them when `runIds` is left out. */
  'runs.delete': method(z.object({ workspaceId: Id, runIds: z.array(Id).min(1).max(500).optional() }), z.object({ deleted: z.number().int() })),

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
  /** HI-13: deletes finished runs (succeeded, failed or cancelled); all finished ones without ids. */
  'workflows.deleteRuns': method(z.object({ workspaceId: Id, runIds: z.array(Id).min(1).max(500).optional() }), z.object({ deleted: z.number().int() })),
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
  'workItems.list': method(z.object({ source: z.enum(['shortcut', 'github']), query: z.string().optional(), role: WorkItemRole.default('owner') }), z.array(WorkItem)),
  /** PL-06: how ready sessions fit together, a trial merge in order, and landing them in order. */
  'integrate.overview': method(IntegrateInputs.overview, IntegrateOverview),
  'integrate.trial': method(IntegrateInputs.trial, IntegrateTrial),
  'integrate.get': method(IntegrateInputs.get, IntegrateTrial),
  'integrate.current': method(IntegrateInputs.current, IntegrateTrial.nullable()),
  'integrate.cancel': method(IntegrateInputs.cancel, Ok),
  'integrate.resolvePrompt': method(IntegrateInputs.resolvePrompt, z.object({ prompt: z.string(), onto: z.string() })),
  'integrate.resolve': method(IntegrateInputs.resolve, Ok),
  'integrate.landPreview': method(IntegrateInputs.landPreview, z.array(IntegrateLandItem)),
  'integrate.land': method(IntegrateInputs.land, IntegrateLandResult),
});
export type HostApi = typeof hostApi;

export const SessionsChanged = z.object({ workspaceId: z.string(), session: Session });

/** Streams published by the host. */
export const hostTopics = defineTopics({
  'session.event': SessionEvent,
  'session.changed': SessionsChanged,
  'inbox.changed': z.array(NeedsYouItem),
  'workflow.run': WorkflowRunView,
  'notify': z.object({ sessionId: z.string(), title: z.string(), body: z.string(), target: z.literal('inbox').optional() }),
  'telegram.status': TelegramStatus,
  'agents.install': AgentInstallState,
  'integrate.changed': IntegrateChanged,
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
  /** SM-18: the output passed the size cap and its head was dropped. */
  truncated: z.boolean().default(false),
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
      /** CR-11: extra variables for this program only. */
      env: z.record(z.string(), z.string()).optional(),
    }),
    TerminalInfo,
  ),
  'pty.write': method(z.object({ id: Id, data: z.string().max(1_000_000) }), Ok),
  'pty.resize': method(z.object({ id: Id, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }), Ok),
  'pty.kill': method(z.object({ id: Id }), Ok),
  'pty.killSession': method(z.object({ sessionId: Id }), Ok),
  'pty.list': method(z.object({}), z.array(TerminalInfo)),
  'pty.blocks': method(z.object({ id: Id }), z.array(CommandBlock)),
  /** HI-13: forgets a terminal's finished command blocks; a running one stays. */
  'pty.clearBlocks': method(z.object({ id: Id }), Ok),
  'pty.run': method(
    z.object({ command: z.array(z.string()).min(1), cwd: AbsPath, sessionId: z.string().nullable(), runId: Id, env: z.record(z.string(), z.string()).optional() }),
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
  /** Puts text on the clipboard. The renderer has no clipboard permission (every permission request is refused). */
  'main.copyText': method(z.object({ text: z.string().max(10_000_000) }), Ok),
  'main.openInEditor': method(z.object({ path: AbsPath }), Ok),
  'main.notify': method(z.object({ title: z.string().max(200), body: z.string().max(1000), sessionId: z.string().optional() }), Ok),
  'main.credentials.status': method(
    z.object({}),
    z.object({ available: z.boolean(), backend: z.string(), stored: z.array(z.string()) }),
  ),
  'main.credentials.set': method(z.object({ key: ConnectorSecret, secret: z.string().min(1).max(10_000) }), Ok),
  'main.credentials.delete': method(z.object({ key: ConnectorSecret }), Ok),
  'main.info': method(
    z.object({}),
    z.object({ version: z.string(), platform: z.string(), userData: z.string(), isPackaged: z.boolean() }),
  ),
  'main.restartProcess': method(z.object({ which: z.enum(['host', 'pty']) }), Ok),
  /** CR-11: secret values of environment sets, kept with safeStorage like connector tokens. */
  'main.envSecret.set': method(z.object({ key: z.string().regex(/^env:[\w-]+:[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().min(1).max(10_000) }), Ok),
  'main.envSecret.delete': method(z.object({ key: z.string().regex(/^env:[\w-]+:[A-Za-z_][A-Za-z0-9_]*$/) }), Ok),
  'main.envSecret.get': method(z.object({ keys: z.array(z.string().regex(/^env:[\w-]+:[A-Za-z_][A-Za-z0-9_]*$/)).max(100) }), z.record(z.string(), z.string())),
  /** CR-10: opens a local web app in an isolated preview window (localhost only). */
  'main.openPreview': method(z.object({ url: z.url({ protocol: /^https?$/ }) }), Ok),
  /** HI-07: asks where to save a text file, then writes it. */
  'main.saveText': method(z.object({ title: z.string().max(200), defaultName: z.string().max(200), content: z.string() }), z.object({ path: z.string().nullable() })),
});
export type MainApi = typeof mainApi;

export const mainTopics = defineTopics({
  'process.status': z.object({ which: z.enum(['host', 'pty']), status: z.enum(['up', 'restarting', 'down']) }),
  'focus.session': z.object({ sessionId: z.string() }),
  /** AP-07: a notification about a pull request opens the Needs-you inbox. */
  'focus.inbox': z.object({}),
});
export type MainTopics = typeof mainTopics;

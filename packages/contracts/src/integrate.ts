import { z } from 'zod';
import { AgentId, SessionState } from './entities.ts';

/**
 * PL-06 Integrate: how ready sessions fit together, an ordered trial merge in the object database, the checks on
 * the combined result, and landing in order. Kept in its own file so the IPC list only gains a few lines.
 */

const Id = z.string().min(1).max(200);

/** How two change sets (or a change set and the checkout) merge. */
export const IntegrateFit = z.enum(['fits', 'same-files', 'conflicts']);
export type IntegrateFit = z.infer<typeof IntegrateFit>;

/** At most this many sessions are compared at once (the matrix grows with the square). */
export const INTEGRATE_MAX_SESSIONS = 8;

export const IntegrateCandidate = z.object({
  sessionId: z.string(),
  title: z.string(),
  agentId: AgentId,
  state: SessionState,
  /** False while the session is still working: shown greyed, compared at its last checkpoint, never trialled. */
  ready: z.boolean(),
  files: z.array(z.string()),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** The session against the checkout's current commit. */
  checkout: z.object({ fit: IntegrateFit, files: z.array(z.string()), behind: z.number().int() }),
});
export type IntegrateCandidate = z.infer<typeof IntegrateCandidate>;

/** One cell of the fit matrix. `files` are the conflicted files, or the shared files when they merge cleanly. */
export const IntegratePair = z.object({ a: z.string(), b: z.string(), fit: IntegrateFit, files: z.array(z.string()) });
export type IntegratePair = z.infer<typeof IntegratePair>;

export const IntegrateOverview = z.object({
  workspaceId: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  candidates: z.array(IntegrateCandidate),
  pairs: z.array(IntegratePair),
  /** Ready sessions left out because of the cap. */
  hidden: z.number().int(),
  /** The workspace's checks (RV-10), so the page can offer to run them on the result. */
  checks: z.array(z.object({ configId: z.string(), name: z.string() })),
});
export type IntegrateOverview = z.infer<typeof IntegrateOverview>;

export const IntegrateStepStatus = z.enum(['pending', 'fits', 'conflicts', 'skipped']);
export type IntegrateStepStatus = z.infer<typeof IntegrateStepStatus>;

export const IntegrateStep = z.object({
  sessionId: z.string(),
  title: z.string(),
  status: IntegrateStepStatus,
  /** The trial commit after this step (kept under refs/ade/integrate/<trial>/<n>). */
  commit: z.string().nullable(),
  /** Conflicted files when the step conflicts. */
  conflicts: z.array(z.string()),
  /** Files the session changes. */
  changed: z.array(z.string()),
});
export type IntegrateStep = z.infer<typeof IntegrateStep>;

/** How a session's own last run of a check went. */
export const IntegrateAlone = z.enum(['passed', 'failed', 'not-run']);
export type IntegrateAlone = z.infer<typeof IntegrateAlone>;

export const IntegrateVerdict = z.enum(['passes', 'fails', 'passed-alone-fails-together']);
export type IntegrateVerdict = z.infer<typeof IntegrateVerdict>;

export const INTEGRATE_VERDICT_LABEL: Record<IntegrateVerdict, string> = {
  passes: 'Passes',
  fails: 'Fails',
  'passed-alone-fails-together': 'Passed alone, fails together',
};
export const INTEGRATE_ALONE_LABEL: Record<IntegrateAlone, string> = { passed: 'Passed alone', failed: 'Failed alone', 'not-run': 'Not run alone' };

export const IntegrateCheck = z.object({
  configId: z.string(),
  name: z.string(),
  exitCode: z.number().int().nullable(),
  verdict: IntegrateVerdict,
  alone: z.array(z.object({ sessionId: z.string(), result: IntegrateAlone })),
  /** The end of the output. */
  output: z.string(),
  runId: z.string().nullable(),
});
export type IntegrateCheck = z.infer<typeof IntegrateCheck>;

export const IntegrateTrialStatus = z.enum(['running', 'checking', 'conflicts', 'fits', 'passed', 'failed', 'cancelled', 'error', 'landed']);
export type IntegrateTrialStatus = z.infer<typeof IntegrateTrialStatus>;

export const IntegrateTrial = z.object({
  id: z.string(),
  workspaceId: z.string(),
  order: z.array(z.string()),
  /** The checkout's commit the trial started from. */
  head: z.string(),
  status: IntegrateTrialStatus,
  steps: z.array(IntegrateStep),
  runChecks: z.boolean(),
  checks: z.array(IntegrateCheck),
  /** Whether the combined checks ran inside the host sandbox (they borrow the first session's). */
  sandboxed: z.boolean(),
  /** Set when a member took a new checkpoint, ended, or the checkout moved; Land in order is then refused. */
  outOfDate: z.string().nullable(),
  error: z.string().nullable(),
  /** Sessions landed by Land in order, in order. */
  landed: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntegrateTrial = z.infer<typeof IntegrateTrial>;

/** What the Land in order confirmation lists for each session. */
export const IntegrateLandItem = z.object({
  sessionId: z.string(),
  title: z.string(),
  files: z.array(z.string()),
  unreviewed: z.array(z.string()),
  receiptItems: z.array(z.string()),
});
export type IntegrateLandItem = z.infer<typeof IntegrateLandItem>;

export const IntegrateLandResult = z.object({
  landed: z.array(z.string()),
  failed: z.object({ sessionId: z.string(), message: z.string() }).nullable(),
  notLanded: z.array(z.string()),
});
export type IntegrateLandResult = z.infer<typeof IntegrateLandResult>;

export const IntegrateChanged = z.object({ workspaceId: z.string(), trialId: z.string() });

export const IntegrateInputs = {
  overview: z.object({ workspaceId: Id }),
  trial: z.object({ workspaceId: Id, order: z.array(Id).min(1).max(INTEGRATE_MAX_SESSIONS), runChecks: z.boolean().default(false) }),
  get: z.object({ trialId: Id }),
  current: z.object({ workspaceId: Id }),
  cancel: z.object({ trialId: Id }),
  resolvePrompt: z.object({ trialId: Id, sessionId: Id }),
  resolve: z.object({ trialId: Id, sessionId: Id, prompt: z.string().trim().min(1).max(50_000) }),
  landPreview: z.object({ trialId: Id }),
  land: z.object({ trialId: Id, acknowledged: z.literal(true) }),
};

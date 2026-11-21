import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRuntime, AgentSession } from '@ade/acp-client';
import { AGENT_LABELS, RpcError, type AgentId, type ReviewAssessment } from '@ade/contracts';
import { changedFiles, diffPatch, git, snapshot } from '@ade/git';
import { z } from 'zod';
import type { Repositories } from './repositories.ts';
import type { SandboxProvider } from './session-service.ts';

const MAX_DIFF = 60_000;
const TIMEOUT_MS = 10 * 60_000;
const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

const Ranking = z.array(z.object({ path: z.string(), risk: z.enum(['high', 'medium', 'low']), reason: z.string().default('') }));

/** Reads the ranking out of the agent's reply: the first JSON array in it, sorted high to low. Pure. */
export function parseRanking(reply: string): ReviewAssessment['ranking'] | null {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = Ranking.safeParse(JSON.parse(reply.slice(start, end + 1)));
    if (!parsed.success) return null;
    return [...parsed.data].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);
  } catch {
    return null;
  }
}

/**
 * RV-14: a second agent pre-reviews a session's diff and ranks the changed files by risk. It runs in a
 * temporary detached worktree of the current snapshot with the read-only profile; every permission request
 * is refused, so it cannot change anything. It is not a session: nothing lands from it.
 */
export class ReviewAssistant {
  private readonly latest = new Map<string, ReviewAssessment>();

  constructor(
    private readonly repos: Repositories,
    private readonly runtimes: Map<AgentId, AgentRuntime>,
    private readonly tmpRoot: string,
    private readonly sandbox: () => SandboxProvider | null,
    private readonly baseEnv: () => NodeJS.ProcessEnv,
  ) {}

  assessment(sessionId: string): ReviewAssessment | null {
    return this.latest.get(sessionId) ?? null;
  }

  async run(sessionId: string, agentId: AgentId, focus?: string): Promise<ReviewAssessment> {
    const s = this.repos.sessions.require(sessionId);
    if (!s.worktreePath || !s.baseCommit) throw new RpcError('no_worktree', 'This session has no worktree.');
    const runtime = this.runtimes.get(agentId);
    if (!runtime) throw new RpcError('agent_unavailable', `Agent ${agentId} is not available`);
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    const snap = await snapshot(s.worktreePath, null, 'ADE review assistant', s.inPlace);
    const files = await changedFiles(s.worktreePath, s.baseCommit, snap);
    if (!files.length) throw new RpcError('no_changes', 'There are no changes to review yet.');
    const diff = (await diffPatch(s.worktreePath, s.baseCommit, snap)).toString('utf8');
    const tmp = join(this.tmpRoot, `${s.id.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    await git(['worktree', 'add', '--detach', tmp, snap], { cwd: root });
    let agent: AgentSession | null = null;
    try {
      const wrapper = s.containment !== 'none' ? ((await this.sandbox()?.wrapperFor({ ...s, worktreePath: tmp }, root)) ?? null) : null;
      agent = await runtime.start({ cwd: tmp, permissionProfile: 'read-only', baseEnv: this.baseEnv(), ...(wrapper ? { wrapper } : {}) });
      let reply = '';
      agent.onEvent((e) => {
        if (e.type === 'agent.message.chunk') reply += e.text;
      });
      // Read-only: refuse everything it asks for.
      agent.onPermissionRequest(async (request) => {
        const reject = request.options.find((o) => o.kind === 'reject_once') ?? request.options.find((o) => o.kind === 'reject_always');
        return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
      });
      const prompt = [
        `You are reviewing a change another coding agent made in this repository. Do not modify any file and do not run commands that change anything.`,
        `Rank every changed file by how risky the change is (bugs, security, data loss, breaking behaviour). Reply with only a JSON array, highest risk first, like:`,
        `[{"path": "src/a.ts", "risk": "high", "reason": "one sentence"}]`,
        `Use "high", "medium" or "low" for risk.`,
        `Changed files: ${files.map((f) => f.path).join(', ')}`,
        `The diff:\n${diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff}`,
        focus?.trim() ?? '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const live = agent;
      await Promise.race([
        live.prompt([{ type: 'text', text: prompt }]),
        new Promise((_, reject) => setTimeout(() => reject(new RpcError('timeout', 'The review assistant did not finish in time.')), TIMEOUT_MS).unref()),
      ]);
      const assessment: ReviewAssessment = { agentId, ranking: parseRanking(reply) ?? [], raw: reply.trim(), createdAt: new Date().toISOString() };
      this.latest.set(sessionId, assessment);
      this.repos.audit.append({
        workspaceId: s.workspaceId,
        sessionId,
        actor: 'user',
        action: 'review.assisted',
        detail: { agent: agentId, label: AGENT_LABELS[agentId], ranked: assessment.ranking.length },
      });
      return assessment;
    } finally {
      await agent?.close().catch(() => undefined);
      await git(['worktree', 'remove', '--force', tmp], { cwd: root }).catch(() => undefined);
    }
  }
}

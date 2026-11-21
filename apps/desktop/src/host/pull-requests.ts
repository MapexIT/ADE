import { findOnPath } from '@ade/acp-client';
import { RpcError, type PullRequestStatus, type Session } from '@ade/contracts';
import { currentBranch, git } from '@ade/git';
import { isTerminal } from '@ade/session-core';
import { runFile, type CredentialCache, type Runner } from './connectors.ts';
import type { Repositories } from './repositories.ts';
import type { ReviewService } from './review-service.ts';
import type { SessionService } from './session-service.ts';
import type { WorkItemSync } from './work-item-sync.ts';

export interface PullRequestRecord {
  url: string;
  number: number | null;
  branch: string;
  openedAt: string;
}

const KEY = 'pullRequests';
const LOG_TAIL = 6000;

/** The first JSON value in gh's output, or null. Pure. */
const json = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/**
 * RV-12, CO-05 to CO-07: a session's pull request. Opening one keeps the session open, so the agent can answer
 * review comments and failing checks and push again; the session lands when GitHub reports the merge.
 * Everything goes through the user's own `gh` login (or the stored GitHub token).
 */
export class PullRequestService {
  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
    private readonly review: ReviewService,
    private readonly creds: CredentialCache,
    private readonly sync: WorkItemSync,
    private readonly run: Runner = runFile,
    private readonly gh: string | null = findOnPath('gh'),
  ) {}

  private all(): Record<string, PullRequestRecord> {
    return this.repos.settings.get<Record<string, PullRequestRecord>>(KEY, {});
  }

  record(sessionId: string): PullRequestRecord | null {
    return this.all()[sessionId] ?? null;
  }

  private env() {
    const token = this.creds.get('github');
    return { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token } : {}) };
  }

  private async ghRun(args: string[], cwd: string, okCodes: number[] = [0]) {
    if (!this.gh) throw new RpcError('no_gh', 'The GitHub CLI (gh) is not installed.');
    const res = await this.run(this.gh, args, this.env(), cwd);
    if (!okCodes.includes(res.code)) throw new RpcError('gh_failed', `gh ${args[0]} ${args[1] ?? ''} failed: ${(res.stderr || res.stdout).trim().slice(0, 1000)}`);
    return res.stdout;
  }

  private worktreeSession(sessionId: string): Session & { worktreePath: string; baseCommit: string } {
    const s = this.repos.sessions.require(sessionId);
    if (!s.worktreePath || !s.baseCommit || isTerminal(s.state)) throw new RpcError('session_ended', 'This session has ended.');
    if (s.inPlace) throw new RpcError('in_place', 'A session in your checkout cannot open a pull request.');
    return s as Session & { worktreePath: string; baseCommit: string };
  }

  private requirePr(sessionId: string) {
    const s = this.worktreeSession(sessionId);
    const pr = this.record(sessionId);
    if (!pr) throw new RpcError('no_pull_request', 'This session has no pull request.');
    return { s, pr };
  }

  /**
   * RV-12: commits the selected files on the session branch, pushes it to `origin` and opens a pull request.
   * Only on this explicit call. `gh` and `origin` are checked before anything is committed.
   */
  async open(sessionId: string, input: { files: string[]; title: string; body: string; message?: string; draft: boolean; base?: string }): Promise<{ url: string }> {
    const s = this.worktreeSession(sessionId);
    if (this.record(sessionId)) throw new RpcError('exists', 'This session already has a pull request. Push your changes to it instead.');
    if (!this.gh) throw new RpcError('no_gh', 'The GitHub CLI (gh) is not installed.');
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    await git(['remote', 'get-url', 'origin'], { cwd: root }).catch(() => {
      throw new RpcError('no_remote', 'This repository has no remote called origin.');
    });
    const base = await currentBranch(root);
    const { commit } = await this.review.commitForLanding(sessionId, input.files, input.message?.trim() || input.title, input.base);
    const push = await this.run('git', ['push', '-u', 'origin', s.branch!], this.env(), s.worktreePath);
    if (push.code !== 0) throw new RpcError('push_failed', `git push failed: ${(push.stderr || push.stdout).trim().slice(0, 1000)}`);
    const body = `${input.body || ''}${this.sync.pullRequestBodyExtra(s)}`.trim() || ' ';
    const args = ['pr', 'create', '--head', s.branch!, '--title', input.title, '--body', body, ...(base ? ['--base', base] : []), ...(input.draft ? ['--draft'] : [])];
    const out = await this.run(this.gh, args, this.env(), s.worktreePath);
    if (out.code !== 0) throw new RpcError('pr_failed', `The branch was pushed, but gh could not open the pull request: ${(out.stderr || out.stdout).trim().slice(0, 1000)}`);
    const url = out.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]) || null;
    this.repos.settings.set(KEY, { ...this.all(), [sessionId]: { url, number, branch: s.branch!, openedAt: new Date().toISOString() } });
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'session.pull_request.opened', detail: { url, commit, branch: s.branch, files: input.files } });
    this.sessions.record(sessionId, { type: 'notice', level: 'info', text: `Opened a pull request: ${url}. The session stays open for review comments and checks; it lands when the pull request is merged.` });
    await this.sync.onPullRequest(s, url);
    return { url };
  }

  async status(sessionId: string): Promise<PullRequestStatus | null> {
    const pr = this.record(sessionId);
    const s = this.repos.sessions.get(sessionId);
    if (!pr || !s?.worktreePath) return null;
    const view = json<{ state?: string; reviewDecision?: string | null; number?: number }>(await this.ghRun(['pr', 'view', pr.url, '--json', 'state,reviewDecision,number,url'], s.worktreePath));
    // `gh pr checks` exits non-zero while checks fail or are pending; its JSON is still on stdout.
    const checks = json<{ name?: string; bucket?: string; link?: string; workflow?: string }[]>(await this.ghRun(['pr', 'checks', pr.url, '--json', 'name,bucket,link,workflow'], s.worktreePath, [0, 1, 8])) ?? [];
    if (view?.state === 'MERGED' && !isTerminal(s.state)) await this.landMerged(s, pr);
    return {
      url: pr.url,
      number: view?.number ?? pr.number,
      state: view?.state ?? 'UNKNOWN',
      reviewDecision: view?.reviewDecision || null,
      checks: checks.map((c) => ({ name: c.name ?? '', bucket: c.bucket ?? '', link: c.link ?? '', workflow: c.workflow ?? '' })),
    };
  }

  /** Commits whatever changed since the last push and pushes it to the pull request's branch. */
  async pushUpdate(sessionId: string, message: string): Promise<void> {
    const { s, pr } = this.requirePr(sessionId);
    if (this.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish first.');
    const changed = (await git(['status', '--porcelain'], { cwd: s.worktreePath })).trim();
    if (changed) {
      await git(['add', '-A'], { cwd: s.worktreePath });
      await git(['commit', '-q', '-m', message], { cwd: s.worktreePath });
    }
    const push = await this.run('git', ['push', 'origin', pr.branch], this.env(), s.worktreePath);
    if (push.code !== 0) throw new RpcError('push_failed', `git push failed: ${(push.stderr || push.stdout).trim().slice(0, 1000)}`);
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'session.pull_request.pushed', detail: { url: pr.url, committed: !!changed } });
    this.sessions.record(sessionId, { type: 'notice', level: 'info', text: changed ? `Pushed a new commit to ${pr.url}.` : `Pushed ${pr.branch}; there was nothing new to commit.` });
  }

  /** CO-06: review summaries, conversation comments and line comments, as one prompt. */
  async sendReviewComments(sessionId: string): Promise<{ count: number }> {
    const { s, pr } = this.requirePr(sessionId);
    const view = json<{ reviews?: { author?: { login?: string }; body?: string; state?: string }[]; comments?: { author?: { login?: string }; body?: string }[] }>(
      await this.ghRun(['pr', 'view', pr.url, '--json', 'reviews,comments'], s.worktreePath),
    );
    // Line comments are not in `gh pr view`; they come from the REST endpoint for pull request review comments.
    const inline = pr.number
      ? (json<{ path?: string; line?: number | null; original_line?: number | null; body?: string; user?: { login?: string } }[]>(
          await this.ghRun(['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`], s.worktreePath),
        ) ?? [])
      : [];
    const parts: string[] = [];
    for (const r of view?.reviews ?? []) if (r.body?.trim()) parts.push(`Review by ${r.author?.login ?? 'someone'} (${(r.state ?? '').toLowerCase().replace('_', ' ')}):\n${r.body.trim()}`);
    for (const c of view?.comments ?? []) if (c.body?.trim()) parts.push(`Comment by ${c.author?.login ?? 'someone'}:\n${c.body.trim()}`);
    for (const c of inline) if (c.body?.trim()) parts.push(`${c.path ?? 'file'}:${c.line ?? c.original_line ?? '?'} (${c.user?.login ?? 'someone'}): ${c.body.trim()}`);
    if (!parts.length) return { count: 0 };
    await this.sessions.prompt(sessionId, [
      { type: 'text', text: [`The pull request ${pr.url} has review feedback. Address every point, then say what you changed.`, ...parts].join('\n\n') },
    ]);
    return { count: parts.length };
  }

  /** CO-07: each failing GitHub Actions job with the log of its failed steps, as one prompt. */
  async sendFailedChecks(sessionId: string): Promise<{ count: number }> {
    const { s, pr } = this.requirePr(sessionId);
    const checks = json<{ name?: string; bucket?: string; link?: string }[]>(await this.ghRun(['pr', 'checks', pr.url, '--json', 'name,bucket,link'], s.worktreePath, [0, 1, 8])) ?? [];
    const failed = checks.filter((c) => c.bucket === 'fail');
    if (!failed.length) return { count: 0 };
    const parts: string[] = [];
    for (const c of failed) {
      const job = /\/job\/(\d+)/.exec(c.link ?? '')?.[1];
      let log = '';
      if (job) {
        const res = await this.run(this.gh!, ['run', 'view', '--job', job, '--log-failed'], this.env(), s.worktreePath);
        log = (res.code === 0 ? res.stdout : res.stderr).slice(-LOG_TAIL);
      }
      parts.push(`Check "${c.name ?? 'unnamed'}" failed${c.link ? ` (${c.link})` : ''}:\n${log || 'No log was available.'}`);
    }
    await this.sessions.prompt(sessionId, [
      { type: 'text', text: [`These GitHub checks fail on the pull request ${pr.url}. Fix the cause in this worktree.`, ...parts].join('\n\n') },
    ]);
    return { count: failed.length };
  }

  /** CO-05: lands every open session whose pull request GitHub reports as merged. */
  async pollMerges(): Promise<void> {
    if (!this.gh) return;
    for (const [sessionId, pr] of Object.entries(this.all())) {
      const s = this.repos.sessions.get(sessionId);
      if (!s?.worktreePath || isTerminal(s.state)) continue;
      const res = await this.run(this.gh, ['pr', 'view', pr.url, '--json', 'state'], this.env(), s.worktreePath).catch(() => null);
      if (res?.code === 0 && json<{ state?: string }>(res.stdout)?.state === 'MERGED') await this.landMerged(s, pr);
    }
  }

  private async landMerged(s: Session, pr: PullRequestRecord) {
    this.sessions.record(s.id, { type: 'notice', level: 'info', text: `The pull request was merged: ${pr.url}` });
    await this.review.recordLanding(s.id, 'commit', [], { pullRequest: pr.url, branch: pr.branch }, 'merged');
  }
}

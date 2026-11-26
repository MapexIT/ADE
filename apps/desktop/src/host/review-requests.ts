import type { NeedsYouItem, Workspace } from '@ade/contracts';
import type { CredentialCache, Runner } from './connectors.ts';

/** How often ADE asks GitHub for pull requests waiting on the user's review. */
export const REVIEW_POLL_MS = 3 * 60_000;

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt?: string;
  isDraft?: boolean;
  author?: { login?: string };
}

export interface ReviewRequestDeps {
  workspaces: () => Workspace[];
  creds: CredentialCache;
  run: Runner;
  /** The GitHub CLI, or null when it is not installed: then this watch does nothing. */
  gh: string | null;
  refreshInbox: () => void;
}

/** "owner/repo" from a pull request URL, or null. Pure. */
export const repoOf = (url: string): string | null => /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

/** Turns gh's JSON into inbox items, one per pull request across workspaces. Pure. */
export function toInboxItems(found: { workspace: Workspace; prs: GhPullRequest[] }[]): NeedsYouItem[] {
  const seen = new Map<string, NeedsYouItem>();
  for (const { workspace, prs } of found) {
    for (const pr of prs) {
      if (!pr.url || seen.has(pr.url)) continue;
      const by = pr.author?.login ? ` by ${pr.author.login}` : '';
      seen.set(pr.url, {
        id: `review:${pr.url}`,
        sessionId: '',
        sessionTitle: `${repoOf(pr.url) ?? workspace.name}${by}`,
        kind: 'review',
        title: `#${pr.number} ${pr.title}${pr.isDraft ? ' (draft)' : ''}`,
        url: pr.url,
        createdAt: pr.createdAt ?? new Date().toISOString(),
      });
    }
  }
  return [...seen.values()];
}

/**
 * AP-07: pull requests where GitHub asks the user for a review, in the Needs-you inbox. ADE asks `gh` (the
 * user's own login, or the stored GitHub token) in every workspace folder at start-up and every three
 * minutes, only while the user is signed in to `gh`. Without `gh` nothing runs and no item appears. Read-only: ADE never reviews anything itself.
 */
export class ReviewRequestWatch {
  private items: NeedsYouItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: ReviewRequestDeps) {}

  inbox(): NeedsYouItem[] {
    return this.items;
  }

  start(): void {
    if (!this.deps.gh || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), REVIEW_POLL_MS);
    this.timer.unref?.();
  }

  /** One round over every workspace. A failing workspace (no GitHub remote, signed out) is skipped. */
  poll(): Promise<void> {
    if (!this.deps.gh || this.disposed) return Promise.resolve();
    this.running ??= this.round().finally(() => (this.running = null));
    return this.running;
  }

  private async round(): Promise<void> {
    const gh = this.deps.gh!;
    const token = this.deps.creds.get('github');
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token } : {}) };
    // Only for a signed-in user: a stored token, or `gh auth status` succeeding. Signing out clears the items.
    if (!token && (await this.deps.run(gh, ['auth', 'status'], env).catch(() => ({ code: 1 }))).code !== 0) return this.replace([]);
    const args = ['pr', 'list', '--search', 'review-requested:@me', '--state', 'open', '--limit', '50', '--json', 'number,title,url,createdAt,isDraft,author'];
    const found: { workspace: Workspace; prs: GhPullRequest[] }[] = [];
    let anyOk = false;
    const workspaces = this.deps.workspaces();
    for (const workspace of workspaces) {
      if (this.disposed) return;
      try {
        const res = await this.deps.run(gh, args, env, workspace.rootPath);
        if (res.code !== 0) continue;
        anyOk = true;
        found.push({ workspace, prs: JSON.parse(res.stdout || '[]') as GhPullRequest[] });
      } catch {
        // Not a GitHub repository, or the folder is gone.
      }
    }
    // When every workspace failed (offline, GitHub down), keep what was shown rather than flashing it away.
    if (this.disposed || (!anyOk && workspaces.length > 0)) return;
    this.replace(toInboxItems(found));
  }

  private replace(next: NeedsYouItem[]): void {
    if (this.disposed) return;
    const same = next.length === this.items.length && next.every((n, i) => n.id === this.items[i]?.id && n.title === this.items[i]?.title);
    this.items = next;
    if (!same) this.deps.refreshInbox();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

import { RpcError, type AuditEntry, type NeedsYouItem, type Workspace } from '@ade/contracts';
import type { CredentialCache, Runner } from './connectors.ts';

/** How often ADE asks GitHub for pull requests that need the user. */
export const REVIEW_POLL_MS = 3 * 60_000;

/** Settings keys: what was already notified, and reviews the user dismissed. */
const NOTIFIED_KEY = 'github.notified';
const DISMISSED_KEY = 'github.dismissedReviews';

interface GhReview {
  author?: { login?: string };
  state?: string;
  submittedAt?: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt?: string;
  isDraft?: boolean;
  author?: { login?: string };
  headRefOid?: string;
  reviewDecision?: string | null;
  latestReviews?: GhReview[];
}

export interface Found {
  workspace: Workspace;
  requested: GhPullRequest[];
  mine: GhPullRequest[];
}

export interface ReviewRequestDeps {
  workspaces: () => Workspace[];
  creds: CredentialCache;
  run: Runner;
  /** The GitHub CLI, or null when it is not installed: then this watch does nothing. */
  gh: string | null;
  refreshInbox: () => void;
  /** A desktop (and Telegram) notification; clicking it opens the Needs-you inbox. */
  notify: (title: string, body: string) => void;
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  audit: (entry: Omit<AuditEntry, 'id' | 'ts'>) => void;
}

/** "owner/repo" from a pull request URL, or null. Pure. */
export const repoOf = (url: string): string | null => /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

const STATE_WORDS: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  DISMISSED: 'Review dismissed',
};

/** Reviews by people other than the author, newest first. Pending (unsubmitted) reviews do not count. Pure. */
export function othersReviews(pr: GhPullRequest): GhReview[] {
  const me = pr.author?.login;
  return (pr.latestReviews ?? [])
    .filter((r) => r.state && r.state !== 'PENDING' && r.author?.login !== me)
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
}

/** A line saying how the pull request was reviewed: "Approved by alice, bob". Pure. */
export function reviewSummary(pr: GhPullRequest): string {
  const reviews = othersReviews(pr);
  const state = (pr.reviewDecision && STATE_WORDS[pr.reviewDecision]) || STATE_WORDS[reviews[0]?.state ?? ''] || 'Reviewed';
  const who = [...new Set(reviews.map((r) => r.author?.login).filter(Boolean))].join(', ');
  return who ? `${state} by ${who}` : state;
}

/**
 * The inbox items for one round, one per pull request across workspaces. `review`: someone asks the user for a
 * review. `reviewed`: the user's own pull request has a review from someone else, keyed by its latest review so
 * a dismissed one comes back when a new review arrives. Pure.
 */
export function toInboxItems(found: Found[], dismissed: ReadonlySet<string> = new Set()): NeedsYouItem[] {
  const seen = new Map<string, NeedsYouItem>();
  for (const { workspace, requested, mine } of found) {
    const repo = (url: string) => repoOf(url) ?? workspace.name;
    for (const pr of requested) {
      const id = `review:${pr.url}`;
      if (!pr.url || seen.has(id)) continue;
      const by = pr.author?.login ? ` by ${pr.author.login}` : '';
      seen.set(id, {
        id,
        sessionId: '',
        sessionTitle: `${repo(pr.url)}${by}`,
        kind: 'review',
        title: `#${pr.number} ${pr.title}${pr.isDraft ? ' (draft)' : ''}`,
        url: pr.url,
        createdAt: pr.createdAt ?? new Date().toISOString(),
      });
    }
    for (const pr of mine) {
      const id = `reviewed:${pr.url}`;
      const latest = othersReviews(pr)[0];
      if (!pr.url || !latest || seen.has(id)) continue;
      const reviewKey = `${pr.url}@${latest.submittedAt ?? ''}`;
      if (dismissed.has(reviewKey)) continue;
      seen.set(id, {
        id,
        sessionId: '',
        sessionTitle: `${repo(pr.url)} · ${reviewSummary(pr)}`,
        kind: 'reviewed',
        title: `#${pr.number} ${pr.title}${pr.isDraft ? ' (draft)' : ''}`,
        url: pr.url,
        reviewKey,
        createdAt: latest.submittedAt ?? new Date().toISOString(),
      });
    }
  }
  return [...seen.values()];
}

/** What a notification is keyed by: a review request once, a reviewed pull request once per new review. Pure. */
const notifyKey = (i: NeedsYouItem) => (i.kind === 'reviewed' ? `reviewed:${i.reviewKey}` : i.id);

/**
 * AP-07, AP-08: pull requests that need the user, in the Needs-you inbox. ADE asks `gh` (the user's own login, or
 * the stored GitHub token) in every workspace folder at start-up and every three minutes, only while the user is
 * signed in. Review requests, and the user's own pull requests once someone reviewed them; new ones notify.
 * Without `gh` nothing runs. The only write is `squashMerge`, and only when the user presses its button.
 */
export class ReviewRequestWatch {
  private items: NeedsYouItem[] = [];
  /** Where each pull request was found, so `gh` runs in a folder of that repository. */
  private folders = new Map<string, Workspace>();
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

  /** One round over every workspace. A failing workspace (no GitHub remote) is skipped. */
  poll(): Promise<void> {
    if (!this.deps.gh || this.disposed) return Promise.resolve();
    this.running ??= this.round().finally(() => (this.running = null));
    return this.running;
  }

  private env() {
    const token = this.deps.creds.get('github');
    return { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token } : {}) };
  }

  private async list(cwd: string, search: string, fields: string): Promise<GhPullRequest[] | null> {
    const res = await this.deps.run(this.deps.gh!, ['pr', 'list', '--search', search, '--state', 'open', '--limit', '50', '--json', fields], this.env(), cwd);
    if (res.code !== 0) return null;
    return JSON.parse(res.stdout || '[]') as GhPullRequest[];
  }

  private async round(): Promise<void> {
    const gh = this.deps.gh!;
    // Only for a signed-in user: a stored token, or `gh auth status` succeeding. Signing out clears the items.
    if (!this.deps.creds.get('github') && (await this.deps.run(gh, ['auth', 'status'], this.env()).catch(() => ({ code: 1 }))).code !== 0) return this.replace([], false);
    const found: Found[] = [];
    const workspaces = this.deps.workspaces();
    for (const workspace of workspaces) {
      if (this.disposed) return;
      try {
        const requested = await this.list(workspace.rootPath, 'review-requested:@me', 'number,title,url,createdAt,isDraft,author');
        if (!requested) continue;
        const mine = (await this.list(workspace.rootPath, 'author:@me', 'number,title,url,createdAt,isDraft,author,headRefOid,reviewDecision,latestReviews')) ?? [];
        found.push({ workspace, requested, mine });
      } catch {
        // Not a GitHub repository, or the folder is gone.
      }
    }
    // When every workspace failed (offline, GitHub down), keep what was shown rather than flashing it away.
    if (this.disposed || (found.length === 0 && workspaces.length > 0)) return;
    this.folders = new Map(found.flatMap((f) => [...f.requested, ...f.mine].map((pr) => [pr.url, f.workspace] as const)));
    this.heads = new Map(found.flatMap((f) => f.mine.map((pr) => [pr.url, pr.headRefOid ?? ''] as const)));
    this.replace(toInboxItems(found, new Set(this.deps.settings.get<string[]>(DISMISSED_KEY, []))), true);
  }

  private heads = new Map<string, string>();

  /** Notifies what is new since the last round. The very first round only remembers, so a start-up is quiet. */
  private announce(next: NeedsYouItem[]): void {
    const stored = this.deps.settings.get<string[] | null>(NOTIFIED_KEY, null);
    const keys = next.map(notifyKey);
    if (stored) {
      const known = new Set(stored);
      for (const item of next.filter((i) => !known.has(notifyKey(i)))) {
        if (item.kind === 'review') this.deps.notify('A pull request needs your review', `${item.title} (${item.sessionTitle})`);
        else this.deps.notify('Your pull request was reviewed', `${item.title} (${item.sessionTitle})`);
      }
    }
    this.deps.settings.set(NOTIFIED_KEY, keys);
  }

  private replace(next: NeedsYouItem[], fresh: boolean): void {
    if (this.disposed) return;
    if (fresh) this.announce(next);
    const same = next.length === this.items.length && next.every((n, i) => n.id === this.items[i]?.id && n.title === this.items[i]?.title && n.sessionTitle === this.items[i]?.sessionTitle);
    this.items = next;
    if (!same) this.deps.refreshInbox();
  }

  private drop(url: string): void {
    this.items = this.items.filter((i) => i.url !== url);
    this.deps.refreshInbox();
  }

  /**
   * AP-08: squash and merge one of the user's reviewed pull requests, on the user's explicit action only. It merges
   * the head ADE showed (`--match-head-commit`), so commits pushed after the last round make GitHub refuse.
   */
  async squashMerge(url: string): Promise<void> {
    const item = this.items.find((i) => i.kind === 'reviewed' && i.url === url);
    if (!this.deps.gh) throw new RpcError('no_gh', 'The GitHub CLI (gh) is not installed.');
    if (!item) throw new RpcError('not_found', 'That pull request is no longer waiting on you.');
    const workspace = this.folders.get(url);
    const head = this.heads.get(url);
    const args = ['pr', 'merge', url, '--squash', ...(head ? ['--match-head-commit', head] : [])];
    const res = await this.deps.run(this.deps.gh, args, this.env(), workspace?.rootPath);
    if (res.code !== 0) throw new RpcError('merge_failed', `GitHub did not merge the pull request: ${(res.stderr || res.stdout).trim().slice(0, 1000)}`);
    this.deps.audit({ workspaceId: workspace?.id ?? null, sessionId: null, actor: 'user', action: 'github.pull_request.squash_merged', detail: { url, head: head ?? null } });
    this.drop(url);
  }

  /** Hides a reviewed pull request until someone reviews it again. */
  dismiss(url: string): void {
    const item = this.items.find((i) => i.kind === 'reviewed' && i.url === url);
    if (!item?.reviewKey) return;
    const dismissed = this.deps.settings.get<string[]>(DISMISSED_KEY, []).filter((k) => !k.startsWith(`${url}@`));
    this.deps.settings.set(DISMISSED_KEY, [...dismissed, item.reviewKey].slice(-200));
    this.drop(url);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

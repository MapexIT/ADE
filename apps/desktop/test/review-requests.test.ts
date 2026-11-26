import type { Workspace } from '@ade/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CredentialCache, type Runner } from '../src/host/connectors.ts';
import { repoOf, reviewSummary, ReviewRequestWatch, toInboxItems, type GhPullRequest } from '../src/host/review-requests.ts';

const ws = (id: string): Workspace => ({ id, rootPath: `/repos/${id}`, name: id, createdAt: '', lastOpenedAt: '' });
const pr = (n: number, repo = 'acme/web'): GhPullRequest => ({ number: n, title: `Change ${n}`, url: `https://github.com/${repo}/pull/${n}`, createdAt: '2026-11-26T10:00:00Z', author: { login: 'octocat' } });
const mine = (n: number, reviews: { login: string; state: string; at: string }[], extra: Partial<GhPullRequest> = {}): GhPullRequest => ({
  ...pr(n),
  author: { login: 'me' },
  headRefOid: `sha${n}`,
  latestReviews: reviews.map((r) => ({ author: { login: r.login }, state: r.state, submittedAt: r.at })),
  ...extra,
});

const memory = () => {
  const store = new Map<string, unknown>();
  return {
    get<T>(k: string, fallback: T): T {
      return store.has(k) ? (store.get(k) as T) : fallback;
    },
    set(k: string, v: unknown) {
      store.set(k, v);
    },
  };
};

interface GhState {
  signedIn?: boolean;
  online?: boolean;
  requested?: Record<string, GhPullRequest[]>;
  mine?: Record<string, GhPullRequest[]>;
  merge?: number;
}

/** A fake gh: auth status, the two searches per workspace and merges. */
const fakeGh = (state: GhState) => {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const run: Runner = async (_f, args, _env, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'auth') return { code: state.signedIn === false ? 1 : 0, stdout: '', stderr: '' };
    if (state.online === false) return { code: 1, stdout: '', stderr: 'offline' };
    if (args[1] === 'merge') return { code: state.merge ?? 0, stdout: '', stderr: state.merge ? 'Head branch was modified' : '' };
    const search = args[args.indexOf('--search') + 1];
    const table = search === 'author:@me' ? state.mine : state.requested;
    return { code: 0, stdout: JSON.stringify(table?.[cwd ?? ''] ?? []), stderr: '' };
  };
  return { run, calls };
};

const watch = (run: Runner, opts: { workspaces?: Workspace[]; creds?: CredentialCache; settings?: ReturnType<typeof memory> } = {}) => {
  const refreshInbox = vi.fn();
  const notify = vi.fn();
  const audit = vi.fn();
  const settings = opts.settings ?? memory();
  const w = new ReviewRequestWatch({ workspaces: () => opts.workspaces ?? [ws('a'), ws('b')], creds: opts.creds ?? new CredentialCache(), run, gh: 'gh', refreshInbox, notify, settings, audit });
  return { w, refreshInbox, notify, audit };
};

describe('AP-07: pull requests waiting on your review', () => {
  it('reads owner/repo from a pull request URL', () => {
    expect(repoOf('https://github.com/acme/web/pull/12')).toBe('acme/web');
    expect(repoOf('https://example.com/x')).toBeNull();
  });

  it('turns each pull request into one review item, even when two workspaces share a repository', () => {
    const items = toInboxItems([
      { workspace: ws('a'), requested: [pr(1), { ...pr(2), isDraft: true }], mine: [] },
      { workspace: ws('b'), requested: [pr(1)], mine: [] },
    ]);
    expect(items.map((i) => i.title)).toEqual(['#1 Change 1', '#2 Change 2 (draft)']);
    expect(items[0]).toMatchObject({ kind: 'review', sessionId: '', sessionTitle: 'acme/web by octocat', url: 'https://github.com/acme/web/pull/1' });
  });

  it('asks gh in every workspace, only when signed in', async () => {
    const { run, calls } = fakeGh({ requested: { '/repos/a': [pr(7)] } });
    const { w, refreshInbox } = watch(run);
    await w.poll();
    expect(calls[0]?.args).toEqual(['auth', 'status']);
    expect(calls.filter((c) => c.args.includes('review-requested:@me')).map((c) => c.cwd)).toEqual(['/repos/a', '/repos/b']);
    expect(w.inbox().map((i) => i.title)).toEqual(['#7 Change 7']);
    expect(refreshInbox).toHaveBeenCalledTimes(1);
    await w.poll();
    expect(refreshInbox).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the user is signed out, and clears what was there', async () => {
    const state: GhState = { signedIn: true, requested: { '/repos/a': [pr(3)] } };
    const { w } = watch(fakeGh(state).run);
    await w.poll();
    expect(w.inbox()).toHaveLength(1);
    state.signedIn = false;
    await w.poll();
    expect(w.inbox()).toEqual([]);
  });

  it('skips the sign-in check with a stored token, and keeps items when GitHub cannot be reached', async () => {
    const creds = new CredentialCache();
    creds.set({ github: 'stored' });
    const state: GhState = { online: true, requested: { '/repos/a': [pr(4)] } };
    const { run, calls } = fakeGh(state);
    const { w } = watch(run, { workspaces: [ws('a')], creds });
    await w.poll();
    state.online = false;
    await w.poll();
    expect(calls.some((c) => c.args[0] === 'auth')).toBe(false);
    expect(w.inbox()).toHaveLength(1);
  });

  it('does nothing without the GitHub CLI', async () => {
    const run = vi.fn<Runner>();
    const w = new ReviewRequestWatch({ workspaces: () => [ws('a')], creds: new CredentialCache(), run, gh: null, refreshInbox: () => undefined, notify: () => undefined, settings: memory(), audit: () => undefined });
    w.start();
    await w.poll();
    expect(run).not.toHaveBeenCalled();
    expect(w.inbox()).toEqual([]);
  });

  it('notifies new review requests, but not on the very first round', async () => {
    const requested: Record<string, GhPullRequest[]> = { '/repos/a': [pr(1)] };
    const settings = memory();
    const first = watch(fakeGh({ requested }).run, { settings });
    await first.w.poll();
    expect(first.notify).not.toHaveBeenCalled();
    requested['/repos/a'] = [pr(1), pr(2)];
    await first.w.poll();
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(first.notify).toHaveBeenCalledWith('A pull request needs your review', '#2 Change 2 (acme/web by octocat)');
    // A restart remembers what was notified.
    const again = watch(fakeGh({ requested }).run, { settings });
    await again.w.poll();
    expect(again.notify).not.toHaveBeenCalled();
  });
});

describe('AP-08: your pull requests once reviewed', () => {
  it('lists your pull request only after someone else reviewed it, with the decision and reviewers', () => {
    const items = toInboxItems([
      {
        workspace: ws('a'),
        requested: [],
        mine: [
          mine(1, []),
          mine(2, [{ login: 'me', state: 'COMMENTED', at: '2026-11-26T09:00:00Z' }]),
          mine(
            3,
            [
              { login: 'alice', state: 'APPROVED', at: '2026-11-26T09:00:00Z' },
              { login: 'bob', state: 'COMMENTED', at: '2026-11-26T10:00:00Z' },
            ],
            { reviewDecision: 'APPROVED' },
          ),
          mine(4, [{ login: 'carol', state: 'PENDING', at: '' }]),
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'reviewed', title: '#3 Change 3', sessionTitle: 'acme/web · Approved by bob, alice', reviewKey: 'https://github.com/acme/web/pull/3@2026-11-26T10:00:00Z' });
  });

  it('words the summary from the review when no decision is required', () => {
    expect(reviewSummary(mine(1, [{ login: 'dan', state: 'CHANGES_REQUESTED', at: 'x' }]))).toBe('Changes requested by dan');
  });

  it('notifies a new review, and squash merges the head it saw only on request', async () => {
    const state: GhState = { mine: { '/repos/a': [mine(5, [])] } };
    const { run, calls } = fakeGh(state);
    const { w, notify, audit } = watch(run, { workspaces: [ws('a')] });
    await w.poll();
    expect(w.inbox()).toEqual([]);
    state.mine = { '/repos/a': [mine(5, [{ login: 'alice', state: 'APPROVED', at: '2026-11-26T11:00:00Z' }], { reviewDecision: 'APPROVED' })] };
    await w.poll();
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
    expect(notify).toHaveBeenCalledWith('Your pull request was reviewed', '#5 Change 5 (acme/web · Approved by alice)');
    await w.squashMerge('https://github.com/acme/web/pull/5');
    const merge = calls.find((c) => c.args[1] === 'merge');
    expect(merge?.args).toEqual(['pr', 'merge', 'https://github.com/acme/web/pull/5', '--squash', '--match-head-commit', 'sha5']);
    expect(merge?.cwd).toBe('/repos/a');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'github.pull_request.squash_merged', workspaceId: 'a' }));
    expect(w.inbox()).toEqual([]);
  });

  it('reports a refused merge and keeps the item', async () => {
    const { w } = watch(fakeGh({ mine: { '/repos/a': [mine(6, [{ login: 'alice', state: 'APPROVED', at: 't1' }])] }, merge: 1 }).run, { workspaces: [ws('a')] });
    await w.poll();
    await expect(w.squashMerge('https://github.com/acme/web/pull/6')).rejects.toThrow(/Head branch was modified/);
    expect(w.inbox()).toHaveLength(1);
    await expect(w.squashMerge('https://github.com/acme/web/pull/99')).rejects.toThrow(/no longer waiting/);
  });

  it('dismiss hides it until someone reviews again', async () => {
    const state: GhState = { mine: { '/repos/a': [mine(7, [{ login: 'alice', state: 'COMMENTED', at: 't1' }])] } };
    const { w } = watch(fakeGh(state).run, { workspaces: [ws('a')] });
    await w.poll();
    w.dismiss('https://github.com/acme/web/pull/7');
    expect(w.inbox()).toEqual([]);
    await w.poll();
    expect(w.inbox()).toEqual([]);
    state.mine = { '/repos/a': [mine(7, [{ login: 'alice', state: 'APPROVED', at: 't2' }])] };
    await w.poll();
    expect(w.inbox()).toHaveLength(1);
  });
});

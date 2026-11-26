import type { Workspace } from '@ade/contracts';
import { describe, expect, it, vi } from 'vitest';
import { CredentialCache, type Runner } from '../src/host/connectors.ts';
import { repoOf, ReviewRequestWatch, toInboxItems } from '../src/host/review-requests.ts';

const ws = (id: string): Workspace => ({ id, rootPath: `/repos/${id}`, name: id, createdAt: '', lastOpenedAt: '' });
const pr = (n: number, repo = 'acme/web') => ({ number: n, title: `Change ${n}`, url: `https://github.com/${repo}/pull/${n}`, createdAt: '2026-11-26T10:00:00Z', author: { login: 'octocat' } });

const watch = (run: Runner, workspaces = [ws('a'), ws('b')], creds = new CredentialCache()) => {
  const refreshInbox = vi.fn();
  return { w: new ReviewRequestWatch({ workspaces: () => workspaces, creds, run, gh: 'gh', refreshInbox }), refreshInbox };
};

describe('AP-07: pull requests waiting on your review', () => {
  it('reads owner/repo from a pull request URL', () => {
    expect(repoOf('https://github.com/acme/web/pull/12')).toBe('acme/web');
    expect(repoOf('https://example.com/x')).toBeNull();
  });

  it('turns each pull request into one review item, even when two workspaces share a repository', () => {
    const items = toInboxItems([
      { workspace: ws('a'), prs: [pr(1), { ...pr(2), isDraft: true }] },
      { workspace: ws('b'), prs: [pr(1)] },
    ]);
    expect(items.map((i) => i.title)).toEqual(['#1 Change 1', '#2 Change 2 (draft)']);
    expect(items[0]).toMatchObject({ kind: 'review', sessionId: '', sessionTitle: 'acme/web by octocat', url: 'https://github.com/acme/web/pull/1' });
  });

  it('asks gh for review requests in every workspace, only when signed in', async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args, _e, cwd) => {
      calls.push([...args, cwd ?? '']);
      if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: JSON.stringify(cwd === '/repos/a' ? [pr(7)] : []), stderr: '' };
    };
    const { w, refreshInbox } = watch(run);
    await w.poll();
    expect(calls[0]).toEqual(['auth', 'status', '']);
    expect(calls.slice(1).map((c) => c.at(-1))).toEqual(['/repos/a', '/repos/b']);
    expect(calls[1]).toEqual(expect.arrayContaining(['pr', 'list', '--search', 'review-requested:@me']));
    expect(w.inbox().map((i) => i.title)).toEqual(['#7 Change 7']);
    expect(refreshInbox).toHaveBeenCalledTimes(1);
    await w.poll();
    expect(refreshInbox).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the user is signed out, and clears what was there', async () => {
    let signedIn = true;
    const run: Runner = async (_f, args) => {
      if (args[0] === 'auth') return { code: signedIn ? 0 : 1, stdout: '', stderr: 'not logged in' };
      return { code: 0, stdout: JSON.stringify([pr(3)]), stderr: '' };
    };
    const { w } = watch(run);
    await w.poll();
    expect(w.inbox()).toHaveLength(1);
    signedIn = false;
    await w.poll();
    expect(w.inbox()).toEqual([]);
  });

  it('skips the sign-in check with a stored token, and keeps items when GitHub cannot be reached', async () => {
    const creds = new CredentialCache();
    creds.set({ github: 'stored' });
    let online = true;
    const run: Runner = vi.fn(async (_f, args, env) => {
      expect(args[0]).not.toBe('auth');
      expect(env.GH_TOKEN).toBe('stored');
      return online ? { code: 0, stdout: JSON.stringify([pr(4)]), stderr: '' } : { code: 1, stdout: '', stderr: 'offline' };
    });
    const { w } = watch(run, [ws('a')], creds);
    await w.poll();
    online = false;
    await w.poll();
    expect(w.inbox()).toHaveLength(1);
  });

  it('does nothing without the GitHub CLI', async () => {
    const run = vi.fn<Runner>();
    const w = new ReviewRequestWatch({ workspaces: () => [ws('a')], creds: new CredentialCache(), run, gh: null, refreshInbox: () => undefined });
    w.start();
    await w.poll();
    expect(run).not.toHaveBeenCalled();
    expect(w.inbox()).toEqual([]);
  });
});

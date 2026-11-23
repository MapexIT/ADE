import type { DiffText, GitBranch, GitCommit, GitCommitDetail, GitGraph, Session } from '@ade/contracts';
import { changedFiles, fileAt, git, looksBinary } from '@ade/git';
import { resolve } from 'node:path';

const SEP = '\u001f';
const MAX_AHEAD_BEHIND = 60;

/** `%D` with `--decorate-refs` limited to branches, remotes, tags and HEAD, split into labelled refs. Pure. */
export function parseDecorations(d: string): GitCommit['refs'] {
  if (!d.trim()) return [];
  const refs: GitCommit['refs'] = [];
  for (const part of d.split(', ')) {
    const name = part.trim();
    if (!name) continue;
    if (name === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (name.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' });
      refs.push({ name: name.slice(8), kind: 'local' });
    } else if (name.startsWith('tag: ')) refs.push({ name: name.slice(5), kind: 'tag' });
    else refs.push({ name, kind: 'local' });
  }
  return refs;
}

/** Parses `git log` output written with SEP between fields and NUL between commits. Pure. */
export function parseLog(out: string, remoteNames: Set<string>): GitCommit[] {
  return out
    .split('\u0000')
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash = '', parents = '', author = '', time = '0', subject = '', deco = ''] = r.split(SEP);
      const refs = parseDecorations(deco).map((x) => (x.kind === 'local' && remoteNames.has(x.name) ? { ...x, kind: 'remote' as const } : x));
      return { hash, parents: parents.split(' ').filter(Boolean), author, time: Number(time) || 0, subject, refs };
    });
}

/** `git worktree list --porcelain`: branch name to worktree path. Pure. */
export function parseWorktrees(out: string): Map<string, string> {
  const map = new Map<string, string>();
  let path: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line.startsWith('branch refs/heads/') && path) map.set(line.slice(18), path);
  }
  return map;
}

/**
 * HI-09: the data for the branch graph. Only read-only Git commands, as argument arrays. ADE's own checkpoint refs
 * (refs/ade/...) are left out: the log walks branches (and remotes when asked) and HEAD, never `--all`.
 */
export async function gitGraph(root: string, sessions: Session[], opts: { limit: number; remotes: boolean }): Promise<GitGraph> {
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, okCodes: [1] }).then((s) => s.trim() || null);
  const currentBranch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, okCodes: [1] }).then((s) => s.trim() || null);
  const refsOut = await git(['for-each-ref', `--format=%(refname)${SEP}%(objectname)${SEP}%(upstream:short)`, 'refs/heads', ...(opts.remotes ? ['refs/remotes'] : [])], { cwd: root });
  const worktrees = parseWorktrees(await git(['worktree', 'list', '--porcelain'], { cwd: root }).catch(() => ''));
  const byBranch = new Map(sessions.filter((s) => s.branch).map((s) => [s.branch!, s]));

  const branches: GitBranch[] = [];
  for (const line of refsOut.split(/\r?\n/).filter(Boolean)) {
    const [ref = '', hash = '', upstream = ''] = line.split(SEP);
    const local = ref.startsWith('refs/heads/');
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    if (!local && name.endsWith('/HEAD')) continue;
    const session = local ? byBranch.get(name) : undefined;
    const wt = local ? worktrees.get(name) : undefined;
    branches.push({
      name,
      kind: local ? 'local' : 'remote',
      head: hash,
      current: local && name === currentBranch,
      upstream: upstream || null,
      ahead: null,
      behind: null,
      worktree: wt && resolve(wt) !== resolve(root) ? wt : null,
      session: session ? { id: session.id, title: session.title, state: session.state, agentId: session.agentId } : null,
    });
  }
  if (head) {
    await Promise.all(
      branches
        .filter((b) => b.kind === 'local' && !b.current)
        .slice(0, MAX_AHEAD_BEHIND)
        .map(async (b) => {
          const out = await git(['rev-list', '--left-right', '--count', `HEAD...${b.head}`], { cwd: root }).catch(() => '');
          const [behind, ahead] = out.trim().split(/\s+/).map(Number);
          if (Number.isFinite(ahead) && Number.isFinite(behind)) Object.assign(b, { ahead, behind });
        }),
    );
  }
  // Sessions first (they are what ADE adds), then the current branch, then by name.
  branches.sort((a, b) => Number(b.current) - Number(a.current) || Number(!!b.session) - Number(!!a.session) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  const remoteNames = new Set(branches.filter((b) => b.kind === 'remote').map((b) => b.name));
  let commits: GitCommit[] = [];
  if (head || branches.length) {
    const out = await git(
      [
        'log',
        '--topo-order',
        '-z',
        `--max-count=${opts.limit + 1}`,
        `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%s${SEP}%D`,
        '--decorate-refs=refs/heads',
        '--decorate-refs=refs/tags',
        '--decorate-refs=HEAD',
        ...(opts.remotes ? ['--decorate-refs=refs/remotes'] : []),
        '--branches',
        ...(opts.remotes ? ['--remotes'] : []),
        ...(head ? ['HEAD'] : []),
        '--',
      ],
      { cwd: root },
    );
    commits = parseLog(out, remoteNames);
  }
  const truncated = commits.length > opts.limit;
  return { head, currentBranch, branches, commits: commits.slice(0, opts.limit), truncated };
}

/** Git's empty tree: what a root commit is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_BYTES = 2_000_000;

/** HI-09: a commit in full. Read-only. */
export async function commitDetail(root: string, hash: string): Promise<GitCommitDetail> {
  const out = await git(['show', '-s', `--format=%H${SEP}%P${SEP}%an${SEP}%at${SEP}%cn${SEP}%ct${SEP}%B`, hash, '--'], { cwd: root });
  const [full = '', parents = '', author = '', time = '0', committer = '', committerTime = '0', ...message] = out.split(SEP);
  const parentList = parents.split(' ').filter(Boolean);
  const files = await changedFiles(root, parentList[0] ?? EMPTY_TREE, full);
  return { hash: full, parents: parentList, author, time: Number(time) || 0, committer, committerTime: Number(committerTime) || 0, message: message.join(SEP).trim(), files };
}

/** HI-09: one file of a commit against the commit's first parent. Large or binary files are not sent as text. */
export async function commitDiff(root: string, hash: string, path: string, oldPath: string | null): Promise<DiffText> {
  const parent = (await git(['rev-parse', '--verify', '-q', `${hash}^1`], { cwd: root, okCodes: [1] })).trim();
  const before = parent ? await fileAt(root, parent, oldPath ?? path) : null;
  const after = await fileAt(root, hash, path);
  const binary = looksBinary(before) || looksBinary(after) || (before?.length ?? 0) > MAX_DIFF_BYTES || (after?.length ?? 0) > MAX_DIFF_BYTES;
  return { path, oldText: binary ? '' : (before?.toString('utf8') ?? ''), newText: binary ? '' : (after?.toString('utf8') ?? ''), binary };
}

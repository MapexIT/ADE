import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FileChange } from '@ade/contracts';
import { CHECKPOINT_IDENTITY, git, GitError } from './runner.ts';

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], { cwd: path })).trim() === 'true';
  } catch {
    return false;
  }
}

export async function repoRoot(path: string): Promise<string> {
  return resolve((await git(['rev-parse', '--show-toplevel'], { cwd: path })).trim());
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd })).trim();
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).trim();
  return out === 'HEAD' ? null : out;
}

/** Turns free text into a safe branch slug (`Fix login redirect` -> `fix-login-redirect`). */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'session';
}

export interface WorktreeSpec {
  repo: string;
  baseCommit: string;
  branch: string;
  path: string;
}

/** `git worktree add -b <branch> <path> <base>`. The worktree lives outside the repository folder (CN-01). */
export async function createWorktree(spec: WorktreeSpec): Promise<void> {
  await mkdir(dirname(spec.path), { recursive: true });
  await git(['worktree', 'add', '-b', spec.branch, spec.path, spec.baseCommit], { cwd: spec.repo });
}

export async function removeWorktree(repo: string, path: string, branch: string | null): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', path], { cwd: repo });
  } catch (err) {
    // Already gone from disk: prune the stale record instead.
    if (!(err instanceof GitError)) throw err;
    await rm(path, { recursive: true, force: true });
    await git(['worktree', 'prune'], { cwd: repo });
  }
  if (branch) await git(['branch', '-D', branch], { cwd: repo }).catch(() => undefined);
}

/** Untracked files that are not ignored, relative to `cwd`. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return out.split('\0').filter(Boolean);
}

/** CN-03: apply the checkout's uncommitted and untracked changes to a new worktree. */
export async function bringChanges(fromRepo: string, toWorktree: string): Promise<{ files: string[] }> {
  const patch = await git(['diff', 'HEAD', '--binary'], { cwd: fromRepo, binary: true });
  if (patch.length > 0) await git(['apply', '--whitespace=nowarn', '-'], { cwd: toWorktree, input: patch });
  const untracked = await untrackedFiles(fromRepo);
  for (const f of untracked) {
    await mkdir(dirname(join(toWorktree, f)), { recursive: true });
    await copyFile(join(fromRepo, f), join(toWorktree, f));
  }
  const changed = (await git(['diff', 'HEAD', '--name-only', '-z'], { cwd: fromRepo })).split('\0').filter(Boolean);
  return { files: [...changed, ...untracked] };
}

/** Copies listed untracked files (for example a local env file) from the checkout into a worktree (CN-02). */
export async function copyFiles(fromRepo: string, toWorktree: string, files: string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const f of files) {
    const src = resolve(fromRepo, f);
    if (!src.startsWith(resolve(fromRepo))) continue;
    try {
      await mkdir(dirname(join(toWorktree, f)), { recursive: true });
      await copyFile(src, join(toWorktree, f));
      copied.push(f);
    } catch {
      // missing optional file
    }
  }
  return copied;
}

export const checkpointRef = (sessionId: string, n: number) => `refs/ade/checkpoints/${sessionId}/${n}`;

/**
 * Takes a snapshot of the whole worktree (tracked and untracked, minus ignored files) without touching the
 * session branch or the worktree's index: build a tree with a temporary index, `commit-tree` it, and point
 * `ref` at the commit. Returns the commit id.
 */
export async function snapshot(worktree: string, ref: string | null, message = 'ADE checkpoint'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ade-index-'));
  const index = join(dir, 'index');
  try {
    const realIndex = resolve(worktree, (await git(['rev-parse', '--git-path', 'index'], { cwd: worktree })).trim());
    await copyFile(realIndex, index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    await git(['add', '-A', '--', '.'], { cwd: worktree, env });
    const tree = (await git(['write-tree'], { cwd: worktree, env })).trim();
    const head = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
    const commit = (
      await git(['commit-tree', tree, '-p', head, '-m', message], { cwd: worktree, env: { ...env, ...CHECKPOINT_IDENTITY } })
    ).trim();
    if (ref) await git(['update-ref', ref, commit], { cwd: worktree });
    return commit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** RV-04: restore the worktree to a checkpoint, including deleting files the checkpoint lacks. */
export async function restoreSnapshot(worktree: string, commit: string): Promise<void> {
  const current = await snapshot(worktree, null, 'ADE pre-restore');
  const added = (await git(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', commit, current], { cwd: worktree }))
    .split('\0')
    .filter(Boolean);
  for (const f of added) await unlink(join(worktree, f)).catch(() => undefined);
  const dir = await mkdtemp(join(tmpdir(), 'ade-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await git(['read-tree', commit], { cwd: worktree, env });
    await git(['checkout-index', '-a', '-f'], { cwd: worktree, env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** RV-01 / RV-03: the files changed between two commits, computed by Git. */
export async function changedFiles(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const status = (await git(['diff', '--name-status', '-M', '-z', from, to], { cwd })).split('\0').filter(Boolean);
  const numstat = (await git(['diff', '--numstat', '-M', '-z', from, to], { cwd })).split('\0');
  // numstat -z: "add\tdel\tpath" or for renames "add\tdel\t" followed by old and new paths.
  const counts = new Map<string, { add: number; del: number; binary: boolean }>();
  for (let i = 0; i < numstat.length; i++) {
    const entry = numstat[i];
    if (!entry) continue;
    const [add = '0', del = '0', path = ''] = entry.split('\t');
    const target = path === '' ? numstat[(i += 2)] ?? '' : path;
    counts.set(target, { add: add === '-' ? 0 : Number(add), del: del === '-' ? 0 : Number(del), binary: add === '-' });
  }
  const out: FileChange[] = [];
  for (let i = 0; i < status.length; i++) {
    const code = status[i]!;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = status[++i]!;
      const path = status[++i]!;
      const c = counts.get(path);
      out.push({ path, oldPath, status: c?.binary ? 'binary' : 'renamed', additions: c?.add ?? 0, deletions: c?.del ?? 0 });
      continue;
    }
    const path = status[++i]!;
    const c = counts.get(path);
    const kind = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    out.push({ path, oldPath: null, status: c?.binary ? 'binary' : kind, additions: c?.add ?? 0, deletions: c?.del ?? 0 });
  }
  return out;
}

/** Content of a file at a commit, or null when it does not exist there. */
export async function fileAt(cwd: string, commit: string, path: string): Promise<Buffer | null> {
  try {
    return await git(['show', `${commit}:${path.replace(/\\/g, '/')}`], { cwd, binary: true });
  } catch {
    return null;
  }
}

export const looksBinary = (buf: Buffer | null) => !!buf && buf.subarray(0, 8000).includes(0);

export async function diffPatch(cwd: string, from: string, to: string, files?: string[]): Promise<Buffer> {
  return git(['diff', '--binary', '-M', from, to, ...(files?.length ? ['--', ...files] : [])], { cwd, binary: true });
}

/**
 * RV-07 (a): apply selected files to the user's checkout as uncommitted changes. A plain apply is tried
 * first so the user's index is untouched; a three-way apply is the fallback when the checkout moved.
 */
export async function applyToCheckout(worktree: string, checkout: string, from: string, to: string, files: string[]): Promise<'clean' | 'three-way'> {
  const patch = await diffPatch(worktree, from, to, files);
  if (patch.length === 0) return 'clean';
  try {
    await git(['apply', '--whitespace=nowarn', '-'], { cwd: checkout, input: patch });
    return 'clean';
  } catch {
    await git(['apply', '--3way', '--whitespace=nowarn', '-'], { cwd: checkout, input: patch });
    return 'three-way';
  }
}

/** RV-07 (b): commit selected files on the session branch, with the user's own Git identity. */
export async function commitFiles(worktree: string, files: string[], message: string): Promise<string> {
  await git(['add', '-A', '--', ...files], { cwd: worktree });
  await git(['commit', '-m', message, '--', ...files], { cwd: worktree });
  return (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim();
}

/** RV-08: keep the final patch, then remove the worktree, the branch and the checkpoint refs. */
export async function discardWorktree(opts: {
  repo: string;
  worktree: string;
  branch: string | null;
  baseCommit: string;
  sessionId: string;
  patchPath: string;
}): Promise<string | null> {
  let saved: string | null = null;
  try {
    const head = await snapshot(opts.worktree, null, 'ADE final');
    const patch = await diffPatch(opts.worktree, opts.baseCommit, head);
    await mkdir(dirname(opts.patchPath), { recursive: true });
    await writeFile(opts.patchPath, patch);
    saved = opts.patchPath;
  } catch {
    // worktree already gone; nothing to keep
  }
  await removeWorktree(opts.repo, opts.worktree, opts.branch);
  const refs = (await git(['for-each-ref', '--format=%(refname)', `refs/ade/checkpoints/${opts.sessionId}/`], { cwd: opts.repo }))
    .split('\n')
    .filter(Boolean);
  for (const r of refs) await git(['update-ref', '-d', r], { cwd: opts.repo });
  return saved;
}

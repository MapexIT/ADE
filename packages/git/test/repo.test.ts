import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyToCheckout,
  blobContent,
  bringChanges,
  changedBlobs,
  changedFiles,
  checkpointRef,
  commitFiles,
  createWorktree,
  discardWorktree,
  fileAt,
  git,
  isGitRepo,
  restoreSnapshot,
  revParse,
  slugify,
  snapshot,
} from '../src/index.ts';

const ID = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid' };

let root: string;
let repo: string;
let wt: string;

async function initRepo() {
  mkdirSync(repo, { recursive: true });
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'Test'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  await git(['config', 'core.autocrlf', 'false'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  writeFileSync(join(repo, 'keep.txt'), 'keep\n');
  writeFileSync(join(repo, 'crlf.txt'), 'line one\r\nline two\r\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'initial'], { cwd: repo, env: ID });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-git-'));
  repo = join(root, 'repo');
  wt = join(root, 'worktrees', 'demo', 'session-1');
  await initRepo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function newWorktree() {
  const base = await revParse(repo, 'HEAD');
  await createWorktree({ repo, baseCommit: base, branch: 'agent/session-1', path: wt });
  return base;
}

describe('worktrees', () => {
  it('creates a worktree on a new branch outside the repository', async () => {
    const base = await newWorktree();
    expect(await isGitRepo(wt)).toBe(true);
    expect(await revParse(wt, 'HEAD')).toBe(base);
    expect((await git(['branch', '--list', 'agent/session-1'], { cwd: repo })).trim()).toContain('agent/session-1');
  });

  it('brings uncommitted and untracked changes from the checkout', async () => {
    writeFileSync(join(repo, 'keep.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    await newWorktree();
    const res = await bringChanges(repo, wt);
    expect(readFileSync(join(wt, 'keep.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(wt, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(res.files.sort()).toEqual(['keep.txt', 'new.txt']);
  });

  it('slugifies titles for branch names', () => {
    expect(slugify('Fix login redirect!')).toBe('fix-login-redirect');
    expect(slugify('***')).toBe('session');
  });
});

describe('checkpoints and diffs', () => {
  it('snapshots without touching the branch or the index, and diffs per turn', async () => {
    const base = await newWorktree();
    const start0 = await snapshot(wt, checkpointRef('s1', 0));
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    const end0 = await snapshot(wt, checkpointRef('s1', 1));
    writeFileSync(join(wt, 'b.txt'), 'b\n');
    rmSync(join(wt, 'keep.txt'));
    const end1 = await snapshot(wt, checkpointRef('s1', 2));

    expect(await revParse(wt, 'HEAD')).toBe(base);
    expect((await git(['status', '--porcelain'], { cwd: wt })).trim()).not.toBe('');
    expect((await git(['diff', '--cached', '--name-only'], { cwd: wt })).trim()).toBe('');
    expect(await revParse(repo, checkpointRef('s1', 2))).toBe(end1);

    const turn0 = await changedFiles(wt, start0, end0);
    expect(turn0.map((c) => [c.path, c.status])).toEqual([['a.txt', 'added']]);
    const turn1 = await changedFiles(wt, end0, end1);
    expect(turn1.map((c) => [c.path, c.status]).sort()).toEqual([
      ['b.txt', 'added'],
      ['keep.txt', 'deleted'],
    ]);
    const all = await changedFiles(wt, base, end1);
    expect(all.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt', 'keep.txt']);
  });

  it('ignores ignored files in snapshots', async () => {
    await newWorktree();
    mkdirSync(join(wt, 'node_modules'));
    writeFileSync(join(wt, 'node_modules', 'x.js'), 'x');
    const c = await snapshot(wt, null);
    expect(await fileAt(wt, c, 'node_modules/x.js')).toBeNull();
  });

  it('reports renames and binary files', async () => {
    const base = await newWorktree();
    await git(['mv', 'README.md', 'DOCS.md'], { cwd: wt });
    writeFileSync(join(wt, 'image.bin'), Buffer.from([0, 9, 9, 9, 0]));
    const c = await snapshot(wt, null);
    const changes = await changedFiles(wt, base, c);
    expect(changes.find((x) => x.path === 'DOCS.md')).toMatchObject({ status: 'renamed', oldPath: 'README.md' });
    expect(changes.find((x) => x.path === 'image.bin')?.status).toBe('binary');
  });

  it('undoes a turn, including deleting files the checkpoint lacks and keeping CRLF', async () => {
    await newWorktree();
    const turn1End = await snapshot(wt, null);
    writeFileSync(join(wt, 'crlf.txt'), 'replaced\n');
    writeFileSync(join(wt, 'added-later.txt'), 'x');
    rmSync(join(wt, 'keep.txt'));
    await restoreSnapshot(wt, turn1End);
    expect(readFileSync(join(wt, 'crlf.txt'), 'utf8')).toBe('line one\r\nline two\r\n');
    expect(existsSync(join(wt, 'added-later.txt'))).toBe(false);
    expect(readFileSync(join(wt, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

describe('review fingerprints', () => {
  const FINGERPRINT = /^[0-7]{6} [0-7]{6} [0-9a-f]{40,64} [0-9a-f]{40,64}$/;

  it('identifies added, modified, deleted, renamed and binary files by both sides of their diff', async () => {
    const base = await newWorktree();
    writeFileSync(join(wt, 'added.txt'), 'new\n');
    writeFileSync(join(wt, 'keep.txt'), 'changed\n');
    rmSync(join(wt, 'crlf.txt'));
    await git(['mv', 'README.md', 'DOCS.md'], { cwd: wt });
    writeFileSync(join(wt, 'image.bin'), Buffer.from([0, 9, 9, 9, 0]));
    const c = await snapshot(wt, null);
    const blobs = await changedBlobs(wt, base, c);
    // Keys match changedFiles exactly, including the new path of a rename.
    expect([...blobs.keys()].sort()).toEqual((await changedFiles(wt, base, c)).map((f) => f.path).sort());
    expect(blobs.has('DOCS.md')).toBe(true);
    expect(blobs.has('README.md')).toBe(false);
    for (const value of blobs.values()) expect(value).toMatch(FINGERPRINT);

    const [, , addedOld, addedNew] = blobs.get('added.txt')!.split(' ');
    expect(addedOld).toMatch(/^0+$/);
    expect((await blobContent(wt, addedNew!))?.toString('utf8')).toBe('new\n');
    const [, , deletedOld, deletedNew] = blobs.get('crlf.txt')!.split(' ');
    expect(deletedNew).toMatch(/^0+$/);
    expect((await blobContent(wt, deletedOld!))?.toString('utf8')).toBe('line one\r\nline two\r\n');
    const [, , renameOld, renameNew] = blobs.get('DOCS.md')!.split(' ');
    expect(renameOld).toBe(renameNew);
    expect((await blobContent(wt, blobs.get('keep.txt')!.split(' ')[3]!))?.toString('utf8')).toBe('changed\n');
  });

  it('is stable for unchanged content and changes when either side changes', async () => {
    const base = await newWorktree();
    writeFileSync(join(wt, 'keep.txt'), 'one\n');
    const first = await changedBlobs(wt, base, await snapshot(wt, null));
    const again = await changedBlobs(wt, base, await snapshot(wt, null));
    expect(again.get('keep.txt')).toBe(first.get('keep.txt'));
    writeFileSync(join(wt, 'keep.txt'), 'two\n');
    const second = await changedBlobs(wt, base, await snapshot(wt, null));
    expect(second.get('keep.txt')).not.toBe(first.get('keep.txt'));
    writeFileSync(join(wt, 'keep.txt'), 'one\n');
    const back = await snapshot(wt, null);
    expect((await changedBlobs(wt, base, back)).get('keep.txt')).toBe(first.get('keep.txt'));
    // A moved base (as after a rebase) changes the old side.
    const otherBase = await snapshot(repo, null);
    writeFileSync(join(repo, 'keep.txt'), 'moved\n');
    const movedBase = await snapshot(repo, null);
    expect(otherBase).not.toBe(movedBase);
    expect((await changedBlobs(wt, movedBase, back)).get('keep.txt')).not.toBe(first.get('keep.txt'));
  });

  it('notices a mode-only change', async () => {
    const base = await newWorktree();
    await git(['update-index', '--chmod=+x', 'keep.txt'], { cwd: wt });
    const blobs = await changedBlobs(wt, base, await snapshot(wt, null));
    expect(blobs.get('keep.txt')?.split(' ').slice(0, 2)).toEqual(['100644', '100755']);
  });

  it('reads blobs, and returns null for the zero id or an unknown blob', async () => {
    await newWorktree();
    const sha = (await git(['rev-parse', 'HEAD:keep.txt'], { cwd: wt })).trim();
    expect((await blobContent(wt, sha))?.toString('utf8')).toBe('keep\n');
    expect(await blobContent(wt, '0'.repeat(40))).toBeNull();
    expect(await blobContent(wt, 'f'.repeat(40))).toBeNull();
  });
});

describe('landing', () => {
  it('applies selected files to the checkout as uncommitted changes', async () => {
    const base = await newWorktree();
    writeFileSync(join(wt, 'one.txt'), 'one\n');
    writeFileSync(join(wt, 'two.txt'), 'two\n');
    const c = await snapshot(wt, null);
    await applyToCheckout(wt, repo, base, c, ['one.txt']);
    expect(readFileSync(join(repo, 'one.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repo, 'two.txt'))).toBe(false);
    expect(await revParse(repo, 'HEAD')).toBe(base);
  });

  it('commits selected files on the session branch', async () => {
    const base = await newWorktree();
    writeFileSync(join(wt, 'one.txt'), 'one\n');
    writeFileSync(join(wt, 'two.txt'), 'two\n');
    const head = await commitFiles(wt, ['one.txt'], 'Land one file');
    expect(head).not.toBe(base);
    expect(await revParse(repo, 'agent/session-1')).toBe(head);
    expect((await git(['status', '--porcelain'], { cwd: wt })).trim()).toBe('?? two.txt');
  });

  it('discards a session and keeps the final patch', async () => {
    const base = await newWorktree();
    await snapshot(wt, checkpointRef('s1', 0));
    writeFileSync(join(wt, 'gone.txt'), 'bye\n');
    const patchPath = join(root, 'patches', 's1.patch');
    const saved = await discardWorktree({ repo, worktree: wt, branch: 'agent/session-1', baseCommit: base, sessionId: 's1', patchPath });
    expect(saved).toBe(patchPath);
    expect(readFileSync(patchPath, 'utf8')).toContain('gone.txt');
    expect(existsSync(wt)).toBe(false);
    expect((await git(['branch', '--list', 'agent/session-1'], { cwd: repo })).trim()).toBe('');
    expect((await git(['for-each-ref', 'refs/ade/'], { cwd: repo })).trim()).toBe('');
  });
});

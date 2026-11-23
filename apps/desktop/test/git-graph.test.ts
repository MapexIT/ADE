import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '@ade/git';
import type { GitCommit, Session } from '@ade/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitGraph, parseDecorations, parseWorktrees } from '../src/host/git-graph.ts';
import { layoutGraph, relativeTime } from '../src/renderer/src/lib/git-graph.ts';

const c = (hash: string, parents: string[] = []): GitCommit => ({ hash, parents, author: 'a', time: 0, subject: hash, refs: [] });

describe('HI-09 lane layout', () => {
  it('keeps a straight history in one lane', () => {
    const { rows, width } = layoutGraph([c('c', ['b']), c('b', ['a']), c('a')]);
    expect(width).toBe(1);
    expect(rows.map((r) => [r.lane, r.into, r.out, r.tip])).toEqual([
      [0, [], [0], true],
      [0, [0], [0], false],
      [0, [0], [], false],
    ]);
  });

  it('opens a lane for a branch and joins it at the merge', () => {
    // m merges b (feature) into a (main); both start at base.
    const { rows, width } = layoutGraph([c('m', ['a', 'b']), c('b', ['base']), c('a', ['base']), c('base')]);
    expect(width).toBe(2);
    const [m, b, a, base] = rows;
    expect(m).toMatchObject({ lane: 0, out: [0, 1] });
    expect(b).toMatchObject({ lane: 1, into: [1], through: [0], out: [1] });
    expect(a).toMatchObject({ lane: 0, into: [0], through: [1], out: [0] });
    // Both lanes waited for base: they converge into one dot.
    expect(base).toMatchObject({ lane: 0, into: [0, 1], out: [] });
  });

  it('gives two branch tips their own lanes', () => {
    const { rows } = layoutGraph([c('x', ['base']), c('y', ['base']), c('base')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[1]).toMatchObject({ tip: true, through: [0] });
    expect(rows[2]!.into).toEqual([0, 1]);
  });

  it('says how long ago', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now / 1000 - 30, now)).toBe('just now');
    expect(relativeTime(now / 1000 - 7200, now)).toBe('2 hours ago');
    expect(relativeTime(now / 1000 - 86_400, now)).toBe('1 day ago');
  });
});

describe('HI-09 git parsing', () => {
  it('labels decorations', () => {
    expect(parseDecorations('HEAD -> main, origin/main, tag: v1.0, agent/fix')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'local' },
      { name: 'origin/main', kind: 'local' },
      { name: 'v1.0', kind: 'tag' },
      { name: 'agent/fix', kind: 'local' },
    ]);
    expect(parseDecorations('')).toEqual([]);
  });

  it('maps branches to worktrees', () => {
    expect([...parseWorktrees('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/1\nHEAD def\nbranch refs/heads/agent/x\n\nworktree /w/2\nHEAD 123\ndetached\n')]).toEqual([
      ['main', '/r'],
      ['agent/x', '/w/1'],
    ]);
  });
});

describe('HI-09 branch graph from a repository', () => {
  let repo: string;
  const run = (...args: string[]) => git(args, { cwd: repo });
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'ade-graph-'));
    await run('init', '-q', '-b', 'main');
    await run('config', 'user.name', 'T');
    await run('config', 'user.email', 't@example.invalid');
    const commit = async (file: string, msg: string) => {
      writeFileSync(join(repo, file), msg);
      await run('add', '-A');
      await run('commit', '-q', '-m', msg);
    };
    await commit('a.txt', 'base');
    await run('checkout', '-q', '-b', 'feature');
    await commit('f.txt', 'feature work');
    await run('checkout', '-q', 'main');
    await commit('m.txt', 'main work');
    await run('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    await run('branch', 'agent/fix-parser');
    await run('checkout', '-q', 'agent/fix-parser');
    await commit('p.txt', 'fix the parser');
    await run('checkout', '-q', 'main');
    await run('tag', 'v1');
    // An ADE checkpoint ref must not appear in the graph.
    await run('update-ref', 'refs/ade/checkpoints/s1/0', 'agent/fix-parser');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('lists branches with sessions and ahead/behind, and commits with refs, without ADE refs', async () => {
    const session = { id: 's1', title: 'Fix the parser', state: 'ready', agentId: 'fake', branch: 'agent/fix-parser' } as Session;
    const g = await gitGraph(repo, [session], { limit: 100, remotes: false });
    expect(g.currentBranch).toBe('main');
    expect(g.branches.map((b) => [b.name, b.current, b.ahead, b.behind, b.session?.title ?? null])).toEqual([
      ['main', true, null, null, null],
      ['agent/fix-parser', false, 1, 0, 'Fix the parser'],
      ['feature', false, 0, 2, null],
    ]);
    expect(g.commits.map((x) => x.subject)).toEqual(['fix the parser', 'Merge feature', 'feature work', 'main work', 'base']);
    expect(g.commits[1]!.parents).toHaveLength(2);
    expect(g.commits[1]!.refs).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'local' },
      { name: 'v1', kind: 'tag' },
    ]);
    expect(g.commits.flatMap((x) => x.refs.map((r) => r.name)).some((n) => n.includes('ade'))).toBe(false);
    expect(g.truncated).toBe(false);
    expect((await gitGraph(repo, [], { limit: 20, remotes: false })).commits).toHaveLength(5);
    const small = await gitGraph(repo, [], { limit: 2, remotes: false });
    expect(small).toMatchObject({ truncated: true });
    expect(small.commits).toHaveLength(2);
  });

  it('handles a repository without commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ade-graph-empty-'));
    await git(['init', '-q', '-b', 'main'], { cwd: empty });
    expect(await gitGraph(empty, [], { limit: 100, remotes: false })).toEqual({ head: null, currentBranch: 'main', branches: [], commits: [], truncated: false });
    rmSync(empty, { recursive: true, force: true });
  });
});

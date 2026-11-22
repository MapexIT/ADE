import type { FileEntry } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { ancestors, buildTree, changeMap, flatten, matchPath, relativeTo, rowFor, typeahead } from '../src/renderer/src/lib/file-tree.ts';

const files = ['README.md', 'src/main.ts', 'src/lib/util.ts', 'src/lib/Item10.ts', 'src/lib/Item9.ts', 'packages/ui/src/button.tsx', 'docs/a.md'];
const entries: FileEntry[] = [
  ...new Set(files.flatMap((f) => ancestors(f))),
].map((d) => ({ path: d, name: d.split('/').pop()!, isDir: true })).concat(files.map((f) => ({ path: f, name: f.split('/').pop()!, isDir: false })));

const tree = buildTree(entries);
const labels = (rows: { label: string; depth: number }[]) => rows.map((r) => `${'  '.repeat(r.depth)}${r.label}`);

describe('file tree', () => {
  it('sorts folders first, then names naturally', () => {
    expect(labels(flatten(tree, { expanded: new Set(['src', 'src/lib']) }))).toEqual([
      'docs',
      'packages/ui/src',
      'src',
      '  lib',
      '    Item9.ts',
      '    Item10.ts',
      '    util.ts',
      '  main.ts',
      'README.md',
    ]);
  });

  it('compacts single-folder chains into one row that opens the deepest folder', () => {
    const rows = flatten(tree, { expanded: new Set(['packages/ui/src']) });
    const row = rows.find((r) => r.label === 'packages/ui/src')!;
    expect(row).toMatchObject({ path: 'packages/ui/src', expanded: true, isDir: true });
    expect(rows[rows.indexOf(row) + 1]).toMatchObject({ label: 'button.tsx', depth: 1, parent: 'packages/ui/src' });
    expect(labels(flatten(tree, { expanded: new Set(), compact: false })).slice(0, 2)).toEqual(['docs', 'packages']);
  });

  it('marks changed files and counts them on every folder above', () => {
    const changes = changeMap([
      { path: 'src/lib/util.ts', status: 'modified', additions: 1, deletions: 1, oldPath: null },
      { path: 'src/new.ts', status: 'added', additions: 3, deletions: 0, oldPath: null },
      { path: 'docs/a.md', status: 'binary', additions: 0, deletions: 0, oldPath: null },
    ] as never);
    const rows = flatten(tree, { expanded: new Set(['src', 'src/lib']), changes });
    expect(rows.find((r) => r.path === 'src')!.changedBelow).toBe(2);
    expect(rows.find((r) => r.path === 'src/lib')!.changedBelow).toBe(1);
    expect(rows.find((r) => r.path === 'src/lib/util.ts')!.change).toBe('modified');
    expect(rows.find((r) => r.path === 'docs')!.changedBelow).toBe(1);
    // "Changed only" shows just those files, with their folders open.
    expect(labels(flatten(tree, { expanded: new Set(), changes, changedOnly: true }))).toEqual(['docs', '  a.md', 'src/lib', '  util.ts']);
  });

  it('filters by substring or by characters in order, and highlights the match in the name', () => {
    expect(matchPath('src/lib/util.ts', 'util')).toEqual([8, 9, 10, 11]);
    expect(matchPath('packages/ui/src/button.tsx', 'pkbtn')).not.toBeNull();
    expect(matchPath('src/main.ts', 'zz')).toBeNull();
    const rows = flatten(tree, { expanded: new Set(), filter: 'util' });
    expect(labels(rows)).toEqual(['src/lib', '  util.ts']);
    expect(rows[1]!.match).toEqual([[0, 4]]);
    // A query matching a folder name highlights it inside a compacted label.
    const byFolder = flatten(tree, { expanded: new Set(), filter: 'ui/src' });
    expect(byFolder[0]).toMatchObject({ label: 'packages/ui/src', match: [[9, 15]] });
  });

  it('jumps by typed prefix and finds where a file is shown', () => {
    const rows = flatten(tree, { expanded: new Set(['src', 'src/lib']) });
    expect(rows[typeahead(rows, 0, 'ma')]!.label).toBe('main.ts');
    expect(rows[typeahead(rows, 0, 'qq')]).toBe(rows[0]);
    const collapsed = flatten(tree, { expanded: new Set() });
    expect(collapsed[rowFor(collapsed, 'packages/ui/src/button.tsx')]!.label).toBe('packages/ui/src');
    expect(rowFor(collapsed, 'nowhere.ts')).toBe(-1);
  });

  it('maps an absolute path to the tree on both platforms', () => {
    expect(relativeTo('C:\\work\\repo', 'c:\\Work\\repo\\src\\main.ts', true)).toBe('src/main.ts');
    expect(relativeTo('/home/me/repo', '/home/me/repo/src/main.ts', false)).toBe('src/main.ts');
    expect(relativeTo('/home/me/repo', '/home/me/Repo/src/main.ts', false)).toBeNull();
    expect(relativeTo('/home/me/repo', '/home/me/repo2/x.ts', false)).toBeNull();
  });
});

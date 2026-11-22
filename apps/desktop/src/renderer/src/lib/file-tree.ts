import type { FileChange, FileEntry } from '@ade/contracts';

/** A folder or file in the tree. Paths are relative to the root and use forward slashes. */
export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  children: TreeNode[];
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** One visible row. Compacted folders ("src/renderer/src") are one row whose `path` is the deepest folder. */
export interface TreeRow {
  path: string;
  label: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  /** For a file: its own change. For a folder: whether anything below it changed. */
  change: ChangeKind | null;
  changedBelow: number;
  /** Characters of `label` that matched the filter, as [start, end) ranges. */
  match: [number, number][];
  parent: string | null;
}

const byFoldersThenName = (a: TreeNode, b: TreeNode) =>
  a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1;

/** Builds the tree from the host's flat list (folders and files, in any order). */
export function buildTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { path: '', name: '', isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  const dir = (path: string): TreeNode => {
    const found = dirs.get(path);
    if (found) return found;
    const cut = path.lastIndexOf('/');
    const node: TreeNode = { path, name: path.slice(cut + 1), isDir: true, children: [] };
    dirs.set(path, node);
    dir(cut < 0 ? '' : path.slice(0, cut)).children.push(node);
    return node;
  };
  for (const e of entries) {
    if (e.isDir) dir(e.path);
    else {
      const cut = e.path.lastIndexOf('/');
      dir(cut < 0 ? '' : e.path.slice(0, cut)).children.push({ path: e.path, name: e.name, isDir: false, children: [] });
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort(byFoldersThenName);
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Git statuses as the tree shows them; binary files count as modified. */
export function changeMap(changes: FileChange[]): Map<string, ChangeKind> {
  const m = new Map<string, ChangeKind>();
  for (const c of changes) m.set(c.path, c.status === 'binary' ? 'modified' : c.status);
  return m;
}

/** Every folder above a path, nearest last: `a/b/c.ts` -> [`a`, `a/b`]. */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * Filter match against a path: a substring of the path, or failing that, the query's characters in order
 * (so "sesview" finds "session/SessionView.tsx"). Returns the matched positions in the path, or null.
 */
export function matchPath(path: string, query: string): number[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const p = path.toLowerCase();
  // Prefer a match in the file name, then anywhere in the path.
  const nameStart = p.lastIndexOf('/') + 1;
  const inName = p.indexOf(q, nameStart);
  const at = inName >= 0 ? inName : p.indexOf(q);
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i);
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < p.length && j < q.length; i++) if (p[i] === q[j]) (out.push(i), j++);
  return j === q.length ? out : null;
}

/** Positions inside a label that starts at `offset` in the path, merged into ranges. */
function rangesIn(positions: number[], offset: number, length: number): [number, number][] {
  const out: [number, number][] = [];
  for (const pos of positions) {
    const i = pos - offset;
    if (i < 0 || i >= length) continue;
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

export interface FlattenOptions {
  expanded: ReadonlySet<string>;
  changes?: ReadonlyMap<string, ChangeKind>;
  filter?: string;
  changedOnly?: boolean;
  /** Join folders that hold exactly one folder and nothing else into one row, as VS Code does. */
  compact?: boolean;
}

/**
 * The visible rows, depth first. A filter (or "changed only") shows matching files with their folders, all
 * expanded; otherwise folders open as the user left them.
 */
export function flatten(root: TreeNode, opts: FlattenOptions): TreeRow[] {
  const changes = opts.changes ?? new Map<string, ChangeKind>();
  const query = opts.filter?.trim() ?? '';
  const filtering = query.length > 0 || !!opts.changedOnly;

  // Which files survive the filter, with their match positions, and how many changes sit under each folder.
  const matches = new Map<string, number[]>();
  const keep = new Set<string>();
  const changedBelow = new Map<string, number>();
  for (const [path] of changes) for (const a of ancestors(path)) changedBelow.set(a, (changedBelow.get(a) ?? 0) + 1);
  if (filtering) {
    const visit = (n: TreeNode) => {
      if (n.isDir) return n.children.forEach(visit);
      if (opts.changedOnly && !changes.has(n.path)) return;
      const m = matchPath(n.path, query);
      if (!m) return;
      matches.set(n.path, m);
      keep.add(n.path);
      for (const a of ancestors(n.path)) keep.add(a);
    };
    visit(root);
  }

  const rows: TreeRow[] = [];
  // While filtering, a folder's children are only the ones left visible; compaction follows what is shown.
  const visible = (n: TreeNode) => (filtering ? n.children.filter((c) => keep.has(c.path)) : n.children);
  const walk = (n: TreeNode, depth: number, parent: string | null) => {
    for (const child of visible(n)) {
      let node = child;
      let label = child.name;
      const start = child.path.length - child.name.length;
      if (opts.compact !== false && node.isDir) {
        for (let only = visible(node); only.length === 1 && only[0]!.isDir; only = visible(node)) {
          node = only[0]!;
          label += `/${node.name}`;
        }
      }
      const expanded = node.isDir && (filtering || opts.expanded.has(node.path));
      rows.push({
        path: node.path,
        label,
        depth,
        isDir: node.isDir,
        expanded,
        change: node.isDir ? null : (changes.get(node.path) ?? null),
        changedBelow: node.isDir ? (changedBelow.get(node.path) ?? 0) : 0,
        match: query ? rangesIn((node.isDir ? matchPath(node.path, query) : matches.get(node.path)) ?? [], start, label.length) : [],
        parent,
      });
      if (expanded) walk(node, depth + 1, node.path);
    }
  };
  walk(root, 0, null);
  return rows;
}

/** Type-ahead (WAI-ARIA tree pattern): the next row after `from` whose label starts with the typed text. */
export function typeahead(rows: TreeRow[], from: number, text: string): number {
  const t = text.toLowerCase();
  for (let k = 1; k <= rows.length; k++) {
    const i = (from + k) % rows.length;
    if (rows[i]!.label.toLowerCase().startsWith(t)) return i;
  }
  return from;
}

/** The deepest visible row that is or contains `path` (where to reveal a file whose folders are compacted). */
export function rowFor(rows: TreeRow[], path: string): number {
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.path === path) return i;
    if (r.isDir && path.startsWith(`${r.path}/`)) best = i;
  }
  return best;
}

/**
 * The tree path of an absolute file path under `root`, or null when it lies outside. Separators are normalised,
 * and the comparison ignores case on Windows, where paths are case-insensitive.
 */
export function relativeTo(root: string, abs: string, windows: boolean): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const a = norm(abs);
  const same = windows ? a.toLowerCase().startsWith(`${r.toLowerCase()}/`) : a.startsWith(`${r}/`);
  return same ? a.slice(r.length + 1) : null;
}

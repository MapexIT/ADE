import {
  ChevronRight,
  ChevronsDownUp,
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  GitCompareArrows,
  LocateFixed,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { cx } from '@ade/ui';
import type { FileChange, FileEntry } from '@ade/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { host, platform } from '../lib/bridge.ts';
import { joinPath } from '../lib/format.ts';
import { ancestors, buildTree, changeMap, flatten, relativeTo, rowFor, typeahead, type ChangeKind, type TreeRow } from '../lib/file-tree.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Tooltip } from './Tooltip.tsx';

const ROW = 26;
const INDENT = 14;

/** Folders the user opened, per root, for as long as the app runs. */
const expandedByRoot = new Map<string, Set<string>>();

const ICONS: [RegExp, typeof File][] = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|html|css|scss|sql)$/i, FileCode],
  [/\.(json|jsonc|json5)$/i, FileBraces],
  [/\.(md|mdx|txt|rst|adoc)$/i, FileText],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i, FileImage],
  [/\.(ya?ml|toml|ini|env|conf|cfg|editorconfig)$|^\.(git\w*|npmrc|nvmrc|prettierrc|eslintrc.*)$|config\.\w+$/i, FileCog],
  [/\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd)$/i, FileTerminal],
  [/(\.lock|-lock\.(json|yaml))$/i, FileLock],
  [/\.(zip|tar|gz|tgz|7z|rar)$/i, FileArchive],
  [/\.(csv|tsv|xlsx?)$/i, FileSpreadsheet],
  [/\.(mp4|mov|webm|mkv)$/i, FilePlay],
  [/\.(mp3|wav|ogg|flac)$/i, FileMusic],
  [/\.(ttf|otf|woff2?)$/i, FileType],
];
const iconFor = (name: string) => ICONS.find(([re]) => re.test(name))?.[1] ?? File;

const CHANGE: Record<ChangeKind, { letter: string; label: string; className: string }> = {
  added: { letter: 'A', label: 'Added', className: 'text-accent-soft' },
  modified: { letter: 'M', label: 'Modified', className: 'text-accent-soft' },
  renamed: { letter: 'R', label: 'Renamed', className: 'text-accent-soft' },
  deleted: { letter: 'D', label: 'Deleted', className: 'text-ink-muted' },
};

/** The label with the filter's matches highlighted. */
function Label({ text, match }: { text: string; match: [number, number][] }) {
  if (!match.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of match) {
    if (s > at) parts.push(text.slice(at, s));
    parts.push(
      <mark key={s} className="rounded-[2px] bg-accent-tint font-semibold text-accent-soft">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function ToolButton({ label, description, pressed, onClick, children }: { label: string; description?: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label} description={description}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cx(
          'flex size-7 items-center justify-center rounded-[var(--radius-small)] text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
          pressed && 'bg-accent-tint text-accent-soft hover:text-accent-soft',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The files of a workspace or worktree as a tree: compact folders, indent guides, file-type icons, the session's
 * changes marked on files and folders, a filter that opens the folders it matches in, and the editor's file
 * revealed. Keyboard follows the WAI-ARIA tree pattern (arrows, Home/End, Enter, *, type-ahead).
 */
export function FileTree({ root, sessionId, changes = [] }: { root: string; sessionId: string | null; changes?: FileChange[] }) {
  const openEditor = useStore((s) => s.openEditor);
  const setTab = useStore((s) => s.setTab);
  const editorPath = useStore((s) => s.editor?.path ?? null);
  const lastSeq = useStore((s) => (sessionId ? (s.views[sessionId]?.lastSeq ?? 0) : 0));
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => expandedByRoot.get(root) ?? new Set());
  const [filter, setFilter] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const windows = platform() === 'win32';
  const id = useMemo(() => `ft-${Math.random().toString(36).slice(2, 8)}`, []);

  const load = useCallback(() => void attempt(() => host.call('files.list', { root })).then((f) => setEntries(f ?? [])), [root]);
  useEffect(() => {
    setExpanded(expandedByRoot.get(root) ?? new Set());
    setEntries(null);
    load();
  }, [root, load]);
  // New files from the agent appear without a manual refresh.
  useEffect(() => {
    if (!lastSeq) return;
    const t = setTimeout(load, 800);
    return () => clearTimeout(t);
  }, [lastSeq, load]);

  const changeKinds = useMemo(() => changeMap(changes), [changes]);
  // Deleted files are gone from disk; keep them in the tree so the change stays visible.
  const tree = useMemo(() => {
    const extra: FileEntry[] = [];
    for (const [path, kind] of changeKinds) {
      if (kind !== 'deleted') continue;
      for (const a of ancestors(path)) extra.push({ path: a, name: a.split('/').pop()!, isDir: true });
      extra.push({ path, name: path.split('/').pop()!, isDir: false });
    }
    const seen = new Set((entries ?? []).map((e) => e.path));
    return buildTree([...(entries ?? []), ...extra.filter((e) => !seen.has(e.path))]);
  }, [entries, changeKinds]);
  const rows = useMemo(() => flatten(tree, { expanded, changes: changeKinds, filter, changedOnly }), [tree, expanded, changeKinds, filter, changedOnly]);
  const fileCount = useMemo(() => (entries ?? []).filter((e) => !e.isDir).length, [entries]);
  const openRel = editorPath ? relativeTo(root, editorPath, windows) : null;

  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => treeRef.current, estimateSize: () => ROW, overscan: 12 });

  const update = (next: Set<string>) => {
    expandedByRoot.set(root, next);
    setExpanded(next);
  };
  const toggle = (path: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(path)) next.add(path);
    else next.delete(path);
    update(next);
  };
  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, i));
    setActive(clamped);
    virtualizer.scrollToIndex(clamped, { align: 'auto' });
  };

  // Reveal the editor's file: open its folders and bring its row into view.
  const reveal = useCallback(
    (rel: string) => {
      const prev = expandedByRoot.get(root) ?? new Set<string>();
      const next = new Set([...prev, ...ancestors(rel)]);
      expandedByRoot.set(root, next);
      setExpanded(next);
    },
    [root],
  );
  // Follows the editor without disturbing a filter; the Reveal button also clears it.
  useEffect(() => {
    if (openRel) reveal(openRel);
  }, [openRel, reveal]);
  useEffect(() => {
    if (!openRel) return;
    const i = rowFor(rows, openRel);
    if (i >= 0) {
      setActive(i);
      virtualizer.scrollToIndex(i, { align: 'auto' });
    }
    // Scroll once the rows for the revealed file exist; not on every later change of the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRel, rows.length]);
  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  const activate = (row: TreeRow) => {
    if (row.isDir) return toggle(row.path);
    if (row.change === 'deleted') return setTab('review');
    openEditor(joinPath(root, row.path), sessionId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[active];
    if (!row) return;
    const key = e.key;
    if (key === 'ArrowDown') focusRow(active + 1);
    else if (key === 'ArrowUp') focusRow(active - 1);
    else if (key === 'Home') focusRow(0);
    else if (key === 'End') focusRow(rows.length - 1);
    else if (key === 'ArrowRight') {
      if (row.isDir && !row.expanded) toggle(row.path, true);
      else if (row.isDir) focusRow(active + 1);
    } else if (key === 'ArrowLeft') {
      if (row.isDir && row.expanded && !filter && !changedOnly) toggle(row.path, false);
      else if (row.parent !== null) focusRow(rows.findIndex((r) => r.path === row.parent));
    } else if (key === 'Enter' || key === ' ') activate(row);
    else if (key === '*') {
      // Expand every folder at this level (WAI-ARIA tree pattern).
      const next = new Set(expanded);
      for (const r of rows) if (r.isDir && r.parent === row.parent) next.add(r.path);
      update(next);
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 600 ? typed.current.text + key : key, at: now };
      focusRow(typeahead(rows, typed.current.text.length > 1 ? active - 1 : active, typed.current.text));
    } else return;
    e.preventDefault();
  };

  const filtering = !!filter.trim() || changedOnly;
  const activeRow = rows[active];
  // The guide of the active row's folder is drawn brighter, as editors do.
  const activeParentDepth = activeRow ? activeRow.depth - 1 : -1;
  const activeParent = activeRow?.parent ?? null;
  const underActiveParent = (path: string) => activeParent !== null && path.startsWith(`${activeParent}/`);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
          <label htmlFor={`${id}-filter`} className="sr-only">
            Filter files
          </label>
          <input
            id={`${id}-filter`}
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                setFilter('');
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault();
                if (e.key === 'Enter' && rows[0] && filter) {
                  const firstFile = rows.find((r) => !r.isDir);
                  if (firstFile) return activate(firstFile);
                }
                treeRef.current?.focus();
              }
            }}
            placeholder="Filter files"
            className="min-h-8 w-full rounded-[var(--radius)] border border-line bg-bg pr-7 pl-8 text-[13px] text-ink focus:border-accent focus:outline-none"
          />
          {filter ? (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => {
                setFilter('');
                filterRef.current?.focus();
              }}
              className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[var(--radius-small)] text-ink-muted hover:text-ink"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <ToolButton label="Changed only" description="Show only the files this session changed." pressed={changedOnly} onClick={() => setChangedOnly((v) => !v)}>
          <GitCompareArrows className="size-4" aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Reveal open file"
          onClick={() => {
            if (!openRel) return;
            setFilter('');
            setChangedOnly(false);
            reveal(openRel);
            const i = rowFor(flatten(tree, { expanded: new Set([...expanded, ...ancestors(openRel)]), changes: changeKinds }), openRel);
            if (i >= 0) focusRow(i);
          }}
        >
          <LocateFixed className="size-4" aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Collapse all" onClick={() => update(new Set())}>
          <ChevronsDownUp className="size-4" aria-hidden="true" />
        </ToolButton>
        <ToolButton label="Refresh" onClick={load}>
          <RefreshCw className="size-4" aria-hidden="true" />
        </ToolButton>
      </div>

      <div
        ref={treeRef}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        aria-activedescendant={activeRow ? `${id}-${active}` : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="relative min-h-0 flex-1 overflow-auto rounded-[var(--radius)] outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {entries === null ? (
          <p className="m-0 p-2 text-ink-muted">Loading files…</p>
        ) : rows.length === 0 ? (
          <p className="m-0 p-2 text-ink-muted">{changedOnly ? 'No changed files match.' : filter ? 'No files match.' : 'No files.'}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]!;
              const Icon = row.isDir ? (row.expanded ? FolderOpen : Folder) : iconFor(row.label);
              const isOpen = !row.isDir && row.path === openRel;
              const isActive = v.index === active;
              const change = row.change ? CHANGE[row.change] : null;
              return (
                <div
                  key={row.path}
                  id={`${id}-${v.index}`}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.isDir ? row.expanded : undefined}
                  aria-selected={isOpen}
                  aria-label={`${row.label}${change ? `, ${change.label.toLowerCase()}` : ''}${row.changedBelow ? `, ${row.changedBelow} changed inside` : ''}`}
                  title={row.path}
                  onClick={() => {
                    setActive(v.index);
                    activate(row);
                  }}
                  className={cx(
                    'group absolute top-0 left-0 flex w-full cursor-pointer items-center gap-1.5 pr-2 text-[13px] select-none',
                    isOpen ? 'bg-accent-tint text-ink' : 'hover:bg-surface-raised',
                    isActive && focused && 'outline outline-1 -outline-offset-1 outline-accent',
                  )}
                  style={{ height: ROW, transform: `translateY(${v.start}px)`, paddingLeft: 6 + row.depth * INDENT }}
                >
                  {Array.from({ length: row.depth }, (_, d) => (
                    <span
                      key={d}
                      aria-hidden="true"
                      className={cx('absolute top-0 bottom-0 w-px', d === activeParentDepth && underActiveParent(row.path) ? 'bg-ink-muted/60' : 'bg-line')}
                      style={{ left: 6 + d * INDENT + 7 }}
                    />
                  ))}
                  <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center justify-center text-ink-muted">
                    {row.isDir ? <ChevronRight className={cx('size-3.5 transition-transform duration-150', row.expanded && 'rotate-90')} /> : null}
                  </span>
                  <Icon aria-hidden="true" className={cx('size-4 shrink-0', row.isDir ? 'text-accent-soft' : isOpen ? 'text-ink' : 'text-ink-muted')} />
                  <span className={cx('min-w-0 flex-1 truncate', row.change === 'deleted' && 'text-ink-muted line-through', change && row.change !== 'deleted' && 'text-ink')}>
                    <Label text={row.label} match={row.match} />
                  </span>
                  {change ? (
                    <span aria-hidden="true" className={cx('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', change.className)}>
                      {change.letter}
                    </span>
                  ) : row.changedBelow ? (
                    <span aria-hidden="true" className="flex w-3 shrink-0 justify-center">
                      <span className="size-1.5 rounded-full bg-accent" />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-[11px] text-ink-muted">
        <span>{entries ? `${fileCount.toLocaleString('en-GB')} files${changeKinds.size ? ` · ${changeKinds.size} changed` : ''}` : ''}</span>
        {filtering ? <span>{rows.filter((r) => !r.isDir).length} shown</span> : <span className="hidden sm:inline">Arrows to move, Enter to open</span>}
      </div>
    </div>
  );
}

import { Check, Copy, GitBranch as GitBranchIcon, Maximize2, MessagesSquare, RefreshCw } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import type { GitBranch, GitCommit, GitGraph } from '@ade/contracts';
import { STATE_LABELS } from '@ade/session-core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { layoutGraph, relativeTime, type GraphRow } from '../lib/git-graph.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Modal } from './Modal.tsx';

const ROW = 28;
const LANE = 14;
/** Lane colours within the three-colour palette: violet, white and their softer tones. */
const LANE_COLOURS = ['var(--accent)', 'var(--ink)', 'var(--accent-soft)', 'var(--ink-muted)'];
const colour = (lane: number) => LANE_COLOURS[lane % LANE_COLOURS.length]!;

function Lanes({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => lane * LANE + LANE / 2;
  const mid = ROW / 2;
  return (
    <svg width={width * LANE} height={ROW} aria-hidden="true" className="shrink-0 overflow-visible">
      {row.through.map((l) => (
        <line key={`t${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW} stroke={colour(l)} strokeWidth={1.5} />
      ))}
      {row.into.map((l) => (
        <path key={`i${l}`} d={`M ${x(l)} 0 C ${x(l)} ${mid / 2}, ${x(row.lane)} ${mid / 2}, ${x(row.lane)} ${mid}`} fill="none" stroke={colour(l)} strokeWidth={1.5} />
      ))}
      {row.out.map((l) => (
        <path key={`o${l}`} d={`M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + mid / 2}, ${x(l)} ${mid + mid / 2}, ${x(l)} ${ROW}`} fill="none" stroke={colour(l)} strokeWidth={1.5} />
      ))}
      <circle cx={x(row.lane)} cy={mid} r={row.commit.parents.length > 1 ? 3 : 4} fill={row.commit.parents.length > 1 ? 'var(--bg)' : colour(row.lane)} stroke={colour(row.lane)} strokeWidth={2} />
    </svg>
  );
}

function RefChip({ r, sessionTitle }: { r: GitCommit['refs'][number]; sessionTitle?: string | undefined }) {
  if (r.kind === 'head') return <Badge tone="accent" className="font-semibold">HEAD</Badge>;
  return (
    <Badge tone={r.kind === 'local' ? 'accent' : 'neutral'} className={cx('max-w-48 font-mono text-[11px]', r.kind === 'remote' && 'border-dashed')} title={sessionTitle ? `${r.name} · session: ${sessionTitle}` : r.name}>
      {r.kind === 'tag' ? 'tag ' : ''}
      <span className="truncate">{r.name}</span>
    </Badge>
  );
}

/**
 * HI-12: the repository's branches as a commit graph: lanes and merges, branch, remote and tag labels, which session
 * owns a branch and how far each is ahead of or behind the checkout. Read-only.
 */
export function BranchGraph({
  workspaceId,
  highlight,
  expandable = true,
  details = true,
  selected: controlled,
  onSelect,
}: {
  workspaceId: string;
  highlight?: string | null | undefined;
  expandable?: boolean;
  /** Show the small details box under the graph (off where a page shows details beside it). */
  details?: boolean;
  /** Controlled selection, for pages that show the selected commit elsewhere. */
  selected?: string | null;
  onSelect?: (hash: string | null) => void;
}) {
  const [remotes, setRemotes] = useState(false);
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  const selected = controlled !== undefined ? controlled : own;
  const setSelected = useCallback(
    (hash: string | null) => {
      setOwn(hash);
      onSelect?.(hash);
    },
    [onSelect],
  );
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const selectSession = useStore((s) => s.selectSession);
  // Reload when any session in the workspace changes state (a turn ends, a branch lands).
  const sessionKey = useStore((s) =>
    Object.values(s.sessions)
      .filter((x) => x.workspaceId === workspaceId)
      .map((x) => `${x.id}:${x.state}`)
      .join('|'),
  );

  const load = useCallback(async () => {
    setLoading(true);
    const g = await attempt(() => host.call('git.graph', { workspaceId, limit: 400, remotes }));
    setLoading(false);
    if (g) setGraph(g);
  }, [workspaceId, remotes]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load, sessionKey]);

  const { rows, width } = useMemo(() => layoutGraph(graph?.commits ?? []), [graph]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.hash, i])), [rows]);
  const sessionByBranch = useMemo(() => new Map((graph?.branches ?? []).filter((b) => b.session).map((b) => [b.name, b.session!])), [graph]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW, overscan: 12, getItemKey: (i) => rows[i]?.commit.hash ?? i });

  const jump = (hash: string) => {
    const i = index.get(hash);
    setSelected(hash);
    if (i !== undefined) virtualizer.scrollToIndex(i, { align: 'center' });
  };
  // Show the selected session's branch when it first appears.
  const highlightHead = highlight ? graph?.branches.find((b) => b.name === highlight)?.head : undefined;
  useEffect(() => {
    if (highlightHead) jump(highlightHead);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightHead]);
  // With nothing selected yet (or the selection gone after a reload), a controlled graph starts at HEAD.
  useEffect(() => {
    if (!onSelect || !graph?.commits.length) return;
    if (selected && index.has(selected)) return;
    if (highlightHead && index.has(highlightHead)) return;
    setSelected(graph.head && index.has(graph.head) ? graph.head : graph.commits[0]!.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Keyboard: arrows move the selection, Page Up and Down by ten, Home and End to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const at = selected ? (index.get(selected) ?? -1) : -1;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    let next: number | null = null;
    if (step !== undefined) next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + step));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    if (next === null) return;
    e.preventDefault();
    const hash = rows[next]!.commit.hash;
    setSelected(hash);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const commit = selected ? graph?.commits.find((c) => c.hash === selected) : undefined;
  const branchesHere = (b: GitBranch) => (b.ahead === null ? null : b.ahead === 0 && b.behind === 0 ? 'same as HEAD' : [b.ahead ? `${b.ahead} ahead` : '', b.behind ? `${b.behind} behind` : ''].filter(Boolean).join(' · '));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-8 items-center gap-2 text-[12px]">
          <input type="checkbox" checked={remotes} onChange={(e) => setRemotes(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Remote branches
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="dense" variant="ghost" className="w-9 px-0" aria-label="Refresh branches" onClick={() => void load()}>
            <RefreshCw className={cx('size-4', loading && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
          </Button>
          {expandable ? (
            <Button size="dense" variant="ghost" className="w-9 px-0" aria-label="Open the branch graph in a larger view" onClick={() => setExpanded(true)}>
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      <details open className="shrink-0">
        <summary className="cursor-pointer text-[12px] font-semibold text-ink-muted">Branches ({graph?.branches.length ?? 0})</summary>
        <ul className="m-0 mt-1 flex max-h-40 list-none flex-col gap-0.5 overflow-auto p-0" aria-label="Branches">
          {(graph?.branches ?? []).map((b) => (
            <li key={`${b.kind}:${b.name}`}>
              <button
                type="button"
                onClick={() => jump(b.head)}
                className={cx('flex min-h-7 w-full items-center gap-2 rounded px-1.5 text-left text-[12px] hover:bg-surface-raised', highlight === b.name && 'bg-accent-tint')}
              >
                <GitBranchIcon className={cx('size-3.5 shrink-0', b.current ? 'text-accent' : 'text-ink-muted')} aria-hidden="true" />
                <span className={cx('min-w-0 truncate font-mono', b.current && 'font-semibold')}>{b.name}</span>
                {b.current ? <Badge tone="accent">current</Badge> : null}
                {b.kind === 'remote' ? <Badge className="border-dashed">remote</Badge> : null}
                {b.session ? (
                  <Badge title={`Session: ${b.session.title}`} className="max-w-40">
                    <span className="truncate">{b.session.title}</span> · {STATE_LABELS[b.session.state]}
                  </Badge>
                ) : null}
                <span className="ml-auto shrink-0 text-ink-muted">{branchesHere(b)}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      <div
        ref={parentRef}
        role="listbox"
        aria-label="Commit graph"
        tabIndex={0}
        aria-activedescendant={selected && index.has(selected) ? `commit-${selected}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-32 flex-1 overflow-auto rounded-[var(--radius)] border border-line bg-bg outline-none focus-visible:border-accent"
      >
        {graph && !rows.length ? <p className="m-3 text-ink-muted">This repository has no commits yet.</p> : null}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            const c = row.commit;
            return (
              <div
                key={v.key}
                id={`commit-${c.hash}`}
                role="option"
                aria-label={`${c.subject}, ${c.hash.slice(0, 7)}`}
                aria-selected={selected === c.hash}
                onClick={() => setSelected(c.hash)}
                className={cx('absolute left-0 flex w-full cursor-pointer items-center gap-2 pr-2 pl-3.5 text-[12px] hover:bg-surface-raised', selected === c.hash && 'bg-accent-tint shadow-[inset_3px_0_0_var(--accent)]')}
                style={{ height: ROW, transform: `translateY(${v.start}px)` }}
              >
                <Lanes row={row} width={width} />
                <span className="flex shrink-0 gap-1">
                  {c.refs.map((r) => (
                    <RefChip key={`${r.kind}:${r.name}`} r={r} sessionTitle={sessionByBranch.get(r.name)?.title} />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="hidden shrink-0 text-ink-muted sm:inline">{relativeTime(c.time)}</span>
              </div>
            );
          })}
        </div>
        {graph?.truncated ? <p className="m-2 text-[12px] text-ink-muted">Showing the newest {graph.commits.length} commits.</p> : null}
      </div>

      {details && commit ? (
        <section aria-label="Commit details" className="flex shrink-0 flex-col gap-1 rounded-[var(--radius)] border border-line bg-surface-sunken p-2 text-[12px]">
          <span className="font-semibold">{commit.subject}</span>
          <span className="text-ink-muted">
            {commit.author} · {new Date(commit.time * 1000).toLocaleString('en-GB')}
          </span>
          <span className="flex items-center gap-1 font-mono">
            {commit.hash}
            <Button
              size="dense"
              variant="ghost"
              className="w-8 px-0"
              aria-label="Copy commit hash"
              onClick={() =>
                void navigator.clipboard.writeText(commit.hash).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                })
              }
            >
              {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            </Button>
          </span>
          {commit.parents.length ? (
            <span className="flex flex-wrap items-center gap-1 text-ink-muted">
              {commit.parents.length > 1 ? 'Merge of' : 'Parent'}
              {commit.parents.map((p) => (
                <button key={p} type="button" className="rounded px-1 font-mono text-ink hover:bg-surface-raised" onClick={() => jump(p)}>
                  {p.slice(0, 7)}
                </button>
              ))}
            </span>
          ) : null}
          {commit.refs
            .filter((r) => r.kind === 'local' && sessionByBranch.has(r.name))
            .map((r) => {
              const s = sessionByBranch.get(r.name)!;
              return (
                <Button icon={<MessagesSquare className="size-4" aria-hidden="true" />} key={r.name} size="dense" className="self-start" onClick={() => selectSession(s.id)}>
                  Open session: {s.title}
                </Button>
              );
            })}
        </section>
      ) : null}

      {expandable ? (
        <Modal open={expanded} onOpenChange={setExpanded} title="Branches" description="Every branch of this repository, newest commits first. Session branches show their session." wide>
          <div className="flex h-[65vh] flex-col">
            <BranchGraph workspaceId={workspaceId} highlight={highlight} expandable={false} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

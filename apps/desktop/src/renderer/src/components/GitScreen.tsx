import { Check, Copy, FileDiff, GitCommitHorizontal, GitFork } from 'lucide-react';
import { SafeDiffEditor as DiffEditor } from './SafeDiffEditor.tsx';
import { Badge, Button, cx, EmptyState, SectionLabel, Waiting } from '@ade/ui';
import type { DiffText, FileChange, GitCommitDetail } from '@ade/contracts';
import { useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { languageOf } from '../lib/format.ts';
import { relativeTime } from '../lib/git-graph.ts';
import { EDITOR_OPTIONS } from '../lib/monaco.ts';
import { attempt, currentWorkspace, selectedSession, useStore } from '../lib/store.ts';
import { BranchGraph } from './BranchGraph.tsx';

const STATUS_LETTER: Record<FileChange['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', binary: 'B' };

/** Loads the commit the graph stops on. Moving quickly through the graph only loads the last one. */
function useCommit(workspaceId: string, hash: string | null) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  useEffect(() => {
    if (!hash) return setDetail(null);
    let live = true;
    const t = setTimeout(() => {
      void host
        .call('git.commit', { workspaceId, hash })
        .then((d) => live && setDetail(d))
        .catch(() => live && setDetail(null));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [workspaceId, hash]);
  return detail && hash && detail.hash.startsWith(hash.slice(0, 7)) ? detail : null;
}

/**
 * HI-12: Git, built around the branch graph. The graph is the main component, in the middle; the selected commit is
 * shown on both sides of it: its message, author, parents and changed files on the left, the selected file's diff
 * on the right. Mouse or arrow keys move through the graph. Read-only: nothing here changes the repository.
 */
export function GitScreen() {
  const workspace = useStore(currentWorkspace);
  const session = useStore(selectedSession);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileChange | null>(null);
  // A different repository starts again at its HEAD.
  useEffect(() => setSelected(null), [workspace?.id]);
  const detail = useCommit(workspace?.id ?? '', workspace ? selected : null);
  // Each commit opens on its first file.
  useEffect(() => setFile(detail?.files[0] ?? null), [detail]);

  if (!workspace) {
    return <EmptyState icon={<GitFork className="size-5" />} title="Open a repository to see its branches" body="Every branch and commit, with the sessions that own them." />;
  }
  return (
    <main aria-label="Git" className="grid h-full min-h-0 grid-cols-1 gap-3 bg-surface p-3 lg:grid-cols-[minmax(240px,24%)_minmax(380px,1fr)_minmax(300px,34%)]">
      <CommitInfo hash={selected} detail={detail} file={file} onFile={setFile} onSelect={setSelected} />
      <section aria-label="Branch graph" className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <GitFork className="size-4 text-accent-soft" aria-hidden="true" />
          <h1 className="m-0 truncate text-[16px] font-semibold">Git · {workspace.name}</h1>
          <span className="ml-auto hidden text-[12px] text-ink-muted xl:inline">Arrow keys move through commits</span>
        </div>
        <BranchGraph workspaceId={workspace.id} highlight={session?.workspaceId === workspace.id ? session.branch : null} details={false} selected={selected} onSelect={setSelected} />
      </section>
      <CommitDiff workspaceId={workspace.id} detail={detail} file={file} />
    </main>
  );
}

function CommitInfo({ hash, detail, file, onFile, onSelect }: { hash: string | null; detail: GitCommitDetail | null; file: FileChange | null; onFile(f: FileChange): void; onSelect(hash: string): void }) {
  const [copied, setCopied] = useState(false);
  if (!detail) {
    return (
      <section aria-label="Commit details" className="hidden min-h-0 items-center justify-center lg:flex">
        {hash ? (
          <Waiting className="text-[13px]">Loading the commit…</Waiting>
        ) : (
          <EmptyState icon={<GitCommitHorizontal className="size-5" />} title="Select a commit" body="Its message, parents and changed files appear here." />
        )}
      </section>
    );
  }
  const [subject = '', ...body] = detail.message.split('\n');
  const rest = body.join('\n').trim();
  const added = detail.files.reduce((n, f) => n + f.additions, 0);
  const removed = detail.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <section aria-label="Commit details" className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-[var(--radius)] border border-line bg-surface-sunken p-3">
      <h2 className="m-0 text-[14px] font-semibold break-words">{subject}</h2>
      {rest ? <p className="m-0 max-h-40 overflow-auto text-[12px] whitespace-pre-wrap text-ink-muted">{rest}</p> : null}
      <span className="text-[12px] text-ink-muted">
        {detail.author}, {relativeTime(detail.time)}
        <span className="block">{new Date(detail.time * 1000).toLocaleString('en-GB')}</span>
        {detail.committer !== detail.author ? <span className="block">Committed by {detail.committer}</span> : null}
      </span>
      <span className="flex flex-wrap items-center gap-1 text-[12px]">
        <span className="font-mono">{detail.hash.slice(0, 12)}</span>
        <Button
          size="dense"
          variant="ghost"
          className="w-8 px-0"
          aria-label="Copy commit hash"
          onClick={() =>
            void navigator.clipboard.writeText(detail.hash).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        </Button>
      </span>
      <span className="flex flex-wrap items-center gap-1 text-[12px]">
        {detail.parents.length ? <span className="text-ink-muted">{detail.parents.length > 1 ? 'Merge of' : 'Parent'}</span> : <Badge>Root commit</Badge>}
        {detail.parents.map((p) => (
          <button key={p} type="button" aria-label={`Go to parent ${p.slice(0, 7)}`} className="rounded px-1 font-mono hover:bg-surface-raised" onClick={() => onSelect(p)}>
            {p.slice(0, 7)}
          </button>
        ))}
      </span>
      <SectionLabel className="mt-1">
        {detail.files.length} file{detail.files.length === 1 ? '' : 's'} · +{added} −{removed}
      </SectionLabel>
      {detail.parents.length > 1 ? <span className="text-[12px] text-ink-muted">Compared with the first parent.</span> : null}
      <ul aria-label="Changed files" className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-auto p-0">
        {detail.files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              aria-current={file?.path === f.path ? 'true' : undefined}
              onClick={() => onFile(f)}
              className={cx('flex min-h-7 w-full items-center gap-2 rounded px-1.5 text-left text-[12px] hover:bg-surface-raised', file?.path === f.path && 'bg-accent-tint')}
            >
              <span className="w-3 shrink-0 font-mono text-accent-soft" title={f.status}>
                {STATUS_LETTER[f.status]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
              <span className="shrink-0 text-ink-muted">
                +{f.additions} −{f.deletions}
              </span>
            </button>
          </li>
        ))}
        {!detail.files.length ? <li className="text-[12px] text-ink-muted">This commit changes no files.</li> : null}
      </ul>
    </section>
  );
}

function CommitDiff({ workspaceId, detail, file }: { workspaceId: string; detail: GitCommitDetail | null; file: FileChange | null }) {
  const [diff, setDiff] = useState<DiffText | null>(null);
  const [inline, setInline] = useState(true);
  useEffect(() => {
    setDiff(null);
    if (!detail || !file) return;
    let live = true;
    void attempt(() => host.call('git.commitDiff', { workspaceId, hash: detail.hash, path: file.path, oldPath: file.oldPath })).then((d) => live && d && setDiff(d));
    return () => {
      live = false;
    };
  }, [workspaceId, detail, file]);

  if (!detail || !file) {
    return (
      <section aria-label="File diff" className="hidden min-h-0 items-center justify-center lg:flex">
        <EmptyState icon={<FileDiff className="size-5" />} title="No file selected" body="Pick a changed file on the left to see its diff here." />
      </section>
    );
  }
  return (
    <section aria-label="File diff" className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <FileDiff className="size-4 text-accent-soft" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.path}
        </span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={inline} onChange={(e) => setInline(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Inline
        </label>
      </div>
      {/* Monaco needs a box with a real size: the editor fills this relative box absolutely. */}
      <div role="region" aria-label={`Diff of ${file.path}`} className="relative min-h-60 flex-1 overflow-hidden rounded-[var(--radius)] border border-line">
        {!diff ? (
          <Waiting className="m-3">Loading the diff…</Waiting>
        ) : diff.binary ? (
          <p className="m-3 text-ink-muted">Binary or very large file; no text diff.</p>
        ) : (
          <div className="absolute inset-0">
            <DiffEditor height="100%" theme="ade-dark" original={diff.oldText} modified={diff.newText} language={languageOf(file.path)} options={{ ...EDITOR_OPTIONS, readOnly: true, renderSideBySide: !inline, originalEditable: false }} />
          </div>
        )}
      </div>
    </section>
  );
}

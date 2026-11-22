import { Archive, FileQuestion, GitCompareArrows, MousePointerClick } from 'lucide-react';
import { DiffEditor } from '@monaco-editor/react';
import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { DiffText, PullRequestStatus, ReviewAssessment } from '@ade/contracts';
import { isLive } from '@ade/session-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { host } from '../lib/bridge.ts';
import { agentLabel, joinPath, languageOf } from '../lib/format.ts';
import { EDITOR_OPTIONS } from '../lib/monaco.ts';
import { attempt, selectedSession, useStore } from '../lib/store.ts';
import { TurnPicker, useChanges } from './Inspector.tsx';
import { AssistantPanel, BaseBanner, BatchReviewPanel, ChecksPanel, PullRequestButton, PullRequestPanel } from './ReviewExtras.tsx';
import type { ReviewComment } from '../lib/review.ts';

const RISK_TONE = { high: 'danger', medium: 'attention', low: 'neutral' } as const;
const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Review and land (RV-01, RV-03, RV-05, RV-06, RV-07, RV-08). Review is the product. */
export function ReviewScreen() {
  const session = useStore(selectedSession);
  const set = useStore((s) => s.set);
  const ask = useStore((s) => s.ask);
  const openEditor = useStore((s) => s.openEditor);
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const changes = useChanges(session?.id ?? null, turnIndex);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffText | null>(null);
  const [inline, setInline] = useState(false);
  const [comment, setComment] = useState<{ line: number; text: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [pending, setPending] = useState<ReviewComment[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [assessment, setAssessment] = useState<ReviewAssessment | null>(null);
  const [pr, setPr] = useState<PullRequestStatus | null>(null);
  const sessionId = session?.id ?? null;
  const loadPr = useCallback(() => {
    if (!sessionId) return;
    void host.call('sessions.pullRequestStatus', { sessionId }).then(setPr).catch(() => setPr(null));
  }, [sessionId]);
  useEffect(loadPr, [loadPr, session?.state]);
  const onAssessment = useCallback((a: ReviewAssessment | null) => setAssessment(a), []);
  const risk = useMemo(() => new Map((assessment?.ranking ?? []).map((r) => [r.path, r])), [assessment]);
  const ordered = useMemo(
    () => (risk.size ? [...changes].sort((a, b) => (RISK_ORDER[risk.get(a.path)?.risk ?? 'low'] ?? 3) - (RISK_ORDER[risk.get(b.path)?.risk ?? 'low'] ?? 3)) : changes),
    [changes, risk],
  );
  // Comments belong to the session they were written for.
  useEffect(() => {
    setPending([]);
    setCommitMessage('');
  }, [session?.id]);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    setSelected(new Set(changes.map((c) => c.path)));
    setActive((a) => (a && changes.some((c) => c.path === a) ? a : (changes[0]?.path ?? null)));
  }, [changes]);

  useEffect(() => {
    if (!session || !active) {
      setDiff(null);
      return;
    }
    void attempt(() => host.call('sessions.diff', { sessionId: session.id, path: active, turnIndex })).then((d) => setDiff(d ?? null));
  }, [session, active, turnIndex]);

  if (!session) return <EmptyState icon={<GitCompareArrows className="size-5" />} title="Nothing to review" body="Select a session; its changes against the base commit appear here." action={<Button onClick={() => set({ tab: 'sessions' })}>Go to sessions</Button>} />;

  const busy = isLive(session.state);
  const ended = session.state === 'landed' || session.state === 'discarded';
  const files = [...selected];

  const addToReview = () => {
    if (!comment || !active || !comment.text.trim()) return;
    setPending((p) => [...p, { path: active, line: comment.line, text: comment.text.trim() }]);
    setComment(null);
  };

  const draftMessage = async () => {
    setDrafting(true);
    const res = await attempt(() => host.call('sessions.draftCommitMessage', { sessionId: session.id }));
    setDrafting(false);
    if (res?.message) setCommitMessage(res.message);
  };

  const sendComment = (mode: 'now') => {
    if (!comment || !active) return;
    const text = `Review comment on ${active}:${comment.line}\n${comment.text}`;
    void attempt(() => host.call(mode === 'now' ? 'sessions.prompt' : 'sessions.queue', { sessionId: session.id, content: [{ type: 'text', text }] })).then((ok) => {
      if (ok) {
        setComment(null);
        useStore.getState().toast(busy ? 'Comment queued for the agent.' : 'Comment sent to the agent.');
      }
    });
  };

  const land = (mode: 'apply' | 'commit') =>
    session.inPlace
      ? ask({
          title: `Keep ${files.length} file(s) in your checkout?`,
          body: 'The selected changes stay where they are, uncommitted. Every other file the session changed goes back to the snapshot taken when it started. The session then ends.',
          confirmLabel: 'Keep changes',
          onConfirm: () =>
            void attempt(() => host.call('sessions.land', { sessionId: session.id, mode: 'apply', files })).then((ok) => ok && useStore.getState().toast('Kept.')),
        })
      : ask({
      title: mode === 'apply' ? `Apply ${files.length} file(s) to your checkout?` : `Commit ${files.length} file(s) on ${session.branch}?`,
      body:
        mode === 'apply'
          ? 'The selected changes are written into your checkout as uncommitted changes. The session then ends and its worktree stays until you discard it.'
          : 'The selected files are committed on the session branch with your Git identity. The session then ends.',
      confirmLabel: mode === 'apply' ? 'Apply to my checkout' : 'Commit to branch',
      onConfirm: () =>
        void attempt(() => host.call('sessions.land', { sessionId: session.id, mode, files, ...(commitMessage.trim() ? { message: commitMessage.trim() } : {}) })).then((ok) => ok && useStore.getState().toast('Landed.')),
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="m-0 text-[16px] font-semibold">Review: {session.title}</h1>
        <Badge>{agentLabel(session.agentId)}</Badge>
        {session.branch ? <Badge className="font-mono text-[12px]">{session.branch}</Badge> : null}
        <div className="ml-3">
          <TurnPicker sessionId={session.id} value={turnIndex} onChange={setTurnIndex} />
        </div>
      </div>
      {!ended ? <BaseBanner session={session} /> : null}
      {ended ? (
        <EmptyState icon={<Archive className="size-5" />} title={`This session has ${session.state === 'landed' ? 'landed' : 'been discarded'}`} body="Its worktree is gone. The audit log records what landed and who decided." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap">
          <aside aria-label="Changed files" className="flex min-h-0 w-72 flex-col gap-2 overflow-auto border-r border-line bg-surface p-3">
            <SectionLabel>{changes.length} files · computed from Git</SectionLabel>
            {changes.length ? <AssistantPanel session={session} onResult={onAssessment} /> : null}
            {ordered.map((c) => (
              <div key={c.path} className={cx('flex flex-col gap-1.5 rounded-[var(--radius)] border p-2.5', active === c.path ? 'border-2 border-accent bg-accent-tint' : 'border-line')}>
                <div className="flex items-center gap-2">
                  <input
                    id={`f-${c.path}`}
                    type="checkbox"
                    checked={selected.has(c.path)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(c.path);
                      else next.delete(c.path);
                      setSelected(next);
                    }}
                    className="size-5 accent-[var(--accent)]"
                    aria-label={`Include ${c.path}`}
                  />
                  <button type="button" onClick={() => setActive(c.path)} className="min-w-0 flex-1 text-left font-mono text-[12px] break-all hover:underline">
                    {c.path}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[12px]">
                  <span className="text-accent-soft">+{c.additions}</span>
                  <span className="text-danger">-{c.deletions}</span>
                  <Badge>{c.status}</Badge>
                  <Badge tone={c.editedByUser ? 'accent' : 'neutral'}>{c.editedByUser ? 'You edited' : 'Agent'}</Badge>
                  {risk.get(c.path) ? (
                    <Badge tone={RISK_TONE[risk.get(c.path)!.risk]} title={risk.get(c.path)!.reason}>
                      {risk.get(c.path)!.risk} risk
                    </Badge>
                  ) : null}
                </div>
                {risk.get(c.path)?.reason ? <span className="text-[12px] text-ink-muted">{risk.get(c.path)!.reason}</span> : null}
              </div>
            ))}
            {changes.length === 0 ? <p className="m-0 text-ink-muted">No changes in this range.</p> : null}
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
            {active && diff ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{active}</span>
                  <div className="ml-auto flex gap-1.5">
                    <Button size="dense" aria-pressed={!inline} variant={!inline ? 'primary' : 'secondary'} onClick={() => setInline(false)}>
                      Side by side
                    </Button>
                    <Button size="dense" aria-pressed={inline} variant={inline ? 'primary' : 'secondary'} onClick={() => setInline(true)}>
                      Inline
                    </Button>
                    <Button size="dense" onClick={() => session.worktreePath && openEditor(joinPath(session.worktreePath, active), session.id)} disabled={busy}>
                      Edit this file
                    </Button>
                    <Button
                      size="dense"
                      onClick={() => {
                        const line = editorRef.current?.getModifiedEditor().getPosition()?.lineNumber ?? 1;
                        setComment({ line, text: '' });
                      }}
                    >
                      Comment on line
                    </Button>
                  </div>
                </div>
                <div className="min-h-64 flex-1 overflow-hidden rounded-[var(--radius)] border border-line">
                  {diff.binary ? (
                    <EmptyState icon={<FileQuestion className="size-5" />} title="Binary file" body="Binary changes cannot be shown as text. They land like any other file." />
                  ) : (
                    <DiffEditor
                      theme="ade-dark"
                      original={diff.oldText}
                      modified={diff.newText}
                      language={languageOf(active)}
                      onMount={(e) => (editorRef.current = e)}
                      options={{ ...EDITOR_OPTIONS, readOnly: true, renderSideBySide: !inline, originalEditable: false }}
                    />
                  )}
                </div>
                {comment ? (
                  <section aria-label={`Comment on line ${comment.line}`} className="flex flex-col gap-2 rounded-[var(--radius)] border border-accent bg-surface p-3">
                    <label htmlFor="line-comment" className="font-semibold">
                      Comment on line {comment.line} for the agent
                    </label>
                    <textarea id="line-comment" rows={2} value={comment.text} onChange={(e) => setComment({ ...comment, text: e.target.value })} autoFocus className="rounded-[var(--radius)] border border-line bg-bg p-2.5 text-ink focus:border-accent focus:outline-none" />
                    <div className="flex gap-2">
                      <Button variant="primary" disabled={!comment.text.trim()} onClick={addToReview}>
                        Add to review
                      </Button>
                      <Button disabled={!comment.text.trim()} onClick={() => sendComment('now')}>
                        {busy ? 'Queue as the next prompt' : 'Send now as a prompt'}
                      </Button>
                      <Button variant="ghost" onClick={() => setComment(null)}>
                        Cancel
                      </Button>
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <EmptyState icon={<MousePointerClick className="size-5" />} title="Select a file" body="Pick a changed file to see its diff against the base commit." />
            )}

            {pr ? <PullRequestPanel session={session} status={pr} onRefresh={loadPr} /> : null}
            <BatchReviewPanel session={session} comments={pending} onChange={setPending} />
            <ChecksPanel session={session} />
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-line bg-surface p-3">
              <span className="font-semibold">
                Land {files.length} of {changes.length} files
              </span>
              <span className="text-ink-muted">{busy ? 'Wait for the turn to finish before landing.' : 'Nothing lands without one of these actions.'}</span>
              {session.inPlace ? null : (
                <>
                  <label htmlFor="commit-msg" className="sr-only">
                    Commit message
                  </label>
                  <textarea id="commit-msg" rows={commitMessage.includes('\n') ? 4 : 1} value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder={`Commit message (default: ${session.title})`} className="min-h-11 min-w-64 flex-1 rounded-[var(--radius)] border border-line bg-bg px-3 py-2.5 text-ink focus:border-accent focus:outline-none" />
                  <Button size="dense" variant="ghost" disabled={busy || drafting || !changes.length} onClick={() => void draftMessage()} title="RV-13: asks this session's agent (adds a turn)">
                    {drafting ? 'Drafting…' : 'Draft with the agent'}
                  </Button>
                </>
              )}
              <div className="ml-auto flex flex-wrap gap-2">
                {session.inPlace ? (
                  <Button variant="primary" disabled={busy || !files.length} onClick={() => land('apply')}>
                    Keep changes
                  </Button>
                ) : (
                  <>
                    <Button disabled={busy || !files.length} onClick={() => land('apply')}>
                      Apply to my checkout
                    </Button>
                    <Button variant="primary" disabled={busy || !files.length} onClick={() => land('commit')}>
                      Commit to branch
                    </Button>
                    {pr ? null : <PullRequestButton session={session} files={files} message={commitMessage} disabled={busy || !files.length} onOpened={loadPr} />}
                  </>
                )}
                <Button
                  variant="danger"
                  onClick={() =>
                    ask({
                      title: 'Discard this session?',
                      body: session.inPlace
                        ? 'Every file in your checkout goes back to the snapshot taken when the session started, and the agent is stopped. The final patch is kept for 30 days in the app data folder.'
                        : 'The worktree and the branch are deleted and the agent is stopped. The final patch is kept for 30 days in the app data folder.',
                      confirmLabel: 'Discard session',
                      danger: true,
                      onConfirm: () => void attempt(() => host.call('sessions.discard', { sessionId: session.id })),
                    })
                  }
                >
                  Discard session
                </Button>
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

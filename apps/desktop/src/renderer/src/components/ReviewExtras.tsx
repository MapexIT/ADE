import { Check, ExternalLink, GitMerge, GitPullRequestArrow, ListChecks, MessageSquareQuote, ReceiptText, RefreshCw, ScanSearch, SendHorizontal, Sparkles, Trash2, Upload } from 'lucide-react';
import { Badge, Button, cx, SectionLabel } from '@ade/ui';
import type { AgentId, BaseStatus, CheckResult, CheckSettings, PullRequestStatus, ReviewAssessment, RunConfig, Session } from '@ade/contracts';
import { isLive, type OpenItem } from '@ade/session-core';
import { askForProof } from '../lib/receipts.ts';
import { useCallback, useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { batchReviewPrompt, checkFailurePrompt, type ReviewComment } from '../lib/review.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

const sendPrompt = (sessionId: string, text: string, busy: boolean, origin?: 'review-comment') =>
  attempt(() => host.call(busy ? 'sessions.queue' : 'sessions.prompt', { sessionId, content: [{ type: 'text', text }], ...(origin ? { origin } : {}) }));

/** RV-11: shown when the user's checkout moved since the session started. */
export function BaseBanner({ session }: { session: Session }) {
  const [status, setStatus] = useState<BaseStatus | null>(null);
  const [working, setWorking] = useState(false);
  const toast = useStore((s) => s.toast);
  const busy = isLive(session.state);
  const refresh = useCallback(() => {
    if (session.inPlace) return;
    void host.call('sessions.baseStatus', { sessionId: session.id }).then(setStatus).catch(() => setStatus(null));
  }, [session.id, session.inPlace]);
  useEffect(refresh, [refresh, session.state, session.baseCommit]);
  if (!status || status.behind === 0) return null;
  const move = async (askAgent: boolean) => {
    setWorking(true);
    const res = await attempt(() => host.call('sessions.rebase', { sessionId: session.id, askAgent }));
    setWorking(false);
    if (res) {
      setStatus(res);
      toast(res.conflicts.length ? (askAgent ? 'Moved; the agent is resolving the conflicts.' : 'Moved; some files have conflict markers.') : 'Moved onto the latest base.');
    }
  };
  return (
    <section aria-label="Base moved" className="flex flex-wrap items-center gap-2 border-b border-attention-line bg-attention-tint px-4 py-2 text-attention">
      <span className="font-semibold">
        {status.branch ?? 'Your checkout'} moved {status.behind} commit{status.behind === 1 ? '' : 's'} since this session started.
      </span>
      <span className="text-ink">{status.conflicts.length ? `Conflicts in ${status.conflicts.join(', ')}.` : 'No conflicts.'}</span>
      <div className="ml-auto flex gap-2">
        <Button icon={<GitMerge className="size-4" aria-hidden="true" />} size="dense" disabled={busy || working} onClick={() => void move(false)}>
          Move onto it
        </Button>
        {status.conflicts.length ? (
          <Button icon={<Sparkles className="size-4" aria-hidden="true" />} size="dense" variant="primary" disabled={busy || working} onClick={() => void move(true)}>
            Move and ask the agent to resolve
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** RV-14: a second agent's read-only pre-review, ranking files by risk. */
export function AssistantPanel({ session, onResult }: { session: Session; onResult: (a: ReviewAssessment | null) => void }) {
  const agents = useStore((s) => s.agents);
  const ready = agents.filter((a) => a.health === 'ready');
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [working, setWorking] = useState(false);
  const [assessment, setAssessment] = useState<ReviewAssessment | null>(null);

  useEffect(() => {
    void host.call('sessions.reviewAssessment', { sessionId: session.id }).then((a) => {
      setAssessment(a);
      onResult(a);
    });
  }, [session.id, onResult]);
  useEffect(() => {
    setAgentId((cur) => (cur && ready.some((a) => a.id === cur) ? cur : (ready.find((a) => a.id !== session.agentId)?.id ?? ready[0]?.id ?? '')));
  }, [ready, session.agentId]);

  const run = async () => {
    if (!agentId) return;
    setWorking(true);
    const a = await attempt(() => host.call('sessions.reviewAssist', { sessionId: session.id, agentId }));
    setWorking(false);
    if (a) {
      setAssessment(a);
      onResult(a);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-line p-2.5">
      <span className="font-semibold">Review assistant</span>
      <div className="flex gap-1.5">
        <label htmlFor="assist-agent" className="sr-only">
          Agent for the pre-review
        </label>
        <select id="assist-agent" value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)} className={cx(inputClass, 'min-h-9 flex-1')}>
          {ready.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <Button busy={working} icon={<ScanSearch className="size-4" aria-hidden="true" />} size="dense" disabled={!agentId || working} onClick={() => void run()}>
          {working ? 'Reviewing…' : 'Pre-review'}
        </Button>
      </div>
      <span className="text-[12px] text-ink-muted">
        {assessment
          ? assessment.ranking.length
            ? `${agentLabel(assessment.agentId)} ranked ${assessment.ranking.length} file(s) by risk.`
            : `${agentLabel(assessment.agentId)} did not return a ranking: ${assessment.raw.slice(0, 200) || 'no reply'}`
          : 'Another agent reads the diff without changing anything and ranks the files by risk.'}
      </span>
    </div>
  );
}

/** RV-10: the workspace's checks for this session. */
/** RV-16: the open items of the session's turn receipts, per turn, with the same two answers as the card. */
export function OpenReceipts({ session, items }: { session: Session; items: OpenItem[] }) {
  if (!items.length) return null;
  const turns = [...new Set(items.map((i) => i.turnId))].map((turnId) => items.filter((i) => i.turnId === turnId));
  return (
    <section aria-label="Receipts to check" className="flex flex-col gap-2 rounded-[var(--radius)] border border-attention-line bg-attention-tint p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReceiptText className="size-4 text-attention" aria-hidden="true" />
        <SectionLabel>Receipts to check</SectionLabel>
        <Badge tone="attention">{items.length} to check</Badge>
      </div>
      {turns.map((group) => (
        <div key={group[0]!.turnId} className="flex flex-col gap-1.5">
          <span className="font-semibold">Turn {group[0]!.turnIndex + 1}</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-1">
            {group.map((i, n) => (
              <li key={n} className="break-words text-ink">
                {i.text}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="dense" variant="primary" icon={<MessageSquareQuote className="size-4" aria-hidden="true" />} onClick={() => askForProof(session.id, group)}>
              Ask for proof
            </Button>
            <Button
              size="dense"
              variant="ghost"
              icon={<Check className="size-4" aria-hidden="true" />}
              onClick={() => void attempt(() => host.call('sessions.acknowledgeReceipt', { sessionId: session.id, turnId: group[0]!.turnId }))}
            >
              Mark as checked
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

export function ChecksPanel({ session }: { session: Session }) {
  const workspaceId = session.workspaceId;
  const [results, setResults] = useState<CheckResult[]>([]);
  const [settings, setSettings] = useState<CheckSettings>({ configIds: [], afterTurn: false });
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const turns = useStore((s) => s.turns[session.id]?.length ?? 0);
  const busy = isLive(session.state);

  useEffect(() => {
    void host.call('checks.settings', { workspaceId }).then(setSettings);
    void host.call('runs.configs', { workspaceId }).then(setConfigs);
  }, [workspaceId]);
  useEffect(() => {
    void host.call('checks.results', { sessionId: session.id }).then(setResults);
  }, [session.id, turns, session.state]);

  const save = async (next: CheckSettings) => {
    setSettings(next);
    await attempt(() => host.call('checks.saveSettings', { workspaceId, settings: next }));
  };
  const run = async () => {
    setRunning(true);
    const r = await attempt(() => host.call('checks.run', { sessionId: session.id }));
    setRunning(false);
    if (r) setResults(r);
  };
  const failed = results.filter((r) => r.exitCode !== 0);

  return (
    <section aria-label="Checks" className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>Checks</SectionLabel>
        {results.length ? <Badge tone={failed.length ? 'attention' : 'ok'}>{failed.length ? `${failed.length} failing` : 'All passing'}</Badge> : null}
        <div className="ml-auto flex gap-2">
          <Button icon={<ListChecks className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => setChoosing((c) => !c)} aria-expanded={choosing}>
            Choose checks
          </Button>
          <Button busy={running} icon={<ListChecks className="size-4" aria-hidden="true" />} size="dense" disabled={running || busy || !settings.configIds.length} onClick={() => void run()}>
            {running ? 'Running…' : 'Run checks'}
          </Button>
          {failed.length ? (
            <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />} size="dense" variant="primary" onClick={() => void sendPrompt(session.id, checkFailurePrompt(results), busy)}>
              Send failures to the agent
            </Button>
          ) : null}
        </div>
      </div>
      {choosing ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-dashed border-line p-2">
          {configs.length === 0 ? <span className="text-ink-muted">No run configurations. Add one in the Run tab.</span> : null}
          {configs.map((c) => (
            <label key={c.id} className="flex min-h-9 items-center gap-2">
              <input
                type="checkbox"
                checked={settings.configIds.includes(c.id)}
                onChange={(e) => void save({ ...settings, configIds: e.target.checked ? [...settings.configIds, c.id] : settings.configIds.filter((x) => x !== c.id) })}
                className="size-4 accent-[var(--accent)]"
              />
              {c.name} <span className="font-mono text-[12px] text-ink-muted">{c.command.join(' ')}</span>
            </label>
          ))}
          <label className="flex min-h-9 items-center gap-2">
            <input type="checkbox" checked={settings.afterTurn} onChange={(e) => void save({ ...settings, afterTurn: e.target.checked })} className="size-4 accent-[var(--accent)]" />
            Run after every turn
          </label>
        </div>
      ) : null}
      {!settings.configIds.length && !choosing ? <span className="text-ink-muted">No checks chosen for this repository.</span> : null}
      {results.map((r) => (
        <div key={r.runId} className="flex flex-col gap-1">
          <button type="button" onClick={() => setOpen(open === r.runId ? null : r.runId)} className="flex items-center gap-2 text-left" aria-expanded={open === r.runId}>
            <Badge tone={r.exitCode === 0 ? 'ok' : 'attention'}>{r.exitCode === 0 ? 'Passed' : `Failed · exit ${r.exitCode ?? 'none'}`}</Badge>
            <span>{r.name}</span>
            <span className="font-mono text-[12px] text-ink-muted">{r.command.join(' ')}</span>
          </button>
          {open === r.runId ? <pre className="m-0 max-h-48 overflow-auto rounded-[var(--radius)] bg-surface-sunken p-2 font-mono text-[11.5px] whitespace-pre-wrap">{r.output || 'No output.'}</pre> : null}
        </div>
      ))}
    </section>
  );
}

/** RV-09: comments collected while reviewing, sent to the agent as one review. */
export function BatchReviewPanel({ session, comments, onChange }: { session: Session; comments: ReviewComment[]; onChange: (c: ReviewComment[]) => void }) {
  const toast = useStore((s) => s.toast);
  if (!comments.length) return null;
  const busy = isLive(session.state);
  const send = async () => {
    if (await sendPrompt(session.id, batchReviewPrompt(comments), busy, 'review-comment')) {
      onChange([]);
      toast(busy ? 'Review queued for the agent.' : 'Review sent to the agent.');
    }
  };
  return (
    <section aria-label="Pending review" className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-accent bg-accent-tint p-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          Review · {comments.length} comment{comments.length === 1 ? '' : 's'}
        </span>
        <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />} size="dense" variant="primary" className="ml-auto" onClick={() => void send()}>
          {busy ? 'Queue review' : 'Send review'}
        </Button>
      </div>
      {comments.map((c, i) => (
        <div key={`${c.path}:${c.line}:${i}`} className="flex items-start gap-2">
          <span className="font-mono text-[12px] text-ink-muted">
            {c.path}:{c.line}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{c.text}</span>
          <Button icon={<Trash2 className="size-4" aria-hidden="true" />} size="dense" variant="ghost" aria-label={`Remove comment on ${c.path} line ${c.line}`} onClick={() => onChange(comments.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
    </section>
  );
}

/** CO-06, CO-07: the session's open pull request: its review and checks, and pushing new commits to it. */
export function PullRequestPanel({ session, status, onRefresh }: { session: Session; status: PullRequestStatus; onRefresh: () => void }) {
  const toast = useStore((s) => s.toast);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const busy = isLive(session.state);
  const failing = status.checks.filter((c) => c.bucket === 'fail');
  const pending = status.checks.filter((c) => c.bucket === 'pending');
  const act = async (label: string, work: () => Promise<unknown>) => {
    setWorking(label);
    await work();
    setWorking(null);
    onRefresh();
  };
  return (
    <section aria-label="Pull request" className="flex flex-col gap-2 rounded-[var(--radius)] border border-accent bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Pull request{status.number ? ` #${status.number}` : ''}</span>
        <Badge tone={status.state === 'OPEN' ? 'accent' : status.state === 'MERGED' ? 'ok' : 'neutral'}>{status.state.toLowerCase()}</Badge>
        {status.reviewDecision ? <Badge tone={status.reviewDecision === 'APPROVED' ? 'ok' : 'attention'}>{status.reviewDecision.toLowerCase().replace('_', ' ')}</Badge> : null}
        <Badge tone={failing.length ? 'attention' : pending.length ? 'neutral' : 'ok'}>
          {status.checks.length ? (failing.length ? `${failing.length} check(s) failing` : pending.length ? `${pending.length} check(s) running` : 'Checks passing') : 'No checks'}
        </Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button icon={<ExternalLink className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => void attempt(() => main('main.openExternal', { url: status.url }))}>
            Open on GitHub
          </Button>
          <Button icon={<RefreshCw className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
          <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />}
            size="dense"
            disabled={!!working}
            onClick={() =>
              void act('review', async () => {
                const r = await attempt(() => host.call('sessions.sendReviewComments', { sessionId: session.id }));
                if (r) toast(r.count ? `Sent ${r.count} review comment(s) to the agent.` : 'There are no review comments yet.');
              })
            }
          >
            Send review comments
          </Button>
          <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />}
            size="dense"
            disabled={!!working || !failing.length}
            onClick={() =>
              void act('checks', async () => {
                const r = await attempt(() => host.call('sessions.sendFailedChecks', { sessionId: session.id }));
                if (r) toast(`Sent ${r.count} failing check(s) to the agent.`);
              })
            }
          >
            Send failing checks
          </Button>
        </div>
      </div>
      {status.checks.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0 text-[12px]">
          {status.checks.map((c) => (
            <li key={`${c.workflow}/${c.name}`}>
              <Badge tone={c.bucket === 'fail' ? 'attention' : c.bucket === 'pass' ? 'ok' : 'neutral'}>
                {c.name}: {c.bucket}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <label htmlFor="push-msg" className="sr-only">
          Commit message for the update
        </label>
        <input id="push-msg" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message for the new changes" className={cx(inputClass, 'min-h-9 min-w-64 flex-1')} />
        <Button icon={<Upload className="size-4" aria-hidden="true" />}
          size="dense"
          variant="primary"
          disabled={busy || !!working || !message.trim()}
          onClick={() =>
            void act('push', async () => {
              if (await attempt(() => host.call('sessions.pushUpdate', { sessionId: session.id, message: message.trim() }))) {
                setMessage('');
                toast('Pushed to the pull request.');
              }
            })
          }
        >
          Commit and push
        </Button>
      </div>
    </section>
  );
}

/** RV-12: commit, push and open a pull request; RV-13 fills the title from the agent. */
export function PullRequestButton({ session, files, message, disabled, onOpened }: { session: Session; files: string[]; message: string; disabled: boolean; onOpened?: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [working, setWorking] = useState(false);
  const toast = useStore((s) => s.toast);

  const show = () => {
    const [subject = session.title, ...rest] = (message.trim() || session.title).split(/\r?\n/);
    setTitle(subject);
    setBody(rest.join('\n').trim());
    setOpen(true);
  };
  const go = async () => {
    setWorking(true);
    const res = await attempt(() =>
      host.call('sessions.pullRequest', { sessionId: session.id, files, title: title.trim(), body, draft, ...(message.trim() ? { message: message.trim() } : {}) }),
    );
    setWorking(false);
    if (res) {
      setOpen(false);
      toast(`Opened ${res.url}`);
      onOpened?.();
    }
  };
  return (
    <>
      <Button icon={<GitPullRequestArrow className="size-4" aria-hidden="true" />} disabled={disabled} onClick={show}>
        Open pull request
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Open a pull request"
        description={`Commits ${files.length} file(s) on ${session.branch}, pushes the branch to origin and opens a pull request with the GitHub CLI. The session stays open for review comments and checks, and lands when the pull request is merged.`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button busy={working} icon={<GitPullRequestArrow className="size-4" aria-hidden="true" />} variant="primary" disabled={!title.trim() || working} onClick={() => void go()}>
              {working ? 'Opening…' : 'Push and open'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Title" htmlFor="pr-title">
            <input id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Description" htmlFor="pr-body">
            <textarea id="pr-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} className={cx(inputClass, 'py-2')} />
          </Field>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="size-5 accent-[var(--accent)]" />
            Open as a draft
          </label>
        </div>
      </Modal>
    </>
  );
}

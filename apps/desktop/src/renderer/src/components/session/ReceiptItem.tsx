import { Check, ListChecks, MessageSquareQuote, ReceiptText } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import type { ReceiptFinding } from '@ade/contracts';
import { claimLead, claimVerdict, findingLine, isOpenVerdict, receiptFactsLine, receiptOpenItems, statusWord, toCheckLine, verdictSentence } from '@ade/session-core';
import { useEffect, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { askForProof, useReceipts, type ReceiptItem as Item } from '../../lib/receipts.ts';
import { attempt, useStore } from '../../lib/store.ts';

/** A finding's line with its paths in the monospace face: "Lead: a.ts, b.ts (detail)". */
function FindingText({ finding }: { finding: ReceiptFinding }) {
  const line = findingLine(finding);
  const at = line.indexOf(': ');
  if (at === -1) return <>{line}</>;
  return (
    <>
      {line.slice(0, at + 2)}
      <span className="font-mono text-[12px] break-all">{line.slice(at + 2)}</span>
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * RV-16: the turn receipt at the end of its turn: what the agent said set against what ADE saw and Git changed.
 * It only informs: "Ask for proof" fills the message box, "Run checks" is the RV-10 action, and nothing is undone.
 */
export function ReceiptItem({ item, sessionId }: { item: Item; sessionId: string }) {
  const { receipts } = useReceipts(sessionId);
  const open = receiptOpenItems(receipts, item);
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId ?? null);
  const turnRunning = useStore((s) => s.views[sessionId]?.activeTurnId != null);
  const [hasChecks, setHasChecks] = useState(false);
  const [running, setRunning] = useState(false);
  const warnings = item.findings.filter((f) => f.level === 'warning');
  const notes = item.findings.filter((f) => f.level === 'note');
  const anyOpen = open.length > 0;

  useEffect(() => {
    if (!anyOpen || !workspaceId) return;
    let live = true;
    void host
      .call('checks.settings', { workspaceId })
      .then((s) => live && setHasChecks(s.configIds.length > 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [anyOpen, workspaceId]);

  const runChecks = async () => {
    setRunning(true);
    await attempt(() => host.call('checks.run', { sessionId }));
    setRunning(false);
  };

  return (
    <section
      role="region"
      aria-label="Turn receipt"
      className={cx('flex flex-col gap-2.5 rounded-[var(--radius)] border p-3', anyOpen ? 'border-attention-line bg-attention-tint' : 'border-line bg-surface')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ReceiptText className={cx('size-4 shrink-0', anyOpen ? 'text-attention' : 'text-accent-soft')} aria-hidden="true" />
        <span className="font-semibold">Receipt</span>
        <span className="text-ink-muted">
          {receiptFactsLine(item.facts)} {toCheckLine(open.length)}
        </span>
      </div>

      {item.claims.length || warnings.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {item.claims.map((claim, n) => {
            const verdict = claimVerdict(receipts, item, claim);
            // One sentence can hold several claims; its words are quoted once.
            const quoted = n === 0 || item.claims[n - 1]!.quote !== claim.quote;
            return (
              <li key={claim.category} className="flex flex-col gap-0.5">
                {quoted ? <q className="mb-0.5 min-w-0 break-words text-[12px] text-ink-muted">{claim.quote}</q> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{claimLead(claim.category)}</span>
                  <Badge tone={isOpenVerdict(verdict) ? 'attention' : 'neutral'}>{statusWord(verdict.status)}</Badge>
                </div>
                <span className="min-w-0 break-words text-ink-muted">{verdictSentence(claim, verdict)}</span>
              </li>
            );
          })}
          {warnings.map((f) => (
            <li key={f.kind} className="min-w-0 break-words text-ink">
              <FindingText finding={f} />
            </li>
          ))}
        </ul>
      ) : null}

      {item.checks ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-ink-muted">ADE&apos;s checks:</span>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {item.checks.map((c, i) => (
              <li key={`${c.name}-${i}`} className={cx(c.exitCode === 0 ? 'text-ink-muted' : 'font-semibold text-ink')}>
                {c.name} {c.exitCode === 0 ? 'passed' : `failed (${c.exitCode === null ? 'no exit code' : `exit ${c.exitCode}`})`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details>
        <summary className="cursor-pointer text-[12px] text-ink-muted">Details</summary>
        <div className="mt-1.5 flex flex-col gap-1 text-ink-muted">
          {notes.map((f) => (
            <div key={f.kind} className="min-w-0 break-words">
              <FindingText finding={f} />
              {f.detail ? <div>{f.detail}</div> : null}
            </div>
          ))}
          <div>
            {item.facts.filesChanged === null ? 'Files changed: not known.' : `Files changed: ${item.facts.filesChanged} (+${item.facts.additions} −${item.facts.deletions}).`}{' '}
            Edits reported: {item.facts.editsReported}. Commands: {item.facts.commands}
            {item.facts.commandsFailed ? `, ${item.facts.commandsFailed} failed` : ''}.
          </div>
          <div>ADE only sees commands and edits the agent reports.</div>
        </div>
      </details>

      {item.acknowledged ? (
        <div className="text-ink-muted">Marked as checked by you.</div>
      ) : anyOpen ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="dense" icon={<MessageSquareQuote className="size-4" aria-hidden="true" />} onClick={() => askForProof(sessionId, open)}>
            Ask for proof
          </Button>
          {hasChecks ? (
            <Button size="dense" icon={<ListChecks className="size-4" aria-hidden="true" />} disabled={running || turnRunning} onClick={() => void runChecks()}>
              {running ? 'Running…' : 'Run checks'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="dense"
            icon={<Check className="size-4" aria-hidden="true" />}
            title={`Closes the ${plural(open.length, 'item')} to check in this receipt`}
            onClick={() => void attempt(() => host.call('sessions.acknowledgeReceipt', { sessionId, turnId: item.turnId }))}
          >
            Mark as checked
          </Button>
        </div>
      ) : null}
    </section>
  );
}

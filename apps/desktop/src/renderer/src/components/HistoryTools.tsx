import { Download } from 'lucide-react';
import { Badge, Button, cx, SectionLabel, Waiting } from '@ade/ui';
import type { InstructionStatus, SessionSearchResult } from '@ade/contracts';
import { useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass, Modal } from './Modal.tsx';

/** ED-04: which instruction files each agent reads in this repository, and where they disagree. */
export function InstructionFiles({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<InstructionStatus | null>(null);
  useEffect(() => {
    void host.call('instructions.status', { workspaceId }).then(setStatus).catch(() => setStatus(null));
  }, [workspaceId]);
  return (
    <section aria-label="Instruction files" className="flex flex-col gap-2">
      <SectionLabel>Instruction files</SectionLabel>
      {!status ? <Waiting>Checking…</Waiting> : null}
      {status?.problems.map((p) => (
        <p key={p} className="m-0 rounded-[var(--radius)] border border-attention-line bg-attention-tint px-2.5 py-1.5 text-[12px] text-attention">
          {p}
        </p>
      ))}
      {status?.agents.map((a) => (
        <div key={a.agentId} className="flex flex-col gap-0.5">
          <span className="font-semibold">{agentLabel(a.agentId)}</span>
          {a.files.length === 0 ? <span className="text-[12px] text-ink-muted">Reads no instruction files here.</span> : null}
          {a.files.map((f) => (
            <span key={`${f.scope}:${f.path}`} className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Badge tone={f.scope === 'project' ? 'accent' : 'neutral'}>{f.scope === 'project' ? 'Repository' : f.scope === 'user' ? 'Your home' : 'Sub-folder'}</Badge>
              <code className="font-mono">{f.path}</code>
              {f.note ? <span className="text-ink-muted">{f.note}</span> : null}
            </span>
          ))}
        </div>
      ))}
    </section>
  );
}

/** HI-07: the audit log as JSON, with secrets and local paths redacted. */
export function ExportAuditButton({ workspaceId }: { workspaceId: string }) {
  const toast = useStore((s) => s.toast);
  const run = async () => {
    const out = await attempt(() => host.call('audit.export', { workspaceId }));
    if (!out) return;
    const saved = await attempt(() => main('main.saveText', { title: 'Export audit log', defaultName: out.fileName, content: out.content }));
    if (saved?.path) toast(`Audit log saved to ${saved.path}.`);
  };
  return (
    <div className="flex flex-col gap-1">
      <Button icon={<Download className="size-4" aria-hidden="true" />} size="dense" className="self-start" onClick={() => void run()}>
        Export audit log
      </Button>
      <span className="text-[12px] text-ink-muted">JSON. Local paths become placeholders and anything that looks like a secret is redacted.</span>
    </div>
  );
}

const KIND: Record<SessionSearchResult['matches'][number]['kind'], string> = { you: 'You', agent: 'Agent', tool: 'Tool', notice: 'Notice' };

/** HI-06: full-text search across every session's conversation. */
export function SessionSearchDialog() {
  const open = useStore((s) => s.sessionSearchOpen);
  const workspaceId = useStore((s) => s.workspaceId);
  const set = useStore((s) => s.set);
  const selectSession = useStore((s) => s.selectSession);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchResult[] | null>(null);
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      void host.call('history.sessions', { query: query.trim(), ...(workspaceId ? { workspaceId } : {}) }).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [open, query, workspaceId]);
  const close = () => set({ sessionSearchOpen: false });
  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Search sessions" description="What you asked, what agents said and did, in every session of this repository." wide>
      <div className="flex flex-col gap-2">
        <label htmlFor="session-q" className="sr-only">
          Search sessions
        </label>
        <input id="session-q" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, for example: migration" className={inputClass} />
        {results && results.length === 0 ? <p className="m-0 text-ink-muted">No session mentions that.</p> : null}
        <ul className="m-0 flex max-h-[60vh] list-none flex-col gap-2 overflow-auto p-0">
          {(results ?? []).map((r) => (
            <li key={r.sessionId}>
              <button
                type="button"
                onClick={() => {
                  selectSession(r.sessionId);
                  set({ tab: 'sessions', sessionSearchOpen: false });
                }}
                className={cx('flex w-full flex-col gap-1 rounded-[var(--radius)] border border-line p-2.5 text-left hover:bg-surface-raised')}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{r.title}</span>
                  <Badge>{agentLabel(r.agentId)}</Badge>
                </span>
                {r.matches.map((m, i) => (
                  <span key={i} className="text-[12px] text-ink-muted">
                    <span className="font-semibold text-ink">{KIND[m.kind]}:</span> {m.snippet}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** HI-08: a screenshot the agent took of the preview, in the timeline. */
export function ScreenshotItem({ url, file }: { url: string; file: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void host.call('screenshots.read', { file }).then((r) => setSrc(r.dataUrl)).catch(() => setSrc(null));
  }, [file]);
  return (
    <figure className="m-0 flex flex-col gap-1 rounded-[var(--radius)] border border-line p-2">
      <figcaption className="text-[12px] text-ink-muted">Preview screenshot{url ? ` of ${url}` : ''}</figcaption>
      {src ? <img src={src} alt={`Screenshot of ${url || 'the preview'}`} className="max-h-96 max-w-full self-start rounded" /> : <Waiting>Loading…</Waiting>}
    </figure>
  );
}

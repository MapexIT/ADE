import { ClipboardPaste, Play, Sparkles, X } from 'lucide-react';
import { Badge, Button, cx } from '@ade/ui';
import type { AgentId, HistoryEntry, TerminalInfo, TerminalLayout } from '@ade/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { runInTerminal } from '../../lib/guards.ts';
import { attempt, useStore } from '../../lib/store.ts';
import { scrollback, seedScrollback, useTerminals } from '../../lib/terminals.ts';
import { inputClass, Modal } from '../Modal.tsx';

/** SM-09: commands an agent proposed, waiting as pending blocks. Run (Enter on the button) or dismiss. */
export function SuggestionsBar({ terminal }: { terminal: TerminalInfo }) {
  const all = useStore((s) => s.suggestions);
  const pending = all.filter((s) => s.terminalId === terminal.id || (s.sessionId !== null && s.sessionId === terminal.sessionId && s.terminalId === null)).slice(-3);
  const dismiss = (id: string) => useStore.setState((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== id) }));
  if (!pending.length || terminal.kind === 'agent-ui') return null;
  return (
    <section aria-label="Suggested commands" className="flex flex-col gap-1 border-b border-line bg-surface px-3 py-2">
      {pending.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2 rounded-[var(--radius-small)] border border-dashed border-accent px-2 py-1">
          <span className="text-[12px] text-ink-muted">Suggested by {s.from}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={s.command}>
            {s.command}
          </code>
          <Button icon={<Play className="size-4" aria-hidden="true" />}
            size="dense"
            variant="primary"
            autoFocus={i === pending.length - 1}
            onClick={() => {
              dismiss(s.id);
              runInTerminal(terminal.id, s.command);
            }}
          >
            Run
          </Button>
          <Button icon={<X className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => dismiss(s.id)} aria-label={`Dismiss ${s.command}`}>
            Dismiss
          </Button>
        </div>
      ))}
    </section>
  );
}

/** SM-10: a question drafted into a command by the chosen agent (read-only); it lands as a suggestion. */
export function AskBar({ terminal }: { terminal: TerminalInfo }) {
  const allAgents = useStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => a.health === 'ready'), [allAgents]);
  const toast = useStore((s) => s.toast);
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [question, setQuestion] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => {
    setAgentId((cur) => (cur && agents.some((a) => a.id === cur) ? cur : (agents.find((a) => a.id !== 'fake')?.id ?? agents[0]?.id ?? '')));
  }, [agents]);
  if (terminal.kind === 'agent-ui' || !agents.length) return null;
  const ask = async () => {
    if (!agentId || !question.trim()) return;
    setWorking(true);
    const res = await attempt(() => host.call('terminal.draftCommand', { agentId, question: question.trim(), cwd: terminal.cwd, shell: terminal.shell }));
    setWorking(false);
    if (!res) return;
    if (!res.command) return toast('The agent did not propose a command.', 'danger');
    setQuestion('');
    const from = agents.find((a) => a.id === agentId)?.label ?? 'an agent';
    useStore.setState((s) => ({ suggestions: [...s.suggestions, { id: crypto.randomUUID(), terminalId: terminal.id, sessionId: null, command: res.command!, from }].slice(-20) }));
  };
  return (
    <form
      aria-label="Ask for a command"
      className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void ask();
      }}
    >
      <label htmlFor={`ask-${terminal.id}`} className="sr-only">
        Describe the command you need
      </label>
      <input id={`ask-${terminal.id}`} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask for a command, for example: find the five largest files" className={cx(inputClass, 'min-h-9 flex-1')} />
      <label htmlFor={`ask-agent-${terminal.id}`} className="sr-only">
        Agent that drafts the command
      </label>
      <select id={`ask-agent-${terminal.id}`} value={agentId} onChange={(e) => setAgentId(e.target.value as AgentId)} className={cx(inputClass, 'min-h-9 w-40')}>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <Button busy={working} icon={<Sparkles className="size-4" aria-hidden="true" />} size="dense" type="submit" disabled={working || !question.trim()}>
        {working ? 'Drafting…' : 'Draft'}
      </Button>
    </form>
  );
}

const SOURCE_LABEL: Record<HistoryEntry['source'], string> = { terminal: 'Terminal', run: 'Run', agent: 'Agent' };

/** SM-11: one search over terminal commands, runs and the commands agents ran, in every worktree. */
export function HistoryDialog({ open, onClose, terminalId }: { open: boolean; onClose: () => void; terminalId: string | null }) {
  const workspaceId = useStore((s) => s.workspaceId);
  const sessions = useStore((s) => s.sessions);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [results, setResults] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void host.call('history.search', { query, ...(all || !workspaceId ? {} : { workspaceId }) }).then(setResults).catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [open, query, all, workspaceId]);
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Command history" description="Commands from your terminals, runs and agents, in every worktree." wide>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="history-q" className="sr-only">
            Search commands
          </label>
          <input id="history-q" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search commands" className={cx(inputClass, 'flex-1')} />
          <label className="flex min-h-11 items-center gap-2 text-[13px]">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Every repository
          </label>
        </div>
        {results.length === 0 ? <p className="m-0 text-ink-muted">No matching commands.</p> : null}
        <ul className="m-0 flex max-h-[55vh] list-none flex-col gap-1 overflow-auto p-0">
          {results.map((r, i) => (
            <li key={`${r.source}:${r.command}:${i}`} className="flex items-center gap-2 rounded-[var(--radius-small)] border border-line px-2 py-1.5">
              <Badge tone={r.source === 'agent' ? 'accent' : 'neutral'}>{SOURCE_LABEL[r.source]}</Badge>
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={r.command}>
                {r.command}
              </code>
              <span className="text-[12px] text-ink-muted">
                {r.sessionId ? (sessions[r.sessionId]?.title ?? 'a session') : 'your checkout'} · {new Date(r.at).toLocaleDateString('en-GB')}
              </span>
              {r.exitCode !== null && r.exitCode !== 0 ? <Badge tone="danger">exit {r.exitCode}</Badge> : null}
              <Button icon={<ClipboardPaste className="size-4" aria-hidden="true" />}
                size="dense"
                disabled={!terminalId}
                onClick={() => {
                  if (!terminalId) return;
                  runInTerminal(terminalId, r.command, { enter: false });
                  onClose();
                }}
              >
                Paste
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

const RESTORE_MARK = '\r\n\x1b[2m--- restored from your last session in ADE ---\x1b[0m\r\n';

/**
 * SM-13: saves the workspace's terminals (with scrollback) as they change, and offers to restore them when the
 * workspace opens without any.
 */
export function useTerminalLayout() {
  const workspaceId = useStore((s) => s.workspaceId);
  const workspaceRoot = useStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.rootPath ?? null);
  const sessions = useStore((s) => s.sessions);
  const terminals = useTerminals((t) => t.terminals);
  const active = useTerminals((t) => t.active);
  const [saved, setSaved] = useState<TerminalLayout | null>(null);
  const restoring = useRef(false);

  const mine = Object.values(terminals).filter(
    (t) => !t.exited && t.kind !== 'agent-ui' && (t.sessionId ? !!sessions[t.sessionId] : !!workspaceRoot && t.cwd.startsWith(workspaceRoot)),
  );

  useEffect(() => {
    setSaved(null);
    if (!workspaceId) return;
    void host.call('layout.get', { workspaceId }).then(setSaved).catch(() => undefined);
  }, [workspaceId]);

  // Save a few seconds after the terminals change, and every 30 seconds for the scrollback.
  const key = mine.map((t) => t.id).join(',');
  useEffect(() => {
    if (!workspaceId || restoring.current || !mine.length) return;
    const save = () => {
      const layout: TerminalLayout = {
        terminals: mine.slice(0, 12).map((t) => ({ kind: t.kind === 'plain' ? 'plain' : 'smart', shell: t.shell || null, cwd: t.cwd, sessionId: t.sessionId, title: t.title, scrollback: scrollback(t.id).slice(-200_000) })),
        activeIndex: mine.findIndex((t) => t.id === active),
        savedAt: new Date().toISOString(),
      };
      void host.call('layout.save', { workspaceId, layout }).catch(() => undefined);
    };
    const first = setTimeout(save, 3000);
    const every = setInterval(save, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, active]);

  const offer = saved && !mine.length && saved.terminals.length ? saved : null;
  const restore = async () => {
    if (!offer) return;
    restoring.current = true;
    const create = useTerminals.getState().create;
    const ids: string[] = [];
    for (const t of offer.terminals) {
      if (t.sessionId && !sessions[t.sessionId]) continue;
      const info = await attempt(() => create({ kind: t.kind, cwd: t.cwd, sessionId: t.sessionId, ...(t.shell ? { shell: t.shell as never } : {}), title: t.title }));
      if (info) {
        seedScrollback(info.id, t.scrollback ? `${t.scrollback}${RESTORE_MARK}` : '');
        ids.push(info.id);
      }
    }
    const pick = ids[offer.activeIndex] ?? ids[0];
    if (pick) useTerminals.getState().setActive(pick);
    setSaved(null);
    restoring.current = false;
  };
  return { offer, restore, dismiss: () => setSaved(null) };
}

import { Badge, Button, EmptyState, SectionLabel } from '@ade/ui';
import type { Run, RunConfig } from '@ade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { host, pty } from '../lib/bridge.ts';
import { attachmentText, joinPath } from '../lib/format.ts';
import { attempt, currentWorkspace, selectedSession, useStore } from '../lib/store.ts';
import { onRunFinished, useTerminals } from '../lib/terminals.ts';
import { Field, inputClass } from './Modal.tsx';
import { TerminalView } from './terminal/TerminalView.tsx';

const runAsText = (r: Run) => `$ ${r.command.join(' ')}\n${r.output.trimEnd().slice(-20_000)}\n[exit ${r.exitCode ?? 'unknown'}]`;

/** Screen 8: run bar, configurations, output and history (CR-01 to CR-04). */
export function RunScreen() {
  const workspace = useStore(currentWorkspace);
  const session = useStore(selectedSession);
  const sessions = useStore((s) => s.sessions);
  const attach = useStore((s) => s.attach);
  const toast = useStore((s) => s.toast);
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [configId, setConfigId] = useState('');
  const [target, setTarget] = useState<string>('checkout');
  const [history, setHistory] = useState<Run[]>([]);
  const [current, setCurrent] = useState<{ runId: string; terminalId: string; startedAt: string; config: RunConfig; cwd: string; sessionId: string | null } | null>(null);
  const [draft, setDraft] = useState({ name: '', command: '' });

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const [c, h] = await Promise.all([host.call('runs.configs', { workspaceId: workspace.id }), host.call('runs.history', { workspaceId: workspace.id })]);
    setConfigs(c);
    setHistory(h);
    setConfigId((id) => (id && c.some((x) => x.id === id) ? id : (c[0]?.id ?? '')));
  }, [workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (session?.worktreePath) setTarget(session.id);
  }, [session]);

  useEffect(
    () =>
      onRunFinished(async (r) => {
        if (!current || r.runId !== current.runId) return;
        await attempt(() =>
          host.call('runs.record', {
            runConfigId: current.config.id,
            sessionId: current.sessionId,
            worktreePath: current.cwd,
            command: current.config.command,
            startedAt: current.startedAt,
            endedAt: new Date().toISOString(),
            exitCode: r.exitCode,
            output: r.output,
          }),
        );
        void refresh();
      }),
    [current, refresh],
  );

  if (!workspace) return <EmptyState title="Run" body="Open a repository to detect its run, test and build commands." />;

  const worktrees = Object.values(sessions).filter((s) => s.worktreePath && s.state !== 'landed' && s.state !== 'discarded');
  const config = configs.find((c) => c.id === configId);
  const run = async () => {
    if (!config) return;
    const sessionId = target === 'checkout' ? null : target;
    const base = sessionId ? sessions[sessionId]?.worktreePath : workspace.rootPath;
    if (!base) return;
    const cwd = config.cwd === '.' ? base : joinPath(base, config.cwd);
    const runId = crypto.randomUUID();
    const res = await attempt(() => pty.call('pty.run', { command: config.command, cwd, sessionId, runId }));
    if (res) {
      setCurrent({ runId, terminalId: res.terminalId, startedAt: new Date().toISOString(), config, cwd, sessionId });
      useTerminals.setState((s) => ({ terminals: { ...s.terminals } }));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-line bg-surface px-4 py-3">
        <Field label="Configuration" htmlFor="run-config">
          <select id="run-config" value={configId} onChange={(e) => setConfigId(e.target.value)} className={`${inputClass} min-w-64`}>
            {configs.length === 0 ? <option value="">No configurations detected</option> : null}
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.source === 'user' ? ' (yours)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Worktree" htmlFor="run-target">
          <select id="run-target" value={target} onChange={(e) => setTarget(e.target.value)} className={`${inputClass} min-w-56`}>
            <option value="checkout">Your checkout</option>
            {worktrees.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </Field>
        <Button variant="primary" disabled={!config} onClick={() => void run()} aria-label="Run the configuration">
          Run
        </Button>
        {config ? <code className="self-center text-[12px] text-ink-muted">{config.command.join(' ')}</code> : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {current ? (
            <TerminalView key={current.terminalId} id={current.terminalId} />
          ) : (
            <EmptyState title="Nothing running" body="Pick a configuration and a worktree, then run it. Every run is kept in the history." />
          )}
        </main>
        <aside aria-label="Run history" className="flex w-96 flex-col gap-3 overflow-auto border-l border-line bg-surface p-3">
          <SectionLabel>History</SectionLabel>
          {history.length === 0 ? <p className="m-0 text-ink-muted">No runs yet.</p> : null}
          {history.map((r) => (
            <div key={r.id} className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-line p-2.5">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-[12px]">{r.command.join(' ')}</code>
                <Badge tone={r.exitCode === 0 ? 'ok' : 'danger'}>{r.exitCode === 0 ? 'Passed' : `Failed · exit ${r.exitCode}`}</Badge>
              </div>
              <span className="text-[12px] text-ink-muted">
                {new Date(r.startedAt).toLocaleString('en-GB')} · {r.sessionId ? (sessions[r.sessionId]?.title ?? 'session') : 'your checkout'}
              </span>
              {r.sessionId ? (
                <Button
                  size="dense"
                  onClick={() => {
                    attach(r.sessionId!, attachmentText(`Run: ${r.command.join(' ')}`, runAsText(r)));
                    toast('Attached to the next prompt.');
                  }}
                >
                  Send run to agent
                </Button>
              ) : null}
            </div>
          ))}
          <SectionLabel className="mt-2">Add a configuration</SectionLabel>
          <Field label="Name" htmlFor="rc-name">
            <input id="rc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Command" htmlFor="rc-cmd" hint="Words are split on spaces; no shell is involved.">
            <input id="rc-cmd" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
          <Button
            disabled={!draft.name.trim() || !draft.command.trim()}
            onClick={() =>
              void attempt(() => host.call('runs.saveConfig', { workspaceId: workspace.id, name: draft.name.trim(), command: draft.command.trim().split(/\s+/), cwd: '.' })).then((ok) => {
                if (ok) {
                  setDraft({ name: '', command: '' });
                  void refresh();
                }
              })
            }
          >
            Save configuration
          </Button>
        </aside>
      </div>
    </div>
  );
}

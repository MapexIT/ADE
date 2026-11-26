import { ExternalLink, Play, Save, SendHorizontal, SlidersHorizontal } from 'lucide-react';
import { Badge, Button, cx, EmptyState, SectionLabel, Tabs, Waiting } from '@ade/ui';
import type { EnvSet, Run, RunConfig } from '@ade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attachmentText, joinPath } from '../lib/format.ts';
import { sendChecked } from '../lib/guards.ts';
import { startRun } from '../lib/runs.ts';
import { attempt, currentWorkspace, selectedSession, useStore } from '../lib/store.ts';
import { Field, inputClass } from './Modal.tsx';
import { CompareRunsDialog, EnvSetsDialog, ScratchpadPanel, TestResultsPanel } from './RunExtras.tsx';
import { TerminalView } from './terminal/TerminalView.tsx';

const runAsText = (r: Run) => `$ ${r.command.join(' ')}\n${r.output.trimEnd().slice(-20_000)}\n[exit ${r.exitCode ?? 'unknown'}]`;

/** CR-02: shown from the moment Run is pressed until the program prints something or ends. */
function StartingRun({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <div className={cx('flex min-h-0 flex-1 items-center justify-center', overlay && 'absolute inset-0 bg-bg/80')} data-testid="run-starting">
      <Waiting className="text-[13px]">Starting {label}…</Waiting>
    </div>
  );
}

/** Screen 8: run bar, output, scratchpad and history (CR-01 to CR-11). */
export function RunScreen() {
  const workspace = useStore(currentWorkspace);
  const session = useStore(selectedSession);
  const sessions = useStore((s) => s.sessions);
  const attach = useStore((s) => s.attach);
  const toast = useStore((s) => s.toast);
  const active = useStore((s) => s.activeRun);
  const starting = useStore((s) => s.startingRun);
  const runsVersion = useStore((s) => s.runsVersion);
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [configId, setConfigId] = useState('');
  const [target, setTarget] = useState<string>('checkout');
  const [history, setHistory] = useState<Run[]>([]);
  const [draft, setDraft] = useState({ name: '', command: '' });
  const [view, setView] = useState<'output' | 'scratchpad'>('output');
  const [envSets, setEnvSets] = useState<EnvSet[]>([]);
  const [envSetId, setEnvSetId] = useState('');
  const [editingEnv, setEditingEnv] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const [c, h, e] = await Promise.all([host.call('runs.configs', { workspaceId: workspace.id }), host.call('runs.history', { workspaceId: workspace.id }), host.call('envSets.list', { workspaceId: workspace.id })]);
    setConfigs(c);
    setHistory(h);
    setEnvSets(e);
    setConfigId((id) => (id && c.some((x) => x.id === id) ? id : (c[0]?.id ?? '')));
    setEnvSetId((id) => (id && e.some((x) => x.id === id) ? id : ''));
  }, [workspace]);

  useEffect(() => {
    void refresh();
  }, [refresh, runsVersion, editingEnv]);

  useEffect(() => {
    if (session?.worktreePath) setTarget(session.id);
  }, [session]);

  // A new run (from the run bar, the editor or the scratchpad) shows its output.
  useEffect(() => {
    if (active?.runId) setView('output');
  }, [active?.runId]);
  // CR-02: a run that was just asked for shows the output view at once, with a waiting animation until it prints.
  useEffect(() => {
    if (starting) setView('output');
  }, [starting]);

  if (!workspace) return <EmptyState icon={<Play className="size-5" />} title="Run" body="Open a repository to detect its run, test and build commands." />;

  const worktrees = Object.values(sessions).filter((s) => s.worktreePath && s.state !== 'landed' && s.state !== 'discarded');
  const config = configs.find((c) => c.id === configId);
  const run = async () => {
    if (!config) return;
    const sessionId = target === 'checkout' ? null : target;
    const base = sessionId ? sessions[sessionId]?.worktreePath : workspace.rootPath;
    if (!base) return;
    const cwd = config.cwd === '.' ? base : joinPath(base, config.cwd);
    setView('output');
    await startRun({ command: config.command, cwd, sessionId, configId: config.id, label: config.name, envSetId: envSetId || null });
  };
  const shown = history.find((r) => r.id === selectedRun) ?? (active ? history.find((r) => r.startedAt >= active.startedAt && r.command.join(' ') === active.command.join(' ')) : undefined);
  const compareRuns = comparing.length === 2 ? (comparing.map((id) => history.find((r) => r.id === id)!).sort((a, b) => a.startedAt.localeCompare(b.startedAt)) as [Run, Run]) : null;

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
        <Field label="Environment" htmlFor="run-env">
          <select id="run-env" value={envSetId} onChange={(e) => setEnvSetId(e.target.value)} className={`${inputClass} min-w-40`}>
            <option value="">None</option>
            {envSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Button icon={<SlidersHorizontal className="size-4" aria-hidden="true" />} variant="ghost" onClick={() => setEditingEnv(true)}>
          Environment sets
        </Button>
        <Button icon={<Play className="size-4" aria-hidden="true" />} variant="primary" disabled={!config} onClick={() => void run()} aria-label="Run the configuration">
          Run
        </Button>
        {config ? <code className="self-center text-[12px] text-ink-muted">{config.command.join(' ')}</code> : null}
        {active?.previewUrl ? (
          <Button icon={<ExternalLink className="size-4" aria-hidden="true" />} className="self-center" onClick={() => void attempt(() => main('main.openPreview', { url: active.previewUrl! }))}>
            Open preview
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-line bg-surface px-3 pt-1">
            <Tabs
              label="Run view"
              value={view}
              onChange={setView}
              items={[
                { value: 'output', label: active ? `Output · ${active.label}` : 'Output' },
                { value: 'scratchpad', label: 'Scratchpad' },
              ]}
            />
          </div>
          {view === 'scratchpad' ? (
            <ScratchpadPanel />
          ) : starting && (!active || active.label !== starting.label || !active.terminalId) ? (
            <StartingRun label={starting.label} />
          ) : active ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <TerminalView key={active.terminalId} id={active.terminalId} />
              {starting ? <StartingRun label={starting.label} overlay /> : null}
            </div>
          ) : (
            <EmptyState icon={<Play className="size-5" />} title="Nothing running" body="Pick a configuration and a worktree, then run it; or run a file from the editor, or a snippet in the scratchpad. Every run is kept in the history." />
          )}
        </main>
        <aside aria-label="Run history" className="flex w-96 flex-col gap-3 overflow-auto border-l border-line bg-surface p-3">
          {shown ? <TestResultsPanel run={shown} /> : null}
          <div className="flex items-center gap-2">
            <SectionLabel>History</SectionLabel>
            {comparing.length ? (
              <span className="ml-auto text-[12px] text-ink-muted">{comparing.length === 1 ? 'Choose one more run to compare' : ''}</span>
            ) : null}
          </div>
          {history.length === 0 ? <p className="m-0 text-ink-muted">No runs yet.</p> : null}
          {history.map((r) => (
            <div key={r.id} className={`flex flex-col gap-1.5 rounded-[var(--radius)] border p-2.5 ${shown?.id === r.id ? 'border-accent' : 'border-line'}`}>
              <div className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[12px] hover:underline" onClick={() => setSelectedRun(r.id)}>
                  {r.command.join(' ')}
                </button>
                <Badge tone={r.exitCode === 0 ? 'ok' : 'danger'}>{r.exitCode === 0 ? 'Passed' : `Failed · exit ${r.exitCode}`}</Badge>
              </div>
              <span className="text-[12px] text-ink-muted">
                {new Date(r.startedAt).toLocaleString('en-GB')} · {r.sessionId ? (sessions[r.sessionId]?.title ?? 'session') : 'your checkout'}
              </span>
              <div className="flex flex-wrap gap-2">
                <label className="flex min-h-9 items-center gap-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={comparing.includes(r.id)}
                    onChange={(e) => setComparing((c) => (e.target.checked ? [...c, r.id].slice(-2) : c.filter((x) => x !== r.id)))}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Compare
                </label>
                {r.sessionId ? (
                  <Button icon={<SendHorizontal className="size-4" aria-hidden="true" />}
                    size="dense"
                    onClick={() =>
                      sendChecked(runAsText(r), () => {
                        attach(r.sessionId!, attachmentText(`Run: ${r.command.join(' ')}`, runAsText(r)));
                        toast('Attached to the next prompt.');
                      })
                    }
                  >
                    Send run to agent
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          <SectionLabel className="mt-2">Add a configuration</SectionLabel>
          <Field label="Name" htmlFor="rc-name">
            <input id="rc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Command" htmlFor="rc-cmd" hint="Words are split on spaces; no shell is involved.">
            <input id="rc-cmd" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
          <Button icon={<Save className="size-4" aria-hidden="true" />}
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
      <CompareRunsDialog runs={compareRuns} onClose={() => setComparing([])} />
      <EnvSetsDialog open={editingEnv} onClose={() => setEditingEnv(false)} workspaceId={workspace.id} />
    </div>
  );
}

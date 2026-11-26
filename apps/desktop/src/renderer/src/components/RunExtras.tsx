import { Play, Plus, Save, Trash2 } from 'lucide-react';
import Editor from '@monaco-editor/react';
import { SafeDiffEditor as DiffEditor } from './SafeDiffEditor.tsx';
import { Badge, Button, cx, Waiting } from '@ade/ui';
import type { EnvSet, Run, ScratchLanguage } from '@ade/contracts';
import { useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { duration } from '../lib/format.ts';
import { EDITOR_OPTIONS } from '../lib/monaco.ts';
import { rerunCommand, splitFailure } from '../lib/runner.ts';
import { beginStarting, startRun } from '../lib/runs.ts';
import { attempt, useStore } from '../lib/store.ts';
import { parseTestSummary } from '../lib/terminal-intel.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

const SAMPLES: Record<ScratchLanguage, { label: string; monaco: string; code: string }> = {
  javascript: { label: 'JavaScript', monaco: 'javascript', code: "console.log('Hello from ADE', [1, 2, 3].map((n) => n * 2));\n" },
  typescript: { label: 'TypeScript', monaco: 'typescript', code: "const greet = (name: string): string => `Hello, ${name}`;\nconsole.log(greet('ADE'));\n" },
  python: { label: 'Python', monaco: 'python', code: "print('Hello from ADE', [n * 2 for n in range(3)])\n" },
  csharp: { label: 'C#', monaco: 'csharp', code: 'Console.WriteLine($"Hello from ADE at {DateTime.Now:t}");\n' },
};

/** CR-07: a snippet in a temporary folder, sandboxed where the OS allows it, and said so either way. */
export function ScratchpadPanel() {
  const [language, setLanguage] = useState<ScratchLanguage>('javascript');
  const [code, setCode] = useState<Record<ScratchLanguage, string>>({ javascript: SAMPLES.javascript.code, typescript: SAMPLES.typescript.code, python: SAMPLES.python.code, csharp: SAMPLES.csharp.code });
  const [status, setStatus] = useState<{ sandboxed: boolean; note: string | null } | null>(null);
  const run = async () => {
    const label = `Scratchpad · ${SAMPLES[language].label}`;
    // CR-02: switch to the output at once; preparing the folder and sandbox can take a while on the first run.
    const done = beginStarting(label);
    const prepared = await attempt(() => host.call('scratch.prepare', { language, code: code[language] }));
    if (!prepared) return done();
    setStatus({ sandboxed: prepared.sandboxed, note: prepared.note });
    await startRun({ command: prepared.command, cwd: prepared.dir, sessionId: null, label, env: prepared.env });
  };
  return (
    <section aria-label="Scratchpad" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="pad-lang" className="sr-only">
          Language
        </label>
        <select id="pad-lang" value={language} onChange={(e) => setLanguage(e.target.value as ScratchLanguage)} className={cx(inputClass, 'min-h-9 w-40')}>
          {(Object.keys(SAMPLES) as ScratchLanguage[]).map((l) => (
            <option key={l} value={l}>
              {SAMPLES[l].label}
            </option>
          ))}
        </select>
        <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" variant="primary" onClick={() => void run()}>
          Run snippet
        </Button>
        {status ? <Badge tone={status.sandboxed ? 'ok' : 'attention'}>{status.sandboxed ? 'Sandboxed' : 'Not sandboxed'}</Badge> : null}
        {status?.note ? <span className="text-[12px] text-ink-muted">{status.note}</span> : null}
      </div>
      <div className="min-h-64 flex-1 overflow-hidden rounded-[var(--radius)] border border-line">
        <Editor theme="ade-dark" loading={<Waiting>Loading the editor…</Waiting>} language={SAMPLES[language].monaco} value={code[language]} onChange={(v) => setCode((c) => ({ ...c, [language]: v ?? '' }))} options={EDITOR_OPTIONS} />
      </div>
      <span className="text-[12px] text-ink-muted">Each run gets a new temporary folder. C# needs the .NET 10 SDK; TypeScript needs Node 22.18 or later.</span>
    </section>
  );
}

/** CR-06: a test run's failures, with one-click re-runs of one test, one file or only the failures. */
export function TestResultsPanel({ run }: { run: Run }) {
  const summary = parseTestSummary(run.output);
  if (!summary) return null;
  const again = (command: string[], label: string) => void startRun({ command, cwd: run.worktreePath, sessionId: run.sessionId, configId: run.runConfigId, label });
  const byFile = new Map<string, { failure: string; name: string; file: string | null }[]>();
  for (const f of summary.failures) {
    const parts = splitFailure(summary.framework, f);
    const key = parts.file ?? 'Tests';
    byFile.set(key, [...(byFile.get(key) ?? []), { failure: f, ...parts }]);
  }
  return (
    <section aria-label="Test results" className="flex flex-col gap-2 rounded-[var(--radius)] border border-line p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Tests · {summary.framework}</span>
        <Badge tone={summary.failed ? 'danger' : 'ok'}>{summary.failed} failed</Badge>
        <Badge tone="ok">{summary.passed} passed</Badge>
        {summary.skipped ? <Badge>{summary.skipped} skipped</Badge> : null}
        {summary.failed ? (
          <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" className="ml-auto" onClick={() => again(rerunCommand(summary.framework, run.command, { kind: 'failures', failures: summary.failures }), 'Failed tests')}>
            Run only failures
          </Button>
        ) : null}
      </div>
      {[...byFile].map(([file, tests]) => (
        <details key={file} open>
          <summary className="cursor-pointer font-mono text-[12px]">
            {file} · {tests.length}
            {tests[0]?.file ? (
              <button type="button" className="ml-2 text-accent underline" onClick={() => again(rerunCommand(summary.framework, run.command, { kind: 'file', file: tests[0]!.file! }), file)}>
                run file
              </button>
            ) : null}
          </summary>
          <ul className="m-0 flex list-none flex-col gap-1 py-1 pl-4">
            {tests.map((t) => (
              <li key={t.failure} className="flex items-center gap-2 font-mono text-[12px]">
                <span className="text-danger">✗</span>
                <span className="min-w-0 flex-1 truncate" title={t.failure}>
                  {t.name}
                </span>
                <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={() => again(rerunCommand(summary.framework, run.command, { kind: 'test', file: t.file, name: t.name }), t.name)}>
                  Run this test
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

/** CR-09: the same run in two worktrees (or twice), side by side. */
export function CompareRunsDialog({ runs, onClose }: { runs: [Run, Run] | null; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  if (!runs) return null;
  const where = (r: Run) => (r.sessionId ? (sessions[r.sessionId]?.title ?? 'a session') : 'your checkout');
  const took = (r: Run) => (r.endedAt ? duration(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) : 'unknown');
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Compare runs" description="Output of the older run on the left, the newer on the right." wide>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 text-[13px]">
          {runs.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-line p-2">
              <code className="text-[12px]">{r.command.join(' ')}</code>
              <Badge tone={r.exitCode === 0 ? 'ok' : 'danger'}>exit {r.exitCode ?? '?'}</Badge>
              <span className="text-ink-muted">
                {where(r)} · {took(r)} · {new Date(r.startedAt).toLocaleString('en-GB')}
              </span>
            </div>
          ))}
        </div>
        <div className="h-[55vh] overflow-hidden rounded-[var(--radius)] border border-line">
          <DiffEditor theme="ade-dark" original={runs[0].output} modified={runs[1].output} language="plaintext" options={{ ...EDITOR_OPTIONS, readOnly: true, originalEditable: false }} />
        </div>
      </div>
    </Modal>
  );
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`).slice(0, 36);

/** CR-11: named variable sets for runs. Secret values go to the OS credential store and are shown as dots. */
export function EnvSetsDialog({ open, onClose, workspaceId }: { open: boolean; onClose: () => void; workspaceId: string }) {
  const toast = useStore((s) => s.toast);
  const [sets, setSets] = useState<EnvSet[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setSecrets({});
    void host.call('envSets.list', { workspaceId }).then(setSets);
  }, [open, workspaceId]);
  const patchSet = (id: string, change: Partial<EnvSet>) => setSets((all) => all.map((s) => (s.id === id ? { ...s, ...change } : s)));
  const save = async () => {
    for (const [key, value] of Object.entries(secrets)) if (value) await attempt(() => main('main.envSecret.set', { key, value }));
    if (await attempt(() => host.call('envSets.save', { workspaceId, sets }))) {
      toast('Environment sets saved.');
      onClose();
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Environment sets"
      description="Variables for runs started from ADE. Secret values are kept in your system's credential store, masked in run output, and never given to agents."
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button icon={<Save className="size-4" aria-hidden="true" />} variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {sets.map((set) => (
          <section key={set.id} aria-label={`Environment set ${set.name}`} className="flex flex-col gap-2 rounded-[var(--radius)] border border-line p-2.5">
            <div className="flex gap-2">
              <Field label="Name" htmlFor={`set-${set.id}`}>
                <input id={`set-${set.id}`} value={set.name} onChange={(e) => patchSet(set.id, { name: e.target.value })} className={inputClass} />
              </Field>
              <Button icon={<Trash2 className="size-4" aria-hidden="true" />} size="dense" variant="ghost" className="self-end" onClick={() => setSets((all) => all.filter((s) => s.id !== set.id))}>
                Remove set
              </Button>
            </div>
            {set.vars.map((v, i) => {
              const key = `env:${set.id}:${v.name}`;
              const patchVar = (change: Partial<EnvSet['vars'][number]>) => patchSet(set.id, { vars: set.vars.map((x, j) => (j === i ? { ...x, ...change } : x)) });
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`var-${set.id}-${i}`} className="sr-only">
                    Variable name
                  </label>
                  <input id={`var-${set.id}-${i}`} value={v.name} placeholder="NAME" onChange={(e) => patchVar({ name: e.target.value })} className={cx(inputClass, 'w-48 font-mono')} />
                  <label htmlFor={`val-${set.id}-${i}`} className="sr-only">
                    Value of {v.name || 'the variable'}
                  </label>
                  <input
                    id={`val-${set.id}-${i}`}
                    type={v.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={v.secret ? (secrets[key] ?? '') : v.value}
                    placeholder={v.secret ? 'Stored securely; type to replace' : 'value'}
                    onChange={(e) => (v.secret ? setSecrets((s) => ({ ...s, [key]: e.target.value })) : patchVar({ value: e.target.value }))}
                    className={cx(inputClass, 'min-w-48 flex-1 font-mono')}
                  />
                  <label className="flex min-h-11 items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={v.secret} onChange={(e) => patchVar({ secret: e.target.checked, value: e.target.checked ? '' : v.value })} className="size-4 accent-[var(--accent)]" />
                    Secret
                  </label>
                  <Button icon={<Trash2 className="size-4" aria-hidden="true" />}
                    size="dense"
                    variant="ghost"
                    aria-label={`Remove ${v.name || 'variable'}`}
                    onClick={() => {
                      if (v.secret && v.name) void attempt(() => main('main.envSecret.delete', { key }));
                      patchSet(set.id, { vars: set.vars.filter((_, j) => j !== i) });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              );
            })}
            <Button icon={<Plus className="size-4" aria-hidden="true" />} size="dense" className="self-start" onClick={() => patchSet(set.id, { vars: [...set.vars, { name: '', value: '', secret: false }] })}>
              Add variable
            </Button>
          </section>
        ))}
        <Button icon={<Plus className="size-4" aria-hidden="true" />} size="dense" className="self-start" onClick={() => setSets((all) => [...all, { id: newId(), name: 'Local', vars: [] }])}>
          Add environment set
        </Button>
      </div>
    </Modal>
  );
}

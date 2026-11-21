import type { EnvSet } from '@ade/contracts';
import { host, main, pty } from './bridge.ts';
import { detectPreviewUrl, maskSecrets } from './runner.ts';
import { attempt, useStore } from './store.ts';
import { onRunFinished, subscribeData, useTerminals } from './terminals.ts';

export interface ActiveRun {
  runId: string;
  terminalId: string;
  startedAt: string;
  command: string[];
  cwd: string;
  sessionId: string | null;
  configId: string | null;
  label: string;
  previewUrl: string | null;
}

/** Runs started from ADE that have not finished; their secrets are masked when the output is stored. */
const pending = new Map<string, { run: ActiveRun; secrets: string[]; workspaceId: string | null }>();

/** CR-11: an environment set's variables, with secret values read from the OS credential store. */
async function resolveEnv(workspaceId: string | null, envSetId: string | null): Promise<{ env: Record<string, string>; secrets: string[] }> {
  if (!workspaceId || !envSetId) return { env: {}, secrets: [] };
  const sets: EnvSet[] = await host.call('envSets.list', { workspaceId });
  const set = sets.find((s) => s.id === envSetId);
  if (!set) return { env: {}, secrets: [] };
  const keys = set.vars.filter((v) => v.secret).map((v) => `env:${set.id}:${v.name}`);
  const secret = keys.length ? await main('main.envSecret.get', { keys }) : {};
  const env: Record<string, string> = {};
  const secrets: string[] = [];
  for (const v of set.vars) {
    if (!v.secret) env[v.name] = v.value;
    else {
      const value = secret[`env:${set.id}:${v.name}`];
      if (value !== undefined) {
        env[v.name] = value;
        secrets.push(value);
      }
    }
  }
  return { env, secrets };
}

/**
 * CR-02, CR-05 to CR-07: starts a program as a run (a pty terminal), shows it in the Run tab and records it in
 * the history when it ends. Used by the run bar, the editor and the scratchpad.
 */
export async function startRun(o: { command: string[]; cwd: string; sessionId: string | null; configId?: string | null; label: string; envSetId?: string | null; env?: Record<string, string> }) {
  const workspaceId = useStore.getState().workspaceId;
  const { env, secrets } = await resolveEnv(workspaceId, o.envSetId ?? null);
  const runId = crypto.randomUUID();
  const res = await attempt(() => pty.call('pty.run', { command: o.command, cwd: o.cwd, sessionId: o.sessionId, runId, env: { ...(o.env ?? {}), ...env } }));
  if (!res) return null;
  const run: ActiveRun = { runId, terminalId: res.terminalId, startedAt: new Date().toISOString(), command: o.command, cwd: o.cwd, sessionId: o.sessionId, configId: o.configId ?? null, label: o.label, previewUrl: null };
  pending.set(runId, { run, secrets, workspaceId });
  useTerminals.setState((s) => ({ terminals: { ...s.terminals } }));
  useStore.setState({ activeRun: run, tab: 'run' });
  // CR-10: a web run opens the preview once it prints a local address.
  let seen = '';
  const off = subscribeData(res.terminalId, (data) => {
    seen = (seen + data).slice(-20_000);
    const url = detectPreviewUrl(seen);
    if (!url) return;
    off();
    const current = useStore.getState().activeRun;
    if (current?.runId === runId) useStore.setState({ activeRun: { ...current, previewUrl: url } });
    void attempt(() => main('main.openPreview', { url }));
  });
  return run;
}

let wired = false;
/** Records every finished run once, with secret values masked (CR-03, CR-11). */
export function wireRuns() {
  if (wired) return;
  wired = true;
  onRunFinished(async (r) => {
    const p = pending.get(r.runId);
    if (!p) return;
    pending.delete(r.runId);
    await attempt(() =>
      host.call('runs.record', {
        ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
        runConfigId: p.run.configId,
        sessionId: p.run.sessionId,
        worktreePath: p.run.cwd,
        command: p.run.command,
        startedAt: p.run.startedAt,
        endedAt: new Date().toISOString(),
        exitCode: r.exitCode,
        output: maskSecrets(r.output, p.secrets),
      }),
    );
    useStore.setState((s) => ({ runsVersion: s.runsVersion + 1 }));
  });
}

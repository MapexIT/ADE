import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '@ade/git';
import type { Host } from './app.ts';

/** One check of the installed app (M5-T07). `detail` says what was found, so a failure is readable in CI. */
export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const ADAPTERS = ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp'] as const;

export interface SmokeOptions {
  /** Where the bundled ACP adapters resolve to (the packaged build unpacks them next to the asar). */
  adapterEntry: (pkg: (typeof ADAPTERS)[number]) => string | null;
  /** A scratch folder; a throwaway repository is made inside it. */
  scratch: string;
  timeoutMs?: number;
}


async function check(name: string, run: () => Promise<string>): Promise<SmokeCheck> {
  try {
    return { name, ok: true, detail: await run() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = probe();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${what}.`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * M5-T07: what a clean install must be able to do, checked from inside the installed app. The database opens,
 * the bundled adapters are on disk where ADE spawns them, Git is found, and (when the fake agent is enabled)
 * a session runs end to end through ACP with the app's own Node runtime.
 */
export async function runSmokeChecks(host: Host, opts: SmokeOptions): Promise<SmokeCheck[]> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const checks: SmokeCheck[] = [];

  checks.push(
    await check('database', async () => {
      host.repos.settings.set('smoke.lastRun', new Date().toISOString());
      if (!host.repos.settings.get<string>('smoke.lastRun', '')) throw new Error('A setting did not read back.');
      return 'SQLite opened and a setting read back.';
    }),
  );

  for (const pkg of ADAPTERS) {
    checks.push(
      await check(`adapter ${pkg}`, async () => {
        const entry = opts.adapterEntry(pkg);
        if (!entry) throw new Error('The package does not resolve.');
        if (!existsSync(entry)) throw new Error(`Missing on disk: ${entry}`);
        return entry;
      }),
    );
  }

  checks.push(
    await check('agents', async () => {
      const status = await host.handlers['agents.status']({ refresh: true });
      const bundled = status.filter((s) => s.id === 'claude-code' || s.id === 'codex');
      const missing = bundled.filter((s) => s.health === 'not-installed');
      if (missing.length) throw new Error(missing.map((s) => `${s.label}: ${s.reason ?? 'not installed'}`).join('; '));
      return status.map((s) => `${s.id}=${s.health}`).join(', ');
    }),
  );

  const fakeAvailable = (await host.handlers['agents.status']({ refresh: false })).some((s) => s.id === 'fake' && s.health === 'ready');
  checks.push(
    await check('session', async () => {
      if (!fakeAvailable) return 'Skipped: the fake agent is not enabled in this build (set ADE_ENABLE_FAKE_AGENT=1).';
      await mkdir(opts.scratch, { recursive: true });
      const repo = await mkdtemp(join(opts.scratch, 'repo-'));
      try {
        const identity = ['-c', 'user.name=ADE smoke test', '-c', 'user.email=smoke@ade.invalid'];
        await git(['init', '-q', '-b', 'main'], { cwd: repo });
        await mkdir(join(repo, 'src'), { recursive: true });
        await writeFile(join(repo, 'README.md'), '# Smoke\n');
        await git(['add', '-A'], { cwd: repo });
        await git([...identity, 'commit', '-q', '-m', 'init'], { cwd: repo });
        const ws = await host.handlers['workspace.open']({ path: repo });
        const session = await host.handlers['sessions.create']({
          workspaceId: ws.id,
          agentId: 'fake',
          prompt: [{ type: 'text', text: 'edit src/smoke.txt installed\nsay Smoke test passed.' }],
          permissionProfile: 'auto-edit',
          bringChanges: false,
        });
        const said = await waitFor(
          () => {
            const e = host.repos.events.list(session.id).find((x) => x.type === 'agent.message' && x.text.includes('Smoke test passed'));
            return e ? 'ok' : undefined;
          },
          timeoutMs,
          'the agent to answer',
        );
        const worktree = host.repos.sessions.require(session.id).worktreePath;
        if (!worktree || !existsSync(join(worktree, 'src', 'smoke.txt'))) throw new Error('The agent edit did not reach the worktree.');
        await host.handlers['sessions.discard']({ sessionId: session.id });
        return `The fake agent answered (${said}) and edited its worktree.`;
      } finally {
        await rm(repo, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
  return checks;
}

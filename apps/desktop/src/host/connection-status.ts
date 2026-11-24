import { homedir } from 'node:os';
import type { ConnectionStatus } from '@ade/contracts';
import type { CredentialCache, Runner } from './connectors.ts';

/** A status check must answer quickly even when the network hangs; `gh api` gets this long. */
const TIMEOUT_MS = 10_000;

type Result = { code: number; stdout: string; stderr: string };

function withTimeout(p: Promise<Result>, ms: number): Promise<Result> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: 124, stdout: '', stderr: 'gh did not answer in time. Check your network connection.' }), ms);
    t.unref?.();
    void p.then((r) => {
      clearTimeout(t);
      resolve(r);
    });
  });
}

/** The first meaningful line of a CLI's error output, kept short for the UI. */
export function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 300) : null;
}

/** `gh version 2.101.0 (2026-09-15)` -> `2.101.0`. */
export function parseGhVersion(stdout: string): string | null {
  return /gh version (\S+)/.exec(stdout)?.[1] ?? null;
}

/** The fields ADE shows from `gh api user` (GitHub's "Get the authenticated user" endpoint). */
export function parseGhUser(stdout: string): NonNullable<ConnectionStatus['github']['account']> | null {
  try {
    const u = JSON.parse(stdout) as { login?: unknown; id?: unknown; name?: unknown; email?: unknown };
    if (typeof u.login !== 'string' || !u.login) return null;
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { login: u.login, id: Number.isInteger(u.id) ? (u.id as number) : null, name: text(u.name), email: text(u.email) };
  } catch {
    return null;
  }
}

/**
 * CO-14: reads what the work item guides need, locally: whether `gh` is installed and who it signs in as, which
 * connector tokens are stored, and the Git identity. Tokens never leave the credential cache; only "stored" is
 * reported.
 */
export class ConnectionStatusService {
  constructor(
    private readonly creds: CredentialCache,
    private readonly run: Runner,
    private readonly gh: string | null,
    private readonly gitBin: string | null,
  ) {}

  async status(cwd: string | null): Promise<ConnectionStatus> {
    const [github, git] = await Promise.all([this.github(), this.git(cwd ?? homedir())]);
    return { github, shortcut: { tokenStored: !!this.creds.get('shortcut') }, git };
  }

  private async github(): Promise<ConnectionStatus['github']> {
    const token = this.creds.get('github');
    const tokenStored = !!token;
    if (!this.gh) return { cli: { installed: false, version: null }, account: null, tokenStored, problem: null };
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', ...(token ? { GH_TOKEN: token } : {}) };
    const [version, user] = await Promise.all([
      withTimeout(this.run(this.gh, ['--version'], env), TIMEOUT_MS),
      withTimeout(this.run(this.gh, ['api', 'user'], env), TIMEOUT_MS),
    ]);
    const account = user.code === 0 ? parseGhUser(user.stdout) : null;
    return {
      cli: { installed: true, version: version.code === 0 ? parseGhVersion(version.stdout) : null },
      account,
      tokenStored,
      problem: account ? null : (firstLine(user.stderr) ?? (user.code === 0 ? 'gh answered, but not with an account.' : null)),
    };
  }

  private async git(cwd: string): Promise<ConnectionStatus['git']> {
    if (!this.gitBin) return { installed: false, name: null, email: null };
    const read = async (key: string) => {
      const r = await withTimeout(this.run(this.gitBin!, ['config', '--get', key], process.env, cwd), TIMEOUT_MS);
      return r.code === 0 ? r.stdout.trim() || null : null;
    };
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return { installed: true, name, email };
  }
}

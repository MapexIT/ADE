import { execFile } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(args: string[], stderr: string, exitCode: number | null) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Return stdout as a Buffer (for binary content). */
  binary?: boolean;
  /** Exit codes that are not errors (for example 1 for `git diff --exit-code`). */
  okCodes?: number[];
}

/**
 * Runs Git with an argument array, never a shell string (rule 10). Prompts are disabled so a missing
 * credential never hangs the host.
 */
export function git(args: string[], opts: RunOptions & { binary: true }): Promise<Buffer>;
export function git(args: string[], opts: RunOptions): Promise<string>;
export function git(args: string[], opts: RunOptions): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env },
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? null : 0;
        if (err && !(code !== null && opts.okCodes?.includes(code))) {
          reject(new GitError(args, stderr.toString(), code));
          return;
        }
        resolve(opts.binary ? stdout : stdout.toString('utf8'));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Identity for ADE's own snapshot commits so checkpoints never depend on the user's Git config. */
export const CHECKPOINT_IDENTITY = {
  GIT_AUTHOR_NAME: 'ADE checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@ade.invalid',
  GIT_COMMITTER_NAME: 'ADE checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@ade.invalid',
};

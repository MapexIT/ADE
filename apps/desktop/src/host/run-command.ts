import { killTree, spawnCommand, type Command, type LaunchWrapper } from '@ade/acp-client';

/** Resolves a command name on the PATH and how to spawn it without a shell (see `commandResolver`). */
export type ResolveCommand = (argv: string[]) => { command: Command; env: Record<string, string> } | null;

const MAX_OUTPUT = 400_000;

/**
 * Runs an argument array to completion and collects its output (never through a shell). With a wrapper the
 * command runs inside the session's sandbox; inside WSL the name is resolved by Linux, not the Windows PATH.
 * Returns null when the command is not found.
 */
export function runArgv(
  argv: string[],
  opts: { cwd: string; resolve: ResolveCommand; wrapper?: LaunchWrapper | null; signal?: AbortSignal },
): Promise<{ code: number | null; output: string } | null> {
  const foreign = !!opts.wrapper?.foreign;
  const resolved = foreign ? null : opts.resolve(argv);
  if (!foreign && !resolved) return Promise.resolve(null);
  const base: Command = resolved ? { command: resolved.command.command, args: [...resolved.command.args, ...argv.slice(1)] } : { command: argv[0]!, args: argv.slice(1) };
  const env = { ...(process.env as Record<string, string>), ...(resolved?.env ?? {}), CI: '1', FORCE_COLOR: '0' };
  const spec = opts.wrapper ? opts.wrapper.wrap(base, { cwd: opts.cwd, env }) : { cmd: base, cwd: opts.cwd, env };
  return new Promise((resolve) => {
    let out = '';
    const child = spawnCommand(spec.cmd, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT / 2);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const abort = () => child.pid && void killTree(child.pid);
    opts.signal?.addEventListener('abort', abort);
    child.on('error', (err) => resolve({ code: null, output: `${out}\n${err.message}` }));
    child.on('close', (c) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve({ code: c, output: out });
    });
  });
}


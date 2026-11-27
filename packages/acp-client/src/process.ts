import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, join, resolve } from 'node:path';

/** Kills a process and all its children. Windows uses taskkill /T; POSIX kills the process group. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((done) => {
    if (platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => done());
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
      done();
    }, 1500).unref();
  });
}

export interface Command {
  command: string;
  args: string[];
}

/**
 * Spawns with an argument array (never a shell string). On POSIX the child leads its own process group
 * so `killTree` can end everything it started.
 */
export function spawnCommand(cmd: Command, options: SpawnOptions): ChildProcess {
  return spawn(cmd.command, cmd.args, {
    ...options,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

/** Tracks every child process started for a session (TM-06) so ending the session ends them all. */
export class ProcessTracker {
  private readonly bySession = new Map<string, Map<number, string>>();

  add(sessionId: string, pid: number, label: string): void {
    const map = this.bySession.get(sessionId) ?? new Map<number, string>();
    map.set(pid, label);
    this.bySession.set(sessionId, map);
  }

  remove(sessionId: string, pid: number): void {
    this.bySession.get(sessionId)?.delete(pid);
  }

  list(sessionId: string): { pid: number; label: string }[] {
    return [...(this.bySession.get(sessionId) ?? new Map<number, string>())].map(([pid, label]) => ({ pid, label }));
  }

  async killSession(sessionId: string): Promise<void> {
    const map = this.bySession.get(sessionId);
    if (!map) return;
    await Promise.all([...map.keys()].map((pid) => killTree(pid)));
    this.bySession.delete(sessionId);
  }
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch (err) {
    // Windows app execution aliases (winget.exe in WindowsApps) are links whose target cannot be read, but they run.
    if ((err as NodeJS.ErrnoException).code !== 'EACCES') return false;
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }
};

/** Finds an executable on PATH. On Windows `.exe` wins over `.cmd`, which cannot be spawned without a shell. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const ext of exts) {
    for (const dir of dirs) {
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Turns a found executable into something spawnable without a shell. npm's Windows `.cmd` shims are
 * resolved to the script they wrap and run with the given node binary.
 */
export function toSpawnable(path: string, nodePath: string = process.execPath): Command | null {
  const ext = extname(path).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { command: path, args: [] };
  const text = readFileSync(path, 'utf8');
  // npm cmd-shim: "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
  const js = /"%~?dp0%?\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (js?.[1]) {
    const script = resolve(dirname(path), js[1]);
    if (existsSync(script)) return { command: nodePath, args: [script] };
  }
  // Native binary wrapped by a shim: "%dp0%\node_modules\pkg\bin\tool.exe" %*
  const exe = /"%~?dp0%?\\([^"]+\.exe)"/i.exec(text);
  if (exe?.[1]) {
    const bin = resolve(dirname(path), exe[1]);
    if (existsSync(bin)) return { command: bin, args: [] };
  }
  return null;
}

/** Runs a command and returns trimmed stdout, or null on failure. */
export function runForOutput(cmd: Command, extraArgs: string[], timeoutMs = 10_000, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd.command, [...cmd.args, ...extraArgs], { timeout: timeoutMs, windowsHide: true, env: env ?? process.env }, (err, stdout) => {
      done(err ? null : stdout.toString().trim());
    });
  });
}

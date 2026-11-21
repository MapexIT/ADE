import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { LaunchWrapper } from '@ade/acp-client';
import type { AgentId, ContainmentStatus, Session } from '@ade/contracts';
import { gitCommonDir } from '@ade/git';

/**
 * CN-07: the host sandbox. On Linux every agent process runs inside bubblewrap; on Windows a session can run
 * inside WSL2, again inside bubblewrap there. What it enforces (verified by `probe*` before any session is
 * labelled sandboxed): the whole file system is read-only except the worktree, the repository's Git folder,
 * a private /tmp and the agent's own state folders. Reads and the network are not limited.
 */

/** Where agents keep their own state (sign-in, history, caches), relative to the home folder. ADE never reads them. */
export const AGENT_STATE_DIRS = [
  '.claude',
  '.claude.json',
  '.codex',
  '.agents',
  '.config/opencode',
  '.local/share/opencode',
  '.local/state/opencode',
  '.cache',
  '.npm',
];

/** Environment passed into WSL. Everything else (PATH, HOME, Windows variables) stays on the Windows side. */
const WSL_PASS = /^(ADE_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|OPENCODE_)/;

export interface BubblewrapOptions {
  /** Paths the process may write to, bound read-write at the same place. Missing paths are skipped. */
  writable: string[];
  /** Host folder that becomes the private /tmp. */
  tmp: string;
  cwd: string;
}

/** The bubblewrap arguments, ending with `--`; the command and its arguments follow. Pure. */
export function bubblewrapArgs(opts: BubblewrapOptions): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', opts.tmp, '/tmp',
    ...opts.writable.flatMap((p) => ['--bind-try', p, p]),
    '--setenv', 'TMPDIR', '/tmp',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--chdir', opts.cwd,
    '--',
  ];
}

const DRIVE = /^([A-Za-z]):[\\/]?(.*)$/;
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i;

export const isWindowsAbsolute = (p: string) => DRIVE.test(p) || p.startsWith('\\\\');

/** `C:\Users\me` -> `/mnt/c/Users/me`; `\\wsl.localhost\Ubuntu\home\me` -> `/home/me`. Pure. */
export function windowsToWslPath(p: string, mountRoot = '/mnt/'): string {
  const unc = WSL_UNC.exec(p);
  if (unc) return (unc[1] ?? '\\').replace(/\\/g, '/');
  const drive = DRIVE.exec(p);
  if (drive) return posix.join(mountRoot, drive[1]!.toLowerCase(), drive[2]!.replace(/\\/g, '/'));
  return p.replace(/\\/g, '/');
}

/** The reverse of `windowsToWslPath`. Linux paths outside the mounts go through `\\wsl.localhost`. Pure. */
export function wslToWindowsPath(p: string, distro: string, mountRoot = '/mnt/'): string {
  if (!p.startsWith('/')) return p;
  const root = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`;
  const m = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z])(?:/(.*))?$`).exec(p);
  if (m) return `${m[1]!.toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
}

export class BubblewrapWrapper implements LaunchWrapper {
  readonly kind = 'bubblewrap' as const;
  readonly foreign = false;

  constructor(private readonly opts: { bwrap: string; writable: string[]; tmp: string }) {}

  toAgentPath(p: string) {
    return p;
  }

  toHostPath(p: string) {
    return p;
  }

  wrap(cmd: { command: string; args: string[] }, { cwd, env }: { cwd: string; env: Record<string, string> }): ReturnType<LaunchWrapper['wrap']> {
    const args = bubblewrapArgs({ writable: this.opts.writable, tmp: this.opts.tmp, cwd });
    return { cmd: { command: this.opts.bwrap, args: [...args, cmd.command, ...cmd.args] }, cwd, env };
  }
}

export class WslWrapper implements LaunchWrapper {
  readonly kind = 'wsl' as const;
  readonly foreign = true;

  constructor(private readonly opts: { distro: string; writable: string[]; tmp: string; mountRoot?: string }) {}

  toAgentPath(p: string) {
    return windowsToWslPath(p, this.opts.mountRoot);
  }

  toHostPath(p: string) {
    return wslToWindowsPath(p, this.opts.distro, this.opts.mountRoot);
  }

  wrap(cmd: { command: string; args: string[] }, { cwd, env }: { cwd: string; env: Record<string, string> }): ReturnType<LaunchWrapper['wrap']> {
    const agentCwd = this.toAgentPath(cwd);
    // WSLENV names the variables that cross into Linux. Path values are translated here because the `/p`
    // flag did not translate them reliably (see docs/DECISIONS.md).
    const passed = Object.entries(env).filter(([k]) => WSL_PASS.test(k));
    const translated = Object.fromEntries(passed.map(([k, v]) => [k, isWindowsAbsolute(v) ? this.toAgentPath(v) : v]));
    const args = [
      '-d', this.opts.distro,
      '--cd', agentCwd,
      '--exec', 'bwrap',
      ...bubblewrapArgs({ writable: this.opts.writable.map((p) => this.toAgentPath(p)), tmp: this.toAgentPath(this.opts.tmp), cwd: agentCwd }),
      cmd.command,
      ...cmd.args,
    ];
    return { cmd: { command: 'wsl.exe', args }, cwd, env: { ...env, ...translated, WSLENV: Object.keys(translated).join(':') } };
  }
}

// ------------------------------------------------------------------ probes

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (for example ENOENT). */
  spawnError: string | null;
}
export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/** `wsl.exe` writes UTF-16LE on Windows; everything else writes UTF-8. */
const decode = (buf: Buffer) => (buf.length > 1 && buf[1] === 0 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/\0/g, '');

export const execRunner: Exec = (command, args, timeoutMs = 30_000) =>
  new Promise((done) => {
    execFile(command, args, { encoding: 'buffer', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      const spawnError = e && typeof e.code === 'string' ? e.code : null;
      const code = e ? (typeof e.code === 'number' ? e.code : spawnError ? null : 1) : 0;
      done({ code, stdout: decode(stdout), stderr: decode(stderr), spawnError });
    });
  });

export interface ProbeResult {
  ok: boolean;
  reason: string | null;
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

/**
 * Proves bubblewrap enforces what ADE claims before any session is labelled sandboxed: a write inside the
 * writable folder must succeed and a write to the home folder must fail.
 */
export async function probeBubblewrap(exec: Exec, workDir: string, home: string, bwrap = 'bwrap'): Promise<ProbeResult> {
  const allowed = join(workDir, `allowed-${randomUUID().slice(0, 8)}`);
  const tmp = join(workDir, 'tmp');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const denied = join(home, `.ade-sandbox-probe-${randomUUID().slice(0, 8)}`);
  try {
    const res = await exec(bwrap, [
      ...bubblewrapArgs({ writable: [allowed], tmp, cwd: allowed }),
      '/bin/sh', '-c', 'touch ./ok; touch "$1" 2>/dev/null; exit 0', 'sh', denied,
    ]);
    if (res.spawnError === 'ENOENT') return { ok: false, reason: 'bubblewrap (bwrap) is not installed.' };
    if (existsSync(denied)) {
      await rm(denied, { force: true });
      return { ok: false, reason: 'bubblewrap ran but did not stop a write outside the worktree.' };
    }
    if (res.code !== 0) return { ok: false, reason: `bubblewrap could not start: ${firstLine(res.stderr) || `exit ${res.code}`}` };
    if (!existsSync(join(allowed, 'ok'))) return { ok: false, reason: 'bubblewrap started but the worktree was not writable.' };
    return { ok: true, reason: null };
  } finally {
    await rm(allowed, { recursive: true, force: true });
  }
}

export interface WslDistro {
  name: string;
  isDefault: boolean;
  version: number;
}

/** Parses `wsl.exe -l -v`. Docker Desktop's internal distributions are left out. Pure. */
export function parseWslList(text: string): WslDistro[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const isDefault = line.startsWith('*');
      const parts = line.replace(/^\*/, '').trim().split(/\s+/);
      return { name: parts[0] ?? '', isDefault, version: Number(parts.at(-1)) };
    })
    .filter((d) => d.name && !d.name.startsWith('docker-desktop'));
}

const WSL_PROBE_SCRIPT = [
  'command -v bwrap >/dev/null 2>&1 || { echo "nobwrap"; exit 4; }',
  'd="$HOME/.ade-sandbox-probe-$$"',
  `bwrap "$@" /bin/sh -c 'touch ./ok; touch "$1" 2>/dev/null; exit 0' sh "$d" || { echo "bwrapfailed"; exit 6; }`,
  'if [ -e "$d" ]; then rm -f "$d"; echo "leaked"; exit 5; fi',
  'echo "home=$HOME"',
  'for c in claude-agent-acp codex-acp opencode node; do command -v "$c" >/dev/null 2>&1 && echo "has=$c"; done',
  'exit 0',
].join('\n');

export interface WslProbe extends ProbeResult {
  distro: string | null;
  home: string | null;
  commands: string[];
}

/** Same proof as `probeBubblewrap`, run inside a WSL2 distribution, plus which agent adapters it has. */
export async function probeWsl(exec: Exec, workDir: string, preferred: string | null): Promise<WslProbe> {
  const none = (reason: string, distro: string | null = null): WslProbe => ({ ok: false, reason, distro, home: null, commands: [] });
  const list = await exec('wsl.exe', ['-l', '-v'], 15_000);
  if (list.spawnError) return none('WSL is not installed.');
  const distros = parseWslList(list.stdout).filter((d) => d.version === 2);
  const distro = distros.find((d) => d.name === preferred) ?? distros.find((d) => d.isDefault) ?? distros[0];
  if (!distro) return none('No WSL2 distribution is installed.');
  const allowed = join(workDir, `allowed-${randomUUID().slice(0, 8)}`);
  const tmp = join(workDir, 'tmp');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const args = bubblewrapArgs({ writable: [windowsToWslPath(allowed)], tmp: windowsToWslPath(tmp), cwd: windowsToWslPath(allowed) });
    const res = await exec('wsl.exe', ['-d', distro.name, '--exec', 'sh', '-c', WSL_PROBE_SCRIPT, 'sh', ...args], 60_000);
    const out = res.stdout;
    if (out.includes('nobwrap')) return none(`bubblewrap is not installed in ${distro.name} (sudo apt install bubblewrap).`, distro.name);
    if (out.includes('leaked')) return none(`bubblewrap in ${distro.name} did not stop a write outside the worktree.`, distro.name);
    if (res.code !== 0) return none(`bubblewrap could not start in ${distro.name}: ${firstLine(res.stderr) || firstLine(out) || `exit ${res.code}`}`, distro.name);
    if (!existsSync(join(allowed, 'ok'))) return none(`The worktree was not writable from ${distro.name}.`, distro.name);
    const home = /^home=(.+)$/m.exec(out)?.[1]?.trim() ?? null;
    const commands = [...out.matchAll(/^has=(.+)$/gm)].map((m) => m[1]!.trim());
    return { ok: true, reason: null, distro: distro.name, home, commands };
  } finally {
    await rm(allowed, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ service

/** Which agents can run inside WSL, by the adapter command found in the distribution. */
const WSL_COMMANDS: Partial<Record<AgentId, string>> = {
  'claude-code': 'claude-agent-acp',
  codex: 'codex-acp',
  opencode: 'opencode',
  fake: 'node',
};

export interface SettingsReader {
  get<T>(key: string, fallback: T): T;
}

/**
 * Detects the host sandbox once (and again on request) and builds a `LaunchWrapper` per session (Factory).
 * Never optimistic: when the probe has not passed, nothing is labelled sandboxed.
 */
export class ContainmentService {
  private cached: Promise<ContainmentStatus> | null = null;
  private wslHome: string | null = null;

  constructor(
    private readonly settings: SettingsReader,
    private readonly dirs: { probe: string; tmp: string },
    private readonly agentIds: () => AgentId[],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly exec: Exec = execRunner,
    private readonly home: string = homedir(),
  ) {}

  get mayDefaultOn(): boolean {
    return this.platform === 'linux';
  }

  status(refresh = false): Promise<ContainmentStatus> {
    if (!this.cached || refresh) this.cached = this.detect();
    return this.cached;
  }

  private async detect(): Promise<ContainmentStatus> {
    const base = { distro: null, agents: [] as AgentId[] };
    if (this.platform === 'linux') {
      const probe = await probeBubblewrap(this.exec, this.dirs.probe, this.home);
      return {
        ...base,
        kind: 'bubblewrap',
        available: probe.ok,
        reason: probe.reason,
        defaultOn: probe.ok && this.settings.get<boolean>('sandbox.byDefault', true),
        agents: probe.ok ? this.agentIds() : [],
      };
    }
    if (this.platform === 'win32') {
      const probe = await probeWsl(this.exec, this.dirs.probe, this.settings.get<string | null>('sandbox.wslDistro', null));
      this.wslHome = probe.home;
      const agents = this.agentIds().filter((id) => {
        const cmd = WSL_COMMANDS[id];
        return !!cmd && probe.commands.includes(cmd);
      });
      return { kind: 'wsl', available: probe.ok, reason: probe.reason, distro: probe.distro, defaultOn: false, agents };
    }
    return { ...base, kind: 'none', available: false, reason: 'The host sandbox is not available on this platform yet.', defaultOn: false };
  }

  /** A wrapper for a contained session, or null when the session is not contained. Throws when it no longer can be. */
  async wrapperFor(session: Session, repoRoot: string, extraWritable: string[] = []): Promise<LaunchWrapper | null> {
    if (session.containment === 'none') return null;
    const status = await this.status();
    if (!status.available || status.kind !== session.containment) {
      throw new Error(`The host sandbox is not available any more (${status.reason ?? 'unknown reason'}); the session will not start without it.`);
    }
    const tmp = join(this.dirs.tmp, session.id);
    mkdirSync(tmp, { recursive: true });
    const worktree = session.worktreePath!;
    const git = await gitCommonDir(repoRoot);
    if (session.containment === 'bubblewrap') {
      const writable = [worktree, git, ...extraWritable, ...AGENT_STATE_DIRS.map((d) => join(this.home, d))];
      return new BubblewrapWrapper({ bwrap: 'bwrap', writable, tmp });
    }
    const linuxHome = this.wslHome;
    const state = linuxHome ? AGENT_STATE_DIRS.map((d) => posix.join(linuxHome, d)) : [];
    // Linux paths pass through `toAgentPath` unchanged, so the writable list can mix both kinds.
    return new WslWrapper({ distro: status.distro!, writable: [worktree, git, ...extraWritable, ...state], tmp });
  }

  /** Removes a session's private /tmp. */
  async release(sessionId: string): Promise<void> {
    await rm(join(this.dirs.tmp, sessionId), { recursive: true, force: true });
  }
}

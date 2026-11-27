/**
 * ST-07: installs a missing coding CLI from the top bar, only when the user presses Install.
 *
 * The OS package manager is used when its official repository has the package; otherwise npm. Package names were
 * checked (DECISIONS, "Installing coding CLIs"): winget on this machine with `winget show`, npm with `npm view`,
 * Arch and openSUSE through Repology and archlinux.org. Debian, Ubuntu and Fedora have none of the three, so they use npm.
 * Every command is an argument array; system package managers go through pkexec so the OS asks for the password.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { findOnPath, killTree, spawnCommand, toSpawnable, type Command } from '@ade/acp-client';
import { PRODUCT_AGENTS, RpcError, type AgentId, type AgentInstallPlan, type AgentInstallState, type InstallManager } from '@ade/contracts';

type ProductAgent = (typeof PRODUCT_AGENTS)[number];

/** Package names per manager; null where that repository does not carry the tool. */
export const PACKAGES: Record<ProductAgent, { winget: string; npm: string; pacman: string | null; zypper: string | null }> = {
  'claude-code': { winget: 'Anthropic.ClaudeCode', npm: '@anthropic-ai/claude-code', pacman: null, zypper: null },
  codex: { winget: 'OpenAI.Codex', npm: '@openai/codex', pacman: 'openai-codex', zypper: 'openai-codex' },
  opencode: { winget: 'Anomaly.OpenCode', npm: 'opencode-ai', pacman: 'opencode', zypper: 'opencode' },
};

export interface OsRelease {
  id: string;
  idLike: string[];
}

/** Reads `ID` and `ID_LIKE` from os-release text. Pure. */
export function parseOsRelease(text: string): OsRelease {
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { id: get('ID').toLowerCase(), idLike: get('ID_LIKE').toLowerCase().split(/\s+/).filter(Boolean) };
}

export interface PlanEnv {
  platform: NodeJS.Platform;
  os: OsRelease | null;
  /** Whether a program is on PATH. */
  has: (name: string) => boolean;
}

export interface Plan {
  agentId: ProductAgent;
  manager: InstallManager;
  argv: string[];
  elevated: boolean;
}

const isArch = (os: OsRelease | null) => !!os && (os.id === 'arch' || os.idLike.includes('arch'));
// Only Tumbleweed carries them; Leap does not.
const isTumbleweed = (os: OsRelease | null) => !!os && os.id === 'opensuse-tumbleweed';

/** Picks how to install `agentId` here, or a reason it cannot be installed. Pure. */
export function planInstall(agentId: ProductAgent, env: PlanEnv): Plan | { problem: string } {
  const pkg = PACKAGES[agentId];
  if (env.platform === 'win32' && env.has('winget')) {
    return {
      agentId,
      manager: 'winget',
      argv: ['winget', 'install', '--id', pkg.winget, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
      elevated: false,
    };
  }
  if (env.platform === 'linux' && env.has('pkexec')) {
    if (pkg.pacman && isArch(env.os) && env.has('pacman')) return { agentId, manager: 'pacman', argv: ['pkexec', 'pacman', '-S', '--needed', '--noconfirm', pkg.pacman], elevated: true };
    if (pkg.zypper && isTumbleweed(env.os) && env.has('zypper')) return { agentId, manager: 'zypper', argv: ['pkexec', 'zypper', '--non-interactive', 'install', pkg.zypper], elevated: true };
  }
  if (env.has('npm')) return { agentId, manager: 'npm', argv: ['npm', 'install', '--global', pkg.npm], elevated: false };
  return {
    problem:
      env.platform === 'win32'
        ? 'Neither winget nor npm was found. Install App Installer from the Microsoft Store, or Node.js, then check again.'
        : 'npm was not found and this system’s package manager does not carry it. Install Node.js, then check again.',
  };
}

/** Keeps the end of a growing output. Pure. */
export function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export interface InstallDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readOsRelease?: () => string | null;
  spawn?: (cmd: Command, env: NodeJS.ProcessEnv) => ChildProcess;
  emit: (state: AgentInstallState) => void;
  /** Called after a successful install, so agent health is detected again. */
  installed: (agentId: AgentId) => Promise<void> | void;
  timeoutMs?: number;
}

const readOs = () => {
  for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      // try the next one
    }
  }
  return null;
};

export class AgentInstaller {
  private readonly states = new Map<AgentId, AgentInstallState>();
  private readonly children = new Map<AgentId, ChildProcess>();
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: InstallDeps) {
    this.platform = deps.platform ?? process.platform;
    this.env = deps.env ?? process.env;
  }

  private planEnv(): PlanEnv {
    const text = this.platform === 'linux' ? (this.deps.readOsRelease ?? readOs)() : null;
    return { platform: this.platform, os: text ? parseOsRelease(text) : null, has: (n) => !!findOnPath(n, this.env, this.platform) };
  }

  plans(): AgentInstallPlan[] {
    const env = this.planEnv();
    return PRODUCT_AGENTS.map((agentId) => {
      const p = planInstall(agentId, env);
      return 'problem' in p
        ? { agentId, manager: null, command: null, elevated: false, problem: p.problem }
        : { agentId, manager: p.manager, command: p.argv.join(' '), elevated: p.elevated, problem: null };
    });
  }

  list(): AgentInstallState[] {
    return [...this.states.values()];
  }

  install(agentId: AgentId): AgentInstallState {
    if (agentId === 'fake') throw new RpcError('invalid', 'The test agent cannot be installed.');
    const running = this.states.get(agentId);
    if (running?.state === 'running') return running;
    const plan = planInstall(agentId, this.planEnv());
    if ('problem' in plan) throw new RpcError('unavailable', plan.problem);
    const cmd = this.resolve(plan.argv);
    if (!cmd) throw new RpcError('unavailable', `${plan.argv[0]} was found but cannot be started.`);

    let state: AgentInstallState = { agentId, state: 'running', manager: plan.manager, command: plan.argv.join(' '), output: '', error: null };
    const update = (patch: Partial<AgentInstallState>) => {
      state = { ...state, ...patch };
      this.states.set(agentId, state);
      this.deps.emit(state);
    };
    update({});

    let child: ChildProcess;
    try {
      child = (this.deps.spawn ?? ((c, env) => spawnCommand(c, { env, stdio: ['ignore', 'pipe', 'pipe'] })))(cmd, this.env);
    } catch (err) {
      update({ state: 'failed', error: (err as Error).message });
      return state;
    }
    this.children.set(agentId, child);
    let out = '';
    let pending: NodeJS.Timeout | null = null;
    const onData = (d: Buffer) => {
      // winget redraws its progress bar with carriage returns; keep only the last frame of each line.
      out = tail(out + d.toString().replace(/\r(?!\n)[^\n]*(?=\r)/g, ''), 8000);
      pending ??= setTimeout(() => {
        pending = null;
        if (state.state === 'running') update({ output: tail(out) });
      }, 150);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => void (child.pid && killTree(child.pid, this.platform)), this.deps.timeoutMs ?? 15 * 60_000);
    timer.unref?.();
    let finished = false;
    const finish = async (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (pending) clearTimeout(pending);
      this.children.delete(agentId);
      const output = tail(out);
      if (error || code !== 0) {
        update({ state: 'failed', output, error: error?.message ?? failure(plan, code) });
        return;
      }
      if (plan.manager === 'winget') this.addWingetLinks();
      try {
        await this.deps.installed(agentId);
      } catch {
        // detection runs again on the next check
      }
      update({ state: 'done', output });
    };
    child.on('error', (err) => void finish(null, err));
    child.on('close', (code) => void finish(code));
    return state;
  }

  /** npm's Windows shim is resolved to its script and run with the real node next to it. */
  private resolve(argv: string[]): Command | null {
    const [name, ...args] = argv;
    const path = findOnPath(name!, this.env, this.platform);
    if (!path) return null;
    const node = findOnPath('node', this.env, this.platform) ?? process.execPath;
    const base = toSpawnable(path, node);
    return base ? { command: base.command, args: [...base.args, ...args] } : null;
  }

  /**
   * winget links portable packages into %LOCALAPPDATA%\Microsoft\WinGet\Links and adds that folder to the user's PATH,
   * which this already-running process does not see; add it here so the CLI is found without restarting ADE.
   */
  private addWingetLinks() {
    const local = this.env.LOCALAPPDATA;
    if (!local) return;
    const links = join(local, 'Microsoft', 'WinGet', 'Links');
    const key = 'PATH' in this.env ? 'PATH' : 'Path';
    const current = this.env[key] ?? '';
    if (existsSync(links) && !current.toLowerCase().split(';').includes(links.toLowerCase())) this.env[key] = current ? `${current};${links}` : links;
  }

  async dispose() {
    await Promise.all([...this.children.values()].map((c) => (c.pid ? killTree(c.pid, this.platform) : undefined)));
    this.children.clear();
  }
}

function failure(plan: Plan, code: number | null): string {
  if (code === null) return 'The installer was stopped.';
  // pkexec: 126 when the password prompt was dismissed, 127 when not authorised.
  if (plan.elevated && (code === 126 || code === 127)) return 'The password prompt was cancelled or refused.';
  if (plan.manager === 'npm' && code !== 0) return `npm exited with code ${code}. If it says EACCES, npm’s global folder needs administrator rights; set a user prefix (npm config set prefix) and try again.`;
  return `${plan.manager} exited with code ${code}.`;
}

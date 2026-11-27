import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { findOnPath, killTree, toSpawnable } from '@ade/acp-client';
import type { CommandBlock, ShellKind, TerminalInfo, TerminalKind } from '@ade/contracts';
import { BlockBuilder, detectShells, plainLaunch, ShellIntegrationParser, smartLaunch, stripAnsi } from '@ade/shell-integration';

/** The parts of node-pty the manager uses. Injected so tests run without a real pty. */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
) => PtyLike;

export interface TerminalEvents {
  data(id: string, data: string): void;
  block(id: string, block: CommandBlock): void;
  exit(id: string, exitCode: number | null): void;
  changed(info: TerminalInfo): void;
  runFinished(runId: string, exitCode: number | null, output: string): void;
}

interface Terminal {
  info: TerminalInfo;
  pty: PtyLike;
  parser: ShellIntegrationParser | null;
  builder: BlockBuilder | null;
  idleTimer: NodeJS.Timeout | null;
  fallbackTimer: NodeJS.Timeout | null;
  runId: string | null;
  output: string;
}

const AGENT_IDLE_MS = 3000;
const INTEGRATION_GRACE_MS = 5000;
const RUN_OUTPUT_LIMIT = 200_000;

/**
 * Owns every pty: tabs, smart blocks, agent awareness and runs (TM-01, SM-01 to SM-05, CR-02/03).
 * One instance lives in the pty utility process.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly spawnPty: PtyFactory,
    private readonly events: TerminalEvents,
    private readonly scriptsDir?: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  shells() {
    return detectShells(this.platform);
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => t.info);
  }

  clearBlocks(id: string): void {
    this.terminals.get(id)?.builder?.clearFinished();
  }

  blocks(id: string): CommandBlock[] {
    const t = this.terminals.get(id);
    if (!t?.builder) return [];
    return t.builder.running ? [...t.builder.blocks, t.builder.running] : t.builder.blocks;
  }

  private defaultShell(): { id: ShellKind; path: string } {
    const found = this.shells()[0];
    if (found) return found;
    return this.platform === 'win32' ? { id: 'powershell', path: 'powershell.exe' } : { id: 'bash', path: '/bin/sh' };
  }

  /** Resolves a program so it can run without a shell (npm `.cmd` shims become `node script.js`). */
  private resolveProgram(command: string[]): { file: string; args: string[] } {
    const [head = '', ...rest] = command;
    const found = /[\\/]/.test(head) ? head : findOnPath(head) ?? head;
    const ext = extname(found).toLowerCase();
    if (this.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      const spawnable = toSpawnable(found, findOnPath('node') ?? 'node');
      if (spawnable) return { file: spawnable.command, args: [...spawnable.args, ...rest] };
      // A batch file that is not an npm shim can only run through cmd.exe. The arguments come from the
      // user's own run configuration, never from an agent.
      return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', found, ...rest] };
    }
    return { file: found, args: rest };
  }

  create(opts: {
    kind: TerminalKind;
    shell?: ShellKind;
    cwd: string;
    cols: number;
    rows: number;
    sessionId: string | null;
    command?: string[];
    title?: string;
    runId?: string;
    env?: Record<string, string>;
  }): TerminalInfo {
    const id = randomUUID();
    let file: string;
    let args: string[];
    let extraEnv: Record<string, string> = {};
    let smart = false;
    let shellName: string;

    if (opts.command?.length) {
      ({ file, args } = this.resolveProgram(opts.command));
      shellName = opts.command[0]!;
    } else {
      const shells = this.shells();
      const chosen = (opts.shell && shells.find((s) => s.id === opts.shell)) || this.defaultShell();
      shellName = chosen.id;
      const launch = opts.kind === 'smart' ? smartLaunch(chosen.id, chosen.path, this.scriptsDir) : plainLaunch(chosen.path);
      file = launch.file;
      args = launch.args;
      extraEnv = launch.env;
      smart = launch.integrated;
    }

    const env = { ...(process.env as Record<string, string>), ...extraEnv, ...(opts.env ?? {}), TERM_PROGRAM: 'ADE', COLORTERM: 'truecolor' };
    const pty = this.spawnPty(file, args, { cwd: opts.cwd, env, cols: opts.cols, rows: opts.rows, name: 'xterm-256color' });
    const info: TerminalInfo = {
      id,
      kind: opts.kind,
      shell: shellName,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      title: opts.title ?? (opts.kind === 'agent-ui' ? `${shellName} UI` : `${opts.kind === 'smart' ? 'Smart' : 'Plain'} · ${shellName}`),
      pid: pty.pid,
      smart,
      agentState: opts.kind === 'agent-ui' ? 'working' : 'none',
    };
    const term: Terminal = {
      info,
      pty,
      parser: smart || opts.kind === 'agent-ui' ? new ShellIntegrationParser() : null,
      builder: smart ? new BlockBuilder((b) => this.events.block(id, b), Date.now, `${id.slice(0, 4)}-`) : null,
      idleTimer: null,
      fallbackTimer: null,
      runId: opts.runId ?? null,
      output: '',
    };
    this.terminals.set(id, term);

    if (smart) {
      // SM-02: a shell that never reports integration falls back to a plain terminal with a notice.
      term.fallbackTimer = setTimeout(() => {
        if (term.builder && !term.builder.integrated) {
          term.builder = null;
          term.parser = null;
          this.update(term, { smart: false });
          this.events.data(id, '\r\n\x1b[33m[ADE] Shell integration did not start; this terminal runs as a plain terminal.\x1b[0m\r\n');
        }
      }, INTEGRATION_GRACE_MS);
    }

    pty.onData((data) => this.onData(term, data));
    pty.onExit(({ exitCode }) => this.onExit(term, exitCode));
    return info;
  }

  private update(term: Terminal, patch: Partial<TerminalInfo>) {
    term.info = { ...term.info, ...patch };
    this.events.changed(term.info);
  }

  private onData(term: Terminal, data: string) {
    this.events.data(term.info.id, data);
    if (term.runId) {
      term.output += data;
      if (term.output.length > RUN_OUTPUT_LIMIT) term.output = term.output.slice(-RUN_OUTPUT_LIMIT);
    }
    let notified = false;
    if (term.parser) {
      for (const e of term.parser.feed(data)) {
        term.builder?.push(e);
        if (e.type === 'cwd' && e.path !== term.info.cwd) this.update(term, { cwd: e.path });
        if (e.type === 'notify' && term.info.kind === 'agent-ui') {
          notified = true;
          this.update(term, { agentState: 'waiting' });
        }
      }
    }
    if (term.info.kind === 'agent-ui' && !notified) {
      // SM-04: output means working; a quiet agent UI is waiting for the user.
      if (term.info.agentState !== 'working' && term.info.agentState !== 'finished') this.update(term, { agentState: 'working' });
      if (term.idleTimer) clearTimeout(term.idleTimer);
      term.idleTimer = setTimeout(() => {
        if (term.info.agentState === 'working') this.update(term, { agentState: 'waiting' });
      }, AGENT_IDLE_MS);
    }
  }

  private onExit(term: Terminal, exitCode: number | null) {
    if (term.idleTimer) clearTimeout(term.idleTimer);
    if (term.fallbackTimer) clearTimeout(term.fallbackTimer);
    if (term.info.kind === 'agent-ui') this.update(term, { agentState: 'finished' });
    this.events.exit(term.info.id, exitCode);
    if (term.runId) this.events.runFinished(term.runId, exitCode, stripAnsi(term.output));
    this.terminals.delete(term.info.id);
  }

  write(id: string, data: string) {
    this.terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    this.terminals.get(id)?.pty.resize(cols, rows);
  }

  /** TM-06: kills the process tree, not just the shell. */
  async kill(id: string) {
    const t = this.terminals.get(id);
    if (!t) return;
    await killTree(t.pty.pid, this.platform);
    try {
      t.pty.kill();
    } catch {
      // already gone
    }
  }

  async killSession(sessionId: string) {
    await Promise.all([...this.terminals.values()].filter((t) => t.info.sessionId === sessionId).map((t) => this.kill(t.info.id)));
  }

  /** CR-02/03: a run is a program in a pty (no shell), reported as a terminal and as a run result. */
  run(opts: { command: string[]; cwd: string; sessionId: string | null; runId: string; cols?: number; rows?: number; env?: Record<string, string> }): { terminalId: string } {
    const info = this.create({
      kind: 'plain',
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      sessionId: opts.sessionId,
      command: opts.command,
      title: `Run · ${opts.command.join(' ')}`,
      runId: opts.runId,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { terminalId: info.id };
  }

  async dispose() {
    await Promise.all([...this.terminals.keys()].map((id) => this.kill(id)));
  }
}

import { isAbsolute, join, relative } from 'node:path';
import { RpcError, type CheckResult, type CheckSettings } from '@ade/contracts';
import type { Repositories } from './repositories.ts';
import { runArgv, type ResolveCommand } from './run-command.ts';
import type { SandboxProvider, SessionService } from './session-service.ts';

const OUTPUT_TAIL = 20_000;
export const checksKey = (workspaceId: string) => `checks.${workspaceId}`;

/**
 * RV-10: run configurations used as checks, in the session's worktree (and its sandbox), on demand or after
 * each turn. Every check is a normal run in the history; failures can go to the agent in one prompt.
 */
export class ChecksService {
  private readonly results = new Map<string, CheckResult[]>();
  private readonly running = new Set<string>();

  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
    private readonly resolve: ResolveCommand,
    private readonly sandbox: () => SandboxProvider | null,
  ) {}

  settings(workspaceId: string): CheckSettings {
    return this.repos.settings.get<CheckSettings>(checksKey(workspaceId), { configIds: [], afterTurn: false });
  }

  save(workspaceId: string, settings: CheckSettings) {
    this.repos.settings.set(checksKey(workspaceId), settings);
  }

  /** RV-16: told about every finished run of the checks. Set by the composition root. */
  onResults: ((sessionId: string, results: CheckResult[]) => void) | null = null;

  last(sessionId: string): CheckResult[] {
    return this.results.get(sessionId) ?? [];
  }

  /** Called after every turn; runs the checks only when the workspace asked for that. */
  async afterTurn(sessionId: string): Promise<void> {
    const session = this.repos.sessions.get(sessionId);
    if (!session || !this.settings(session.workspaceId).afterTurn) return;
    await this.run(sessionId);
  }

  async run(sessionId: string): Promise<CheckResult[]> {
    const session = this.repos.sessions.require(sessionId);
    if (!session.worktreePath) throw new RpcError('no_worktree', 'This session has no worktree.');
    if (this.running.has(sessionId)) throw new RpcError('busy', 'The checks are already running.');
    const workspace = this.repos.workspaces.get(session.workspaceId)!;
    const { configIds } = this.settings(session.workspaceId);
    const configs = this.repos.runs.configs(session.workspaceId).filter((c) => configIds.includes(c.id));
    if (!configs.length) throw new RpcError('no_checks', 'Choose which run configurations are checks first.');
    this.running.add(sessionId);
    try {
      const wrapper = session.containment !== 'none' ? ((await this.sandbox()?.wrapperFor(session, workspace.rootPath)) ?? null) : null;
      const out: CheckResult[] = [];
      for (const config of configs) {
        // Configurations are stored for the checkout; run them at the same place inside the worktree.
        const rel = isAbsolute(config.cwd) ? relative(workspace.rootPath, config.cwd) : config.cwd;
        const cwd = rel && !rel.startsWith('..') ? join(session.worktreePath, rel) : session.worktreePath;
        const startedAt = new Date().toISOString();
        const res = (await runArgv(config.command, { cwd, resolve: this.resolve, wrapper })) ?? { code: null, output: `${config.command[0]} was not found on the PATH.` };
        const finishedAt = new Date().toISOString();
        const run = this.repos.runs.record(
          { runConfigId: config.id, sessionId, worktreePath: session.worktreePath, command: config.command, startedAt, endedAt: finishedAt, exitCode: res.code, output: res.output },
          session.workspaceId,
        );
        this.sessions.record(sessionId, { type: 'run.finished', runId: run.id, exitCode: res.code });
        out.push({ configId: config.id, name: config.name, command: config.command, exitCode: res.code, output: res.output.slice(-OUTPUT_TAIL), runId: run.id, finishedAt });
      }
      const failed = out.filter((r) => r.exitCode !== 0);
      this.sessions.record(sessionId, {
        type: 'notice',
        level: failed.length ? 'warning' : 'info',
        text: failed.length ? `Checks: ${failed.length} of ${out.length} failed (${failed.map((f) => f.name).join(', ')}).` : `Checks: all ${out.length} passed.`,
      });
      this.results.set(sessionId, out);
      this.onResults?.(sessionId, out);
      return out;
    } finally {
      this.running.delete(sessionId);
    }
  }
}

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  INTEGRATE_MAX_SESSIONS,
  RpcError,
  type IntegrateAlone,
  type IntegrateCandidate,
  type IntegrateCheck,
  type IntegrateLandItem,
  type IntegrateLandResult,
  type IntegrateOverview,
  type IntegratePair,
  type IntegrateStep,
  type IntegrateTrial,
  type IntegrateTrialStatus,
  type Session,
} from '@ade/contracts';
import { CHECKPOINT_IDENTITY, changedFiles, copyFiles, currentBranch, deleteRefs, git, restoreSnapshot, revParse, snapshot } from '@ade/git';
import { isLive, isTerminal } from '@ade/session-core';
import type { EventBus } from './bus.ts';
import type { ChecksService } from './checks.ts';
import type { Database } from './db.ts';
import { briefing, checkVerdict, classifyFit, defaultOrder, sharedPaths, staleness, type MemberMark } from './integrate-plan.ts';
import type { Repositories } from './repositories.ts';
import type { ReviewService } from './review-service.ts';
import { unreviewedAmong } from './review-progress.ts';
import { runArgv, type ResolveCommand } from './run-command.ts';
import type { SandboxProvider, SessionService } from './session-service.ts';
import { readWorkspaceConfig, toArgv } from './workspace-config.ts';

const OUTPUT_TAIL = 20_000;
export const integrateRefPrefix = (trialId: string) => `refs/ade/integrate/${trialId}/`;

type WorktreeSession = Session & { worktreePath: string; baseCommit: string };

/** A member as the trial stores it: the staleness mark plus the tree that was merged. */
interface Member extends MemberMark {
  tree: string | null;
}

interface TrialRow extends Omit<IntegrateTrial, 'outOfDate'> {
  members: Member[];
}

/** PL-06: integration trials, one table, rows mapped to the contract type. */
class TrialRepo {
  constructor(private readonly db: Database) {}

  private map = (r: Record<string, unknown>): TrialRow => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    order: JSON.parse(String(r.order_json)) as string[],
    head: String(r.head),
    members: JSON.parse(String(r.members_json)) as Member[],
    steps: JSON.parse(String(r.steps_json)) as IntegrateStep[],
    checks: JSON.parse(String(r.checks_json)) as IntegrateCheck[],
    runChecks: Number(r.run_checks) === 1,
    sandboxed: Number(r.sandboxed) === 1,
    status: String(r.status) as IntegrateTrialStatus,
    error: r.error === null || r.error === undefined ? null : String(r.error),
    landed: JSON.parse(String(r.landed_json ?? '[]')) as string[],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  });

  insert(t: TrialRow): void {
    this.db.run(
      `INSERT INTO integration_trials (id, workspace_id, order_json, head, members_json, steps_json, checks_json, run_checks, sandboxed, status, error, landed_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.workspaceId, JSON.stringify(t.order), t.head, JSON.stringify(t.members), JSON.stringify(t.steps), JSON.stringify(t.checks),
      t.runChecks ? 1 : 0, t.sandboxed ? 1 : 0, t.status, t.error, JSON.stringify(t.landed), t.createdAt, t.updatedAt,
    );
  }

  save(t: TrialRow): void {
    t.updatedAt = new Date().toISOString();
    this.db.run(
      'UPDATE integration_trials SET steps_json = ?, checks_json = ?, sandboxed = ?, status = ?, error = ?, landed_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(t.steps), JSON.stringify(t.checks), t.sandboxed ? 1 : 0, t.status, t.error, JSON.stringify(t.landed), t.updatedAt, t.id,
    );
  }

  get(id: string): TrialRow | null {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM integration_trials WHERE id = ?', id);
    return r ? this.map(r) : null;
  }

  latest(workspaceId: string): TrialRow | null {
    const r = this.db.get<Record<string, unknown>>('SELECT * FROM integration_trials WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1', workspaceId);
    return r ? this.map(r) : null;
  }

  list(workspaceId?: string): TrialRow[] {
    const rows = workspaceId
      ? this.db.all<Record<string, unknown>>('SELECT * FROM integration_trials WHERE workspace_id = ?', workspaceId)
      : this.db.all<Record<string, unknown>>('SELECT * FROM integration_trials');
    return rows.map(this.map);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM integration_trials WHERE id = ?', id);
  }

  /** How a session's own last run of a check ended (RV-10 runs carry the session and the configuration). */
  lastRun(sessionId: string, configId: string): IntegrateAlone {
    const r = this.db.get<{ exit_code: number | null }>(
      'SELECT exit_code FROM runs WHERE session_id = ? AND run_config_id = ? ORDER BY started_at DESC LIMIT 1',
      sessionId,
      configId,
    );
    if (!r) return 'not-run';
    return r.exit_code === 0 ? 'passed' : 'failed';
  }
}

export interface IntegrateDeps {
  repos: Repositories;
  bus: EventBus;
  sessions: SessionService;
  review: ReviewService;
  checks: ChecksService;
  resolveCommand: ResolveCommand;
  sandbox: () => SandboxProvider | null;
  /** RV-16: the session's open receipt items, one line each. */
  receiptItems: (sessionId: string) => string[];
  /** Temporary detached worktrees for the combined checks live here. */
  tmpRoot: string;
}

/**
 * PL-06 Integrate. Every merge happens in the object database (`merge-tree --write-tree`, `commit-tree`): no
 * worktree, index or checkout file changes until the user presses Land in order. Combined checks run in a temporary
 * detached worktree that is removed afterwards.
 */
export class IntegrateService {
  private readonly trials: TrialRepo;
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly off: () => void;

  constructor(private readonly deps: IntegrateDeps) {
    this.trials = new TrialRepo(deps.repos.db);
    // A session that ends takes its trials' refs with it (the rows stay, marked out of date).
    this.off = deps.bus.on('session.changed', ({ workspaceId, session }) => {
      if (!isTerminal(session.state)) return;
      for (const t of this.trials.list(workspaceId)) {
        if (t.order.includes(session.id) && !this.running.has(t.id)) this.track(this.dropRefs(t));
      }
    });
  }

  private root(workspaceId: string): string {
    const ws = this.deps.repos.workspaces.get(workspaceId);
    if (!ws) throw new RpcError('not_found', 'Unknown workspace');
    return ws.rootPath;
  }

  private track(work: Promise<unknown>) {
    const p = work.catch(() => undefined).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private emit(t: { workspaceId: string; id: string }) {
    this.deps.bus.emit('integrate.changed', { workspaceId: t.workspaceId, trialId: t.id });
  }

  /** The newest checkpoint of a session (a turn's end, else its start), with the base it sits on. */
  private mark(s: Session): string {
    const turns = this.deps.repos.turns.list(s.id);
    const last = turns[turns.length - 1];
    return `${s.baseCommit ?? ''}|${last?.endCheckpoint ?? last?.startCheckpoint ?? ''}`;
  }

  private lastCheckpoint(sessionId: string): string | null {
    const turns = this.deps.repos.turns.list(sessionId);
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!;
      if (t.endCheckpoint) return t.endCheckpoint;
      if (t.startCheckpoint) return t.startCheckpoint;
    }
    return null;
  }

  private static worktreeSession(s: Session): s is WorktreeSession {
    return !!s.worktreePath && !!s.baseCommit && !s.inPlace && !isTerminal(s.state);
  }

  private static isReady(s: Session) {
    return s.state === 'ready';
  }

  /** Three-way merge of `theirs` onto `ours` with an explicit base. Exit 1 means conflicts. */
  private static async merge(cwd: string, base: string, ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
    const out = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs], { cwd, okCodes: [1] });
    const [tree = '', ...conflicts] = out.split(/\r?\n/).filter(Boolean);
    return { tree, conflicts: [...new Set(conflicts)] };
  }

  // ------------------------------------------------------------------ overview

  async overview(workspaceId: string): Promise<IntegrateOverview> {
    const root = this.root(workspaceId);
    const head = await revParse(root, 'HEAD');
    const branch = await currentBranch(root);
    const all = this.deps.repos.sessions.list(workspaceId).filter(IntegrateService.worktreeSession);
    type Loaded = IntegrateCandidate & { commit: string; base: string };
    const loaded: Loaded[] = [];
    for (const s of all) {
      const ready = IntegrateService.isReady(s);
      if (!ready && !(isLive(s.state) || s.state === 'queued')) continue;
      // Ready sessions are snapshotted (user edits count); working ones are compared at their last checkpoint.
      const commit = ready ? await snapshot(s.worktreePath, null, 'ADE integrate').catch(() => null) : this.lastCheckpoint(s.id);
      if (!commit) continue;
      const changes = await changedFiles(s.worktreePath, s.baseCommit, commit).catch(() => []);
      if (!changes.length) continue;
      const files = [...new Set(changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])))].sort();
      loaded.push({
        sessionId: s.id,
        title: s.title,
        agentId: s.agentId,
        state: s.state,
        ready,
        files,
        additions: changes.reduce((n, c) => n + c.additions, 0),
        deletions: changes.reduce((n, c) => n + c.deletions, 0),
        checkout: { fit: 'fits', files: [], behind: 0 },
        commit,
        base: s.baseCommit,
      });
    }
    const ordered = [...defaultOrder(loaded.filter((c) => c.ready)), ...defaultOrder(loaded.filter((c) => !c.ready))];
    const shown = ordered.slice(0, INTEGRATE_MAX_SESSIONS);
    const hidden = ordered.length - shown.length;

    // Each session against the checkout's current commit.
    const sinceBase = new Map<string, { files: string[]; behind: number }>();
    for (const c of shown) {
      if (c.base === head) continue;
      let drift = sinceBase.get(c.base);
      if (!drift) {
        const files = (await git(['diff', '--name-only', '-z', c.base, head], { cwd: root })).split('\0').filter(Boolean);
        const behind = Number((await git(['rev-list', '--count', `${c.base}..${head}`], { cwd: root })).trim()) || 0;
        drift = { files, behind };
        sinceBase.set(c.base, drift);
      }
      const { conflicts } = await IntegrateService.merge(root, c.base, head, c.commit);
      c.checkout = { ...classifyFit(conflicts, sharedPaths(c.files, drift.files)), behind: drift.behind };
    }

    const pairs: IntegratePair[] = [];
    const bases = new Map<string, string>();
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i]!;
        const b = shown[j]!;
        const key = [a.base, b.base].sort().join(':');
        let mb = bases.get(key);
        if (!mb) {
          mb = a.base === b.base ? a.base : (await git(['merge-base', a.base, b.base], { cwd: root })).trim();
          bases.set(key, mb);
        }
        const { conflicts } = await IntegrateService.merge(root, mb, a.commit, b.commit);
        pairs.push({ a: a.sessionId, b: b.sessionId, ...classifyFit(conflicts, sharedPaths(a.files, b.files)) });
      }

    const { configIds } = this.deps.checks.settings(workspaceId);
    const checks = this.deps.repos.runs
      .configs(workspaceId)
      .filter((c) => configIds.includes(c.id))
      .map((c) => ({ configId: c.id, name: c.name }));
    return {
      workspaceId,
      head,
      branch,
      candidates: shown.map(({ commit: _c, base: _b, ...rest }) => rest),
      pairs,
      hidden,
      checks,
    };
  }

  // ------------------------------------------------------------------ trial

  async trial(workspaceId: string, order: string[], runChecks: boolean): Promise<IntegrateTrial> {
    const root = this.root(workspaceId);
    if (new Set(order).size !== order.length) throw new RpcError('invalid', 'A session appears twice in the order.');
    for (const t of this.trials.list(workspaceId)) if (this.running.has(t.id)) throw new RpcError('busy', 'A trial is already running. Wait for it or cancel it.');
    const members: WorktreeSession[] = order.map((id) => {
      const s = this.deps.repos.sessions.get(id);
      if (!s || s.workspaceId !== workspaceId) throw new RpcError('not_found', 'That session is not in this workspace.');
      if (!IntegrateService.worktreeSession(s) || !IntegrateService.isReady(s)) throw new RpcError('not_ready', `"${s.title}" is not ready to integrate.`);
      return s;
    });
    // One trial per workspace: a new one replaces the last (and its refs).
    for (const old of this.trials.list(workspaceId)) await this.remove(old);
    const head = await revParse(root, 'HEAD');
    const now = new Date().toISOString();
    const row: TrialRow = {
      id: randomUUID(),
      workspaceId,
      order,
      head,
      members: members.map((s) => ({ sessionId: s.id, checkpoint: this.mark(s), tree: null })),
      steps: members.map((s) => ({ sessionId: s.id, title: s.title, status: 'pending', commit: null, conflicts: [], changed: [] })),
      runChecks,
      checks: [],
      sandboxed: false,
      status: 'running',
      error: null,
      landed: [],
      createdAt: now,
      updatedAt: now,
    };
    this.trials.insert(row);
    this.deps.repos.audit.append({ workspaceId, sessionId: null, actor: 'user', action: 'integration.trial', detail: { trialId: row.id, order, runChecks, head } });
    const ac = new AbortController();
    this.running.set(row.id, ac);
    this.track(this.run(row, members, root, ac.signal).finally(() => this.running.delete(row.id)));
    return this.view(row);
  }

  private async run(row: TrialRow, members: WorktreeSession[], root: string, signal: AbortSignal): Promise<void> {
    const save = () => {
      this.trials.save(row);
      this.emit(row);
    };
    try {
      let current = row.head;
      for (let i = 0; i < members.length; i++) {
        if (signal.aborted) throw new Cancelled();
        const s = members[i]!;
        const step = row.steps[i]!;
        const commit = await snapshot(s.worktreePath, null, 'ADE integrate');
        row.members[i]!.tree = (await git(['rev-parse', `${commit}^{tree}`], { cwd: root })).trim();
        step.changed = [...new Set((await changedFiles(root, s.baseCommit, commit)).flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])))].sort();
        const { tree, conflicts } = await IntegrateService.merge(root, s.baseCommit, current, commit);
        if (conflicts.length) {
          step.status = 'conflicts';
          step.conflicts = conflicts.sort();
          for (const later of row.steps.slice(i + 1)) later.status = 'skipped';
          row.status = 'conflicts';
          save();
          return;
        }
        current = (await git(['commit-tree', tree, '-p', current, '-m', `ADE integrate ${i + 1}: ${s.title}`], { cwd: root, env: CHECKPOINT_IDENTITY })).trim();
        await git(['update-ref', `${integrateRefPrefix(row.id)}${i + 1}`, current], { cwd: root });
        step.status = 'fits';
        step.commit = current;
        save();
      }
      const { configIds } = this.deps.checks.settings(row.workspaceId);
      const configs = this.deps.repos.runs.configs(row.workspaceId).filter((c) => configIds.includes(c.id));
      if (!row.runChecks || !configs.length) {
        row.status = 'fits';
        save();
        return;
      }
      row.status = 'checking';
      save();
      row.checks = await this.combinedChecks(row, members, root, current, configs, signal);
      row.status = row.checks.every((c) => c.verdict === 'passes') ? 'passed' : 'failed';
      save();
    } catch (err) {
      row.status = err instanceof Cancelled || signal.aborted ? 'cancelled' : 'error';
      row.error = row.status === 'cancelled' ? null : (err as Error).message.slice(0, 2000);
      save();
    }
  }

  /** CN-02 setup, then each check (RV-10) in a temporary detached worktree of the final trial commit. */
  private async combinedChecks(
    row: TrialRow,
    members: WorktreeSession[],
    root: string,
    commit: string,
    configs: { id: string; name: string; command: string[]; cwd: string }[],
    signal: AbortSignal,
  ): Promise<IntegrateCheck[]> {
    const path = join(this.deps.tmpRoot, row.id.slice(0, 8));
    await git(['worktree', 'add', '--detach', path, commit], { cwd: root });
    try {
      // The combined checks borrow the first member's sandbox, so they are contained exactly when it is.
      const first = members[0]!;
      const wrapper = first.containment !== 'none' ? ((await this.deps.sandbox()?.wrapperFor({ ...first, worktreePath: path }, root)) ?? null) : null;
      row.sandboxed = !!wrapper;
      const { config, error, exists } = await readWorkspaceConfig(root);
      if (error) throw new Error(`.ade/workspace.yaml is invalid: ${error}`);
      if (exists) {
        if (config.copy.length) await copyFiles(root, path, config.copy);
        for (const raw of config.setup) {
          const argv = toArgv(raw);
          if (!argv.length) continue;
          const res = await runArgv(argv, { cwd: path, resolve: this.deps.resolveCommand, wrapper, signal: AbortSignal.any([signal, AbortSignal.timeout(config.setupTimeoutSeconds * 1000)]) });
          if (signal.aborted) throw new Cancelled();
          if (!res || res.code !== 0) throw new Error(`Setup command failed: ${argv.join(' ')}${res ? `\n${res.output.slice(-2000)}` : ' was not found on the PATH.'}`);
        }
      }
      const out: IntegrateCheck[] = [];
      for (const c of configs) {
        if (signal.aborted) throw new Cancelled();
        const rel = isAbsolute(c.cwd) ? relative(root, c.cwd) : c.cwd;
        const cwd = rel && !rel.startsWith('..') ? join(path, rel) : path;
        const startedAt = new Date().toISOString();
        const res = (await runArgv(c.command, { cwd, resolve: this.deps.resolveCommand, wrapper, signal })) ?? { code: null, output: `${c.command[0]} was not found on the PATH.` };
        if (signal.aborted) throw new Cancelled();
        const run = this.deps.repos.runs.record(
          { runConfigId: c.id, sessionId: null, worktreePath: path, command: c.command, startedAt, endedAt: new Date().toISOString(), exitCode: res.code, output: res.output },
          row.workspaceId,
        );
        const alone = members.map((s) => ({ sessionId: s.id, result: this.trials.lastRun(s.id, c.id) }));
        out.push({
          configId: c.id,
          name: c.name,
          exitCode: res.code,
          verdict: checkVerdict(res.code, alone.map((a) => a.result)),
          alone,
          output: res.output.slice(-OUTPUT_TAIL),
          runId: run.id,
        });
      }
      return out;
    } finally {
      await git(['worktree', 'remove', '--force', path], { cwd: root }).catch(async () => {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        await git(['worktree', 'prune'], { cwd: root }).catch(() => undefined);
      });
    }
  }

  // ------------------------------------------------------------------ reading

  private async outOfDate(row: TrialRow): Promise<string | null> {
    if (row.status === 'running' || row.status === 'checking' || row.status === 'landed' || row.status === 'cancelled') return null;
    const head = await revParse(this.root(row.workspaceId), 'HEAD').catch(() => '');
    const members: Record<string, { checkpoint: string | null; ended: boolean; title: string } | undefined> = {};
    for (const id of row.order) {
      const s = this.deps.repos.sessions.get(id);
      if (s) members[id] = { checkpoint: this.mark(s), ended: isTerminal(s.state), title: s.title };
    }
    return staleness(row, { head, members });
  }

  private async view(row: TrialRow): Promise<IntegrateTrial> {
    const { members: _m, ...rest } = row;
    return { ...rest, outOfDate: await this.outOfDate(row) };
  }

  private require(trialId: string): TrialRow {
    const row = this.trials.get(trialId);
    if (!row) throw new RpcError('not_found', 'That trial no longer exists. Try again.');
    return row;
  }

  async get(trialId: string): Promise<IntegrateTrial> {
    return this.view(this.require(trialId));
  }

  async current(workspaceId: string): Promise<IntegrateTrial | null> {
    this.root(workspaceId);
    const row = this.trials.latest(workspaceId);
    return row ? this.view(row) : null;
  }

  /** Stops a running trial, then deletes it and its refs. */
  async cancel(trialId: string): Promise<void> {
    const row = this.trials.get(trialId);
    if (!row) return;
    const ac = this.running.get(trialId);
    if (ac) {
      ac.abort();
      await Promise.all([...this.pending]);
    }
    await this.remove(row);
    this.emit(row);
  }

  private async dropRefs(row: TrialRow) {
    await deleteRefs(this.root(row.workspaceId), integrateRefPrefix(row.id)).catch(() => undefined);
  }

  private async remove(row: TrialRow) {
    await this.dropRefs(row);
    this.trials.delete(row.id);
  }

  // ------------------------------------------------------------------ resolve

  /** The commit a member adapts onto (the trial commit before it), and the briefing it gets. */
  private resolveTarget(row: TrialRow, sessionId: string) {
    const idx = row.order.indexOf(sessionId);
    if (idx < 0) throw new RpcError('not_found', 'That session is not part of this trial.');
    const step = row.steps[idx]!;
    const failedTogether = row.status === 'failed' && step.status === 'fits';
    if (step.status !== 'conflicts' && !failedTogether) throw new RpcError('invalid', 'Only a conflicting session, or one whose combined checks fail, can be asked to adapt.');
    const onto = idx === 0 ? row.head : row.steps[idx - 1]!.commit;
    if (!onto) throw new RpcError('invalid', 'The sessions before this one have not been merged yet.');
    const before = row.order.slice(0, idx).map((id, j) => {
      const s = this.deps.repos.sessions.get(id);
      const lastMessage = this.deps.repos.events
        .listOfTypes(id, ['agent.message'])
        .flatMap((e) => (e.type === 'agent.message' ? [e.text] : []))
        .pop();
      return { title: s?.title ?? 'A session', files: row.steps[j]!.changed, lastMessage: lastMessage ?? null };
    });
    const prompt = briefing({
      order: row.steps.map((s) => s.title),
      position: idx,
      before,
      onto,
      conflicts: step.status === 'conflicts' ? step.conflicts : [],
      failed: step.status === 'conflicts' ? [] : row.checks.filter((c) => c.verdict !== 'passes').map((c) => ({ name: c.name, output: c.output })),
    });
    return { onto, prompt, conflicts: step.conflicts };
  }

  async resolvePrompt(trialId: string, sessionId: string): Promise<{ prompt: string; onto: string }> {
    const { prompt, onto } = this.resolveTarget(this.require(trialId), sessionId);
    return { prompt, onto };
  }

  /**
   * Moves the session onto the trial commit before it, the way RV-11 moves a session onto the checkout: the branch
   * and index go to that commit and the files become the merge result, with conflict markers where they clash.
   * Then the (user-edited) briefing is sent. Only the session's own worktree changes.
   */
  async resolve(trialId: string, sessionId: string, prompt: string): Promise<void> {
    const row = this.require(trialId);
    const stale = await this.outOfDate(row);
    if (stale) throw new RpcError('out_of_date', `This trial is out of date: ${stale} Try again first.`);
    const { onto } = this.resolveTarget(row, sessionId);
    const s = this.deps.repos.sessions.require(sessionId);
    if (!IntegrateService.worktreeSession(s)) throw new RpcError('session_ended', 'This session has ended.');
    if (this.deps.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish or cancel it first.');
    const snap = await snapshot(s.worktreePath, null, 'ADE integrate resolve');
    const { tree, conflicts } = await IntegrateService.merge(s.worktreePath, s.baseCommit, onto, snap);
    const merged = (await git(['commit-tree', tree, '-p', onto, '-m', 'ADE integrate resolve'], { cwd: s.worktreePath, env: CHECKPOINT_IDENTITY })).trim();
    await git(['reset', '-q', '--mixed', onto], { cwd: s.worktreePath });
    await restoreSnapshot(s.worktreePath, merged);
    this.deps.repos.sessions.update(sessionId, { baseCommit: onto });
    this.deps.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'integration.resolve', detail: { trialId, from: s.baseCommit, onto, conflicts } });
    this.deps.sessions.record(sessionId, {
      type: 'notice',
      level: conflicts.length ? 'warning' : 'info',
      text: conflicts.length
        ? `Integrate: moved onto ${onto.slice(0, 7)}, after the sessions that land before this one. These files have conflict markers: ${conflicts.join(', ')}.`
        : `Integrate: moved onto ${onto.slice(0, 7)}, after the sessions that land before this one, without conflicts.`,
    });
    await this.deps.sessions.prompt(sessionId, [{ type: 'text', text: prompt }]);
    this.emit(row);
  }

  // ------------------------------------------------------------------ land

  private async landFiles(sessionId: string): Promise<string[]> {
    const changes = await this.deps.review.changes(sessionId, null);
    return [...new Set(changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])))];
  }

  async landPreview(trialId: string): Promise<IntegrateLandItem[]> {
    const row = this.require(trialId);
    const out: IntegrateLandItem[] = [];
    for (const id of row.order) {
      if (row.landed.includes(id)) continue;
      const s = this.deps.repos.sessions.require(id);
      const files = await this.landFiles(id).catch(() => []);
      const unreviewed = await this.deps.review
        .progress(id)
        .then((p) => unreviewedAmong(p, files))
        .catch(() => files);
      let receiptItems: string[] = [];
      try {
        receiptItems = this.deps.receiptItems(id);
      } catch {
        receiptItems = [];
      }
      out.push({ sessionId: id, title: s.title, files, unreviewed, receiptItems });
    }
    return out;
  }

  /**
   * Nothing lands without this call, made from the confirmation. Each session is applied to the checkout in order
   * with the normal land (RV-07, uncommitted); the first failure stops the rest.
   */
  async land(trialId: string): Promise<IntegrateLandResult> {
    const row = this.require(trialId);
    if (this.running.has(trialId)) throw new RpcError('busy', 'The trial is still running.');
    if (!['fits', 'passed', 'failed'].includes(row.status)) throw new RpcError('invalid', 'Only a trial where every session fits can be landed in order.');
    const stale = await this.outOfDate(row);
    if (stale) throw new RpcError('out_of_date', `This trial is out of date: ${stale} Try again first.`);
    // Files edited since the trial (by the user, between turns) also make it out of date.
    for (const m of row.members) {
      if (row.landed.includes(m.sessionId)) continue;
      const s = this.deps.repos.sessions.require(m.sessionId);
      const tree = s.worktreePath ? (await git(['rev-parse', `${await snapshot(s.worktreePath, null, 'ADE integrate check')}^{tree}`], { cwd: s.worktreePath })).trim() : null;
      if (tree !== m.tree) throw new RpcError('out_of_date', `This trial is out of date: "${s.title}" changed since the trial. Try again first.`);
    }
    const landed: string[] = [];
    let failed: IntegrateLandResult['failed'] = null;
    for (let i = 0; i < row.order.length; i++) {
      const id = row.order[i]!;
      if (row.landed.includes(id)) continue;
      try {
        const files = await this.landFiles(id);
        if (files.length) await this.deps.review.land(id, 'apply', files);
        landed.push(id);
        row.landed.push(id);
        this.deps.repos.audit.append({ workspaceId: row.workspaceId, sessionId: id, actor: 'user', action: 'integration.landed', detail: { trialId, position: i + 1, files } });
        this.trials.save(row);
      } catch (err) {
        failed = { sessionId: id, message: (err as Error).message.slice(0, 2000) };
        this.deps.repos.audit.append({ workspaceId: row.workspaceId, sessionId: id, actor: 'user', action: 'integration.landed', detail: { trialId, position: i + 1, failed: failed.message } });
        break;
      }
    }
    const notLanded = row.order.filter((id) => !row.landed.includes(id));
    if (!notLanded.length) {
      row.status = 'landed';
      await this.dropRefs(row);
    }
    this.trials.save(row);
    this.emit(row);
    return { landed, failed, notLanded };
  }

  /** Trials that were running when ADE quit are marked cancelled; their temporary worktrees are pruned. */
  async recover(): Promise<void> {
    for (const row of this.trials.list()) {
      if (row.status !== 'running' && row.status !== 'checking') continue;
      row.status = 'cancelled';
      row.error = 'ADE closed while the trial ran.';
      this.trials.save(row);
      await rm(join(this.deps.tmpRoot, row.id.slice(0, 8)), { recursive: true, force: true }).catch(() => undefined);
      const ws = this.deps.repos.workspaces.get(row.workspaceId);
      if (ws) await git(['worktree', 'prune'], { cwd: ws.rootPath }).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    this.off();
    for (const ac of this.running.values()) ac.abort();
    await Promise.all([...this.pending]);
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RpcError, type DiffText, type FileChange, type Session } from '@ade/contracts';
import { mkdir, writeFile } from 'node:fs/promises';
import { applyToCheckout, changedFiles, commitFiles, deleteRefs, diffPatch, discardWorktree, fileAt, git, looksBinary, restoreFiles, restoreSnapshot, snapshot } from '@ade/git';
import type { Repositories } from './repositories.ts';
import { snapshotRefName, type HostPaths, type SessionService } from './session-service.ts';

const PATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Changes view, per-turn diffs, undo, land and discard (RV-01 to RV-08). Git computes every diff. */
export class ReviewService {
  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
    private readonly paths: HostPaths,
  ) {}

  private requireWorktree(sessionId: string): Session & { worktreePath: string; baseCommit: string } {
    const s = this.repos.sessions.require(sessionId);
    if (!s.worktreePath || !s.baseCommit) throw new RpcError('no_worktree', 'This session has no worktree.');
    if (s.state === 'landed' || s.state === 'discarded') throw new RpcError('session_ended', 'This session has ended.');
    return s as Session & { worktreePath: string; baseCommit: string };
  }

  /** Commit range for "all turns" (base to now) or for one turn (its start to its end checkpoint). */
  private async range(sessionId: string, turnIndex: number | null): Promise<{ from: string; to: string; worktree: string }> {
    const s = this.requireWorktree(sessionId);
    if (turnIndex === null) return { from: s.baseCommit, to: await snapshot(s.worktreePath, null, 'ADE review', s.inPlace), worktree: s.worktreePath };
    const turn = this.repos.turns.byIndex(sessionId, turnIndex);
    if (!turn?.startCheckpoint) throw new RpcError('no_checkpoint', 'That turn has no checkpoint.');
    const to = turn.endCheckpoint ?? (await snapshot(s.worktreePath, null, 'ADE review', s.inPlace));
    return { from: turn.startCheckpoint, to, worktree: s.worktreePath };
  }

  async changes(sessionId: string, turnIndex: number | null): Promise<FileChange[]> {
    const { from, to, worktree } = await this.range(sessionId, turnIndex);
    const userEdits = new Set(this.repos.audit.forSession(sessionId, 'user.edit').map((e) => String(e.detail.path)));
    return (await changedFiles(worktree, from, to)).map((c) => ({ ...c, editedByUser: userEdits.has(c.path) }));
  }

  async diff(sessionId: string, path: string, turnIndex: number | null): Promise<DiffText> {
    const { from, to, worktree } = await this.range(sessionId, turnIndex);
    const changes = await changedFiles(worktree, from, to);
    const oldPath = changes.find((c) => c.path === path)?.oldPath ?? path;
    const [oldBuf, newBuf] = await Promise.all([fileAt(worktree, from, oldPath), fileAt(worktree, to, path)]);
    const binary = looksBinary(oldBuf) || looksBinary(newBuf);
    return { path, oldText: binary ? '' : (oldBuf?.toString('utf8') ?? ''), newText: binary ? '' : (newBuf?.toString('utf8') ?? ''), binary };
  }

  /** RV-04: restore the worktree to the state before `turnIndex` started. */
  async undoTurn(sessionId: string, turnIndex: number): Promise<void> {
    const s = this.requireWorktree(sessionId);
    if (this.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish or cancel it first.');
    const turn = this.repos.turns.byIndex(sessionId, turnIndex);
    if (!turn?.startCheckpoint) throw new RpcError('no_checkpoint', 'That turn has no checkpoint.');
    await restoreSnapshot(s.worktreePath, turn.startCheckpoint, s.inPlace);
    this.sessions.record(sessionId, { type: 'notice', level: 'info', text: `Undid turn ${turnIndex + 1} and every change after it.` });
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'turn.undone', detail: { turnIndex, checkpoint: turn.startCheckpoint } });
  }

  /**
   * RV-07: nothing lands without this explicit call. `base` lets a workflow land everything since the run
   * started (its sessions chain from one another's checkpoints) instead of only the last session's part.
   */
  async land(sessionId: string, mode: 'apply' | 'commit', files: string[], message?: string, base?: string): Promise<void> {
    const s = this.requireWorktree(sessionId);
    if (this.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish before landing.');
    if (s.inPlace) return this.keepInPlace(s, mode, files);
    const workspace = this.repos.workspaces.get(s.workspaceId)!;
    const from = base ?? s.baseCommit;
    if (mode === 'apply') {
      const head = await snapshot(s.worktreePath, null, 'ADE land');
      const how = await applyToCheckout(s.worktreePath, workspace.rootPath, from, head, files);
      await this.recordLanding(sessionId, 'apply', files, { how }, 'apply');
    } else {
      const { commit } = await this.commitForLanding(sessionId, files, message, base);
      await this.recordLanding(sessionId, 'commit', files, { commit, branch: s.branch }, 'commit');
    }
  }

  /**
   * Commits the selected files on the session branch, as one commit on top of `base` (a workflow run's base)
   * so checkpoint commits never reach the branch history. Does not end the session.
   */
  async commitForLanding(sessionId: string, files: string[], message?: string, base?: string): Promise<{ commit: string }> {
    const s = this.requireWorktree(sessionId);
    if (this.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish before landing.');
    if (s.inPlace) throw new RpcError('in_place', 'A session in your checkout keeps its changes where they are; commit them yourself.');
    if (base && base !== s.baseCommit) await git(['reset', '--soft', base], { cwd: s.worktreePath });
    return { commit: await commitFiles(s.worktreePath, files, message?.trim() || s.title) };
  }

  /** Records a land in the audit log and the timeline, then ends the session. */
  async recordLanding(sessionId: string, mode: 'apply' | 'commit', files: string[], detail: Record<string, unknown>, action: string): Promise<void> {
    const s = this.repos.sessions.require(sessionId);
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: `session.land.${action}`, detail: { files, ...detail, agent: s.agentId } });
    this.sessions.record(sessionId, { type: 'session.landed', mode, files });
    await this.sessions.finish(sessionId, 'land');
  }

  /**
   * CN-08: the changes are already in the checkout. Landing keeps the selected files and puts every other
   * changed file back to the snapshot. Committing is left to the user, because the checkout may hold their
   * own uncommitted work too.
   */
  private async keepInPlace(s: Session & { worktreePath: string; baseCommit: string }, mode: 'apply' | 'commit', files: string[]): Promise<void> {
    if (mode === 'commit') {
      throw new RpcError('in_place', 'A session in your checkout keeps its changes where they are. Choose "Keep changes" and commit them yourself.');
    }
    const now = await snapshot(s.worktreePath, null, 'ADE land in place', true);
    const changed = (await changedFiles(s.worktreePath, s.baseCommit, now)).flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]));
    const keep = new Set(files);
    const reverted = changed.filter((f) => !keep.has(f));
    await restoreFiles(s.worktreePath, s.baseCommit, reverted);
    await this.dropSessionRefs(s);
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId: s.id, actor: 'user', action: 'session.land.keep', detail: { files, reverted, agent: s.agentId } });
    this.sessions.record(s.id, { type: 'session.landed', mode: 'apply', files });
    await this.sessions.finish(s.id, 'land');
  }

  private async dropSessionRefs(s: Session) {
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    await deleteRefs(root, `refs/ade/checkpoints/${s.id}/`);
    await git(['update-ref', '-d', snapshotRefName(s.id)], { cwd: root }).catch(() => undefined);
  }

  /** RV-08: remove worktree and branch; the final patch is kept for 30 days. */
  async discard(sessionId: string): Promise<string | null> {
    const s = this.repos.sessions.require(sessionId);
    await this.sessions.stopAgent(sessionId);
    let patchPath: string | null = null;
    if (s.inPlace && s.worktreePath && s.baseCommit) {
      // CN-08: never remove the checkout. Keep the patch, then put every file back to the snapshot.
      const final = await snapshot(s.worktreePath, null, 'ADE final', true);
      patchPath = join(this.paths.patches, `${sessionId}.patch`);
      await mkdir(this.paths.patches, { recursive: true });
      await writeFile(patchPath, await diffPatch(s.worktreePath, s.baseCommit, final));
      await restoreSnapshot(s.worktreePath, s.baseCommit, true);
      await this.dropSessionRefs(s);
    } else if (s.worktreePath && s.baseCommit) {
      const workspace = this.repos.workspaces.get(s.workspaceId)!;
      patchPath = await discardWorktree({
        repo: workspace.rootPath,
        worktree: s.worktreePath,
        branch: s.branch,
        baseCommit: s.baseCommit,
        sessionId,
        patchPath: join(this.paths.patches, `${sessionId}.patch`),
      });
    }
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'session.discarded', detail: { patchPath } });
    this.sessions.record(sessionId, { type: 'session.discarded', patchPath });
    await this.sessions.finish(sessionId, 'discard');
    return patchPath;
  }

  /** Deletes discarded-session patches older than 30 days. */
  async prunePatches(nowMs = Date.now()): Promise<number> {
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = await readdir(this.paths.patches);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const p = join(this.paths.patches, name);
      const info = await stat(p).catch(() => null);
      if (info && nowMs - info.mtimeMs > PATCH_RETENTION_MS) {
        await rm(p, { force: true });
        removed++;
      }
    }
    return removed;
  }
}

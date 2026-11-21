import { RpcError, type BaseStatus, type Session } from '@ade/contracts';
import { CHECKPOINT_IDENTITY, currentBranch, git, restoreSnapshot, revParse, snapshot } from '@ade/git';
import type { Repositories } from './repositories.ts';
import type { SessionService } from './session-service.ts';

/** RV-11: keeping a session's branch on top of the checkout. */
export class BranchService {
  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
  ) {}

  private worktreeSession(sessionId: string): Session & { worktreePath: string; baseCommit: string } {
    const s = this.repos.sessions.require(sessionId);
    if (!s.worktreePath || !s.baseCommit || s.state === 'landed' || s.state === 'discarded') throw new RpcError('session_ended', 'This session has ended.');
    if (s.inPlace) throw new RpcError('in_place', 'A session in your checkout is already on your current files.');
    return s as Session & { worktreePath: string; baseCommit: string };
  }

  /** Three-way merge of the session's changes onto `head`, without touching any worktree. */
  private async merge(s: Session & { worktreePath: string; baseCommit: string }, head: string) {
    const snap = await snapshot(s.worktreePath, null, 'ADE base check');
    // Exit 1 means conflicts: the first line is the merged tree (with conflict markers), then the conflicted paths.
    const out = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${s.baseCommit}`, head, snap], { cwd: s.worktreePath, okCodes: [1] });
    const [tree = '', ...conflicts] = out.split(/\r?\n/).filter(Boolean);
    return { tree, conflicts };
  }

  /** RV-11: commits the checkout moved past the session's base, and which files would conflict. */
  async baseStatus(sessionId: string): Promise<BaseStatus> {
    const s = this.worktreeSession(sessionId);
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    const head = await revParse(root, 'HEAD');
    const branch = await currentBranch(root);
    if (head === s.baseCommit) return { base: s.baseCommit, head, branch, behind: 0, conflicts: [] };
    const behind = Number((await git(['rev-list', '--count', `${s.baseCommit}..${head}`], { cwd: root })).trim()) || 0;
    const { conflicts } = await this.merge(s, head);
    return { base: s.baseCommit, head, branch, behind, conflicts };
  }

  /**
   * RV-11: moves the session onto the checkout's current commit. The worktree gets the merged files; files
   * that conflict keep Git's conflict markers, and with `askAgent` the agent is asked to resolve them.
   */
  async rebase(sessionId: string, askAgent: boolean): Promise<BaseStatus> {
    const s = this.worktreeSession(sessionId);
    if (this.sessions.hasActiveTurn(sessionId)) throw new RpcError('busy', 'Wait for the turn to finish or cancel it first.');
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    const head = await revParse(root, 'HEAD');
    if (head === s.baseCommit) return this.baseStatus(sessionId);
    const { tree, conflicts } = await this.merge(s, head);
    const merged = (await git(['commit-tree', tree, '-p', head, '-m', 'ADE rebase'], { cwd: s.worktreePath, env: CHECKPOINT_IDENTITY })).trim();
    // The branch and index move to the new base; the files become the merge result, uncommitted as before.
    await git(['reset', '-q', '--mixed', head], { cwd: s.worktreePath });
    await restoreSnapshot(s.worktreePath, merged);
    this.repos.sessions.update(sessionId, { baseCommit: head });
    this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'session.rebased', detail: { from: s.baseCommit, to: head, conflicts } });
    this.sessions.record(sessionId, {
      type: 'notice',
      level: conflicts.length ? 'warning' : 'info',
      text: conflicts.length
        ? `Moved onto ${head.slice(0, 7)}. These files have conflict markers: ${conflicts.join(', ')}.`
        : `Moved onto ${head.slice(0, 7)} without conflicts.`,
    });
    if (conflicts.length && askAgent) {
      await this.sessions.prompt(sessionId, [
        {
          type: 'text',
          text: `The base branch moved and your changes were merged onto it. These files now contain Git conflict markers (<<<<<<<, =======, >>>>>>>): ${conflicts.join(', ')}. Resolve every conflict so both the new base and your change work, remove the markers, and say what you decided.`,
        },
      ]);
    }
    return { base: head, head, branch: await currentBranch(root), behind: 0, conflicts };
  }
}

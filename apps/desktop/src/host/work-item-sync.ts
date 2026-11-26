import type { Board, BoardSettings, Session, SyncSettings } from '@ade/contracts';
import type { CredentialCache, Runner } from './connectors.ts';
import type { Repositories } from './repositories.ts';
import type { ShortcutActions } from './shortcut-actions.ts';
import type { SessionService } from './session-service.ts';

export const DEFAULT_SYNC: SyncSettings = { moveOnStart: null, moveOnPullRequest: null, moveOnMerge: null, progressNotes: false, closeIssues: false };
export const DEFAULT_BOARD: BoardSettings = { source: 'shortcut', githubRepo: null, githubOwner: null, githubProject: null };

/** `sc-123` -> 123. Pure. */
export const shortcutId = (ref: string | null): number | null => {
  const m = ref ? /^sc-(\d+)$/.exec(ref) : null;
  return m ? Number(m[1]) : null;
};

/** `owner/repo#12` -> its parts. Pure. */
export const githubIssue = (ref: string | null): { repo: string; number: number } | null => {
  const m = ref ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref) : null;
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
};

export type LandedAction = 'apply' | 'commit' | 'keep' | 'merged' | string;

/**
 * CO-05 and CO-08: keeps a session's work item in step with it, only as far as the workspace opted in. A failed
 * update never fails the session; it shows as a warning in the timeline.
 */
export class WorkItemSync {
  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
    private readonly shortcut: () => ShortcutActions | null,
    private readonly creds: CredentialCache,
    private readonly run: Runner,
    private readonly gh: string | null,
  ) {}

  settings(workspaceId: string): SyncSettings {
    return { ...DEFAULT_SYNC, ...this.repos.settings.get<Partial<SyncSettings>>(`sync.${workspaceId}`, {}) };
  }

  save(workspaceId: string, s: SyncSettings) {
    this.repos.settings.set(`sync.${workspaceId}`, s);
  }

  private async attempt(session: Session, what: string, work: () => Promise<void>) {
    try {
      await work();
      this.sessions.record(session.id, { type: 'notice', level: 'info', text: `${session.workItemRef}: ${what}.` });
      this.repos.audit.append({ workspaceId: session.workspaceId, sessionId: session.id, actor: 'ade', action: 'work_item.synced', detail: { ref: session.workItemRef, what } });
    } catch (err) {
      this.sessions.record(session.id, { type: 'notice', level: 'warning', text: `${session.workItemRef}: could not ${what.toLowerCase()} (${(err as Error).message.slice(0, 300)}).` });
    }
  }

  private async ghComment(issue: { repo: string; number: number }, body: string) {
    if (!this.gh) throw new Error('the GitHub CLI is not installed');
    const token = this.creds.get('github');
    const res = await this.run(this.gh, ['issue', 'comment', String(issue.number), '--repo', issue.repo, '--body', body], {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      ...(token ? { GH_TOKEN: token } : {}),
    });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'gh issue comment failed');
  }

  private async note(session: Session, text: string) {
    const story = shortcutId(session.workItemRef);
    const issue = githubIssue(session.workItemRef);
    const sc = this.shortcut();
    if (story !== null && sc) await this.attempt(session, 'Posted a progress note', () => sc.comment(story, text));
    else if (issue) await this.attempt(session, 'Posted a progress note', () => this.ghComment(issue, text));
  }

  private async move(session: Session, stateId: number | null, label: string, link?: string) {
    const story = shortcutId(session.workItemRef);
    const sc = this.shortcut();
    if (stateId === null || story === null || !sc) return;
    await this.attempt(session, `Moved to the "${label}" state`, () => sc.moveStory(story, stateId, link));
  }

  private summary(session: Session) {
    const last = this.repos.events.list(session.id).flatMap((e) => (e.type === 'agent.message' ? [e.text] : [])).at(-1) ?? '';
    return last.length > 1500 ? `${last.slice(0, 1500)}…` : last;
  }

  /** Text added to a pull request body for the work item (GitHub closes the issue on merge). Pure for a session. */
  pullRequestBodyExtra(session: Session): string {
    const issue = githubIssue(session.workItemRef);
    return issue && this.settings(session.workspaceId).closeIssues ? `\n\nCloses ${issue.repo}#${issue.number}` : '';
  }

  async onSessionCreated(session: Session) {
    if (!session.workItemRef) return;
    await this.move(session, this.settings(session.workspaceId).moveOnStart, 'started');
  }

  async onPullRequest(session: Session, url: string) {
    if (!session.workItemRef) return;
    const s = this.settings(session.workspaceId);
    await this.move(session, s.moveOnPullRequest, 'pull request', url);
    if (s.progressNotes) await this.note(session, [`ADE opened a pull request: ${url}`, this.summary(session)].filter(Boolean).join('\n\n'));
  }

  async onLanded(session: Session, action: LandedAction, detail: Record<string, unknown>) {
    if (!session.workItemRef) return;
    const s = this.settings(session.workspaceId);
    if (action === 'merged') {
      await this.move(session, s.moveOnMerge, 'merged');
      if (s.progressNotes) await this.note(session, `The pull request was merged: ${String(detail.pullRequest ?? '')}`);
      return;
    }
    if (!s.progressNotes) return;
    const how = action === 'apply' ? 'applied to the checkout' : action === 'keep' ? 'kept in the checkout' : `committed on ${String(detail.branch ?? 'the session branch')}`;
    await this.note(session, [`ADE landed the session "${session.title}" (${how}).`, this.summary(session)].filter(Boolean).join('\n\n'));
  }

  /** A workflow connector step (see `ConnectorExecutor`). Returns what it did, in words. */
  async runAction(connector: 'shortcut' | 'github', action: string, ref: string, text: string): Promise<string> {
    if (connector === 'shortcut') {
      const story = shortcutId(ref);
      const sc = this.shortcut();
      if (story === null) throw new Error(`${ref} is not a Shortcut story.`);
      if (!sc) throw new Error('Shortcut is not connected.');
      if (action === 'comment') {
        await sc.comment(story, text);
        return `Commented on ${ref}.`;
      }
      const move = /^move:(\d+)$/.exec(action);
      if (move) {
        await sc.moveStory(story, Number(move[1]));
        return `Moved ${ref} to workflow state ${move[1]}.`;
      }
      throw new Error('Shortcut steps support "comment" and "move:<workflow state id>".');
    }
    const issue = githubIssue(ref);
    if (!issue) throw new Error(`${ref} is not a GitHub issue.`);
    if (action !== 'comment') throw new Error('GitHub steps support "comment".');
    await this.ghComment(issue, text);
    return `Commented on ${ref}.`;
  }

  // ---------------------------------------------------------------- CO-09 board

  boardSettings(workspaceId: string): BoardSettings {
    return { ...DEFAULT_BOARD, ...this.repos.settings.get<Partial<BoardSettings>>(`board.${workspaceId}`, {}) };
  }

  saveBoard(workspaceId: string, s: BoardSettings) {
    this.repos.settings.set(`board.${workspaceId}`, s);
  }

  async board(workspaceId: string): Promise<Board> {
    const settings = this.boardSettings(workspaceId);
    const sessions = this.repos.sessions.list(workspaceId).filter((s) => s.workItemRef);
    const badges = (ref: string) => sessions.filter((s) => s.workItemRef === ref).map((s) => ({ id: s.id, title: s.title, state: s.state }));
    const columns = new Map<string, Board['columns'][number]['items']>();
    const add = (column: string, item: Omit<Board['columns'][number]['items'][number], 'sessions'>) =>
      columns.set(column, [...(columns.get(column) ?? []), { ...item, sessions: badges(item.ref) }]);

    if (settings.source === 'shortcut') {
      const sc = this.shortcut();
      if (!sc) throw new Error('Connect Shortcut in Settings first.');
      const iteration = await sc.currentIteration();
      if (!iteration) return { title: 'No current Shortcut iteration', columns: [] };
      const [states, stories] = await Promise.all([sc.workflowStates().catch(() => []), sc.iterationStories(iteration.id)]);
      const byId = new Map(states.map((s) => [s.id, s]));
      // Columns in workflow order, then any state names the server returned that are not in the list.
      for (const s of [...states].sort((a, b) => a.position - b.position)) columns.set(s.name, []);
      for (const story of stories) {
        const name = typeof story.state === 'number' ? (byId.get(story.state)?.name ?? `State ${story.state}`) : (story.state ?? 'No state');
        add(name, { ref: `sc-${story.id}`, title: story.name, url: story.url });
      }
      return { title: iteration.name, columns: [...columns].filter(([, items]) => items.length).map(([name, items]) => ({ name, items })) };
    }

    if (!this.gh) throw new Error('The GitHub CLI (gh) is not installed.');
    const repo = settings.githubRepo;
    if (!repo) throw new Error('Choose a repository first.');
    if (settings.githubOwner && settings.githubProject) {
      // `gh project item-list <number> --owner <login> --format json` (flags from `gh project item-list --help`).
      const res = await this.ghOut(['project', 'item-list', String(settings.githubProject), '--owner', settings.githubOwner, '--format', 'json', '--limit', '200']);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'gh could not read the project. It needs the "project" scope: gh auth refresh -s project.');
      // A project can span repositories; the board shows the chosen repository's items only.
      for (const item of parseProjectItems(res.stdout).filter((i) => i.ref.startsWith(`${repo}#`))) add(item.status, { ref: item.ref, title: item.title, url: item.url });
      return { title: `${repo} · ${settings.githubOwner} project ${settings.githubProject}`, columns: [...columns].map(([name, items]) => ({ name, items })) };
    }
    // No project: the open issues and pull requests of the repository.
    const fields = ['--state', 'open', '--limit', '100', '--json', 'number,title,url'];
    const [issues, prs] = await Promise.all([this.ghOut(['issue', 'list', '-R', repo, ...fields]), this.ghOut(['pr', 'list', '-R', repo, ...fields])]);
    if (issues.code !== 0) throw new Error(issues.stderr.trim() || `gh could not read ${repo}.`);
    const parse = (out: string) => {
      try {
        return JSON.parse(out || '[]') as { number: number; title: string; url: string }[];
      } catch {
        return [];
      }
    };
    columns.set('Open issues', []);
    columns.set('Open pull requests', []);
    for (const i of parse(issues.stdout)) add('Open issues', { ref: `${repo}#${i.number}`, title: i.title, url: i.url });
    if (prs.code === 0) for (const p of parse(prs.stdout)) add('Open pull requests', { ref: `${repo}#${p.number}`, title: p.title, url: p.url });
    return { title: repo, columns: [...columns].map(([name, items]) => ({ name, items })) };
  }

  private ghOut(args: string[], cwd?: string) {
    const token = this.creds.get('github');
    return this.run(this.gh!, args, { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token } : {}) }, cwd);
  }

  /** CO-09: the GitHub repository of this workspace (from its remote), then the repositories of the user. */
  async boardRepositories(root: string): Promise<{ current: string | null; repos: string[] }> {
    if (!this.gh) throw new Error('The GitHub CLI (gh) is not installed.');
    const [here, mine] = await Promise.all([this.ghOut(['repo', 'view', '--json', 'nameWithOwner'], root), this.ghOut(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner'])]);
    const read = (out: string): unknown => {
      try {
        return JSON.parse(out);
      } catch {
        return null;
      }
    };
    const current = here.code === 0 ? ((read(here.stdout) as { nameWithOwner?: string } | null)?.nameWithOwner ?? null) : null;
    const list = mine.code === 0 ? ((read(mine.stdout) as { nameWithOwner?: string }[] | null) ?? []).map((r) => r.nameWithOwner).filter((r): r is string => !!r) : [];
    return { current, repos: [...new Set([...(current ? [current] : []), ...list])] };
  }

  /** CO-09: projects linked to a repository, from `gh repo view --json projectsV2`. */
  async boardProjects(repo: string): Promise<{ projects: { owner: string; number: number; title: string }[]; problem: string | null }> {
    if (!this.gh) throw new Error('The GitHub CLI (gh) is not installed.');
    const res = await this.ghOut(['repo', 'view', repo, '--json', 'projectsV2']);
    if (res.code !== 0) {
      const scope = /read:project|scope/i.test(res.stderr);
      return {
        projects: [],
        problem: scope
          ? 'Listing projects needs the "read:project" scope: gh auth refresh -s read:project. Until then the board shows open issues and pull requests.'
          : res.stderr.trim().slice(0, 300) || 'gh could not list the projects.',
      };
    }
    return { projects: parseRepoProjects(res.stdout), problem: null };
  }
}

/** Reads a key whatever its case: gh prints some nested fields with the capitalised Go names. Pure. */
const field = (o: unknown, key: string): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  const hit = Object.keys(o).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? (o as Record<string, unknown>)[hit] : undefined;
};

/**
 * Reads `gh repo view --json projectsV2` (`{"projectsV2":{"Nodes":[...]}}`, keys in either case). Owner and number
 * come from the resource path or URL of each project (`/orgs/acme/projects/3`, `/users/me/projects/1`); closed ones
 * are left out. Pure.
 */
export function parseRepoProjects(stdout: string): { owner: string; number: number; title: string }[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout || '{}');
  } catch {
    return [];
  }
  const v2 = field(data, 'projectsV2');
  const nodes = Array.isArray(v2) ? v2 : field(v2, 'nodes');
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n: unknown) => {
    if (field(n, 'closed') === true) return [];
    const path = String(field(n, 'resourcePath') ?? field(n, 'url') ?? '');
    const m = /\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/.exec(path);
    const number = Number(field(n, 'number')) || Number(m?.[2]);
    if (!m || !number) return [];
    return [{ owner: m[1]!, number, title: String(field(n, 'title') ?? `Project ${number}`) }];
  });
}

/** Reads `gh project item-list --format json` defensively. Pure. */
export function parseProjectItems(stdout: string): { ref: string; title: string; url: string | null; status: string }[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout || '{}');
  } catch {
    return [];
  }
  const items = (data as { items?: unknown[] }).items ?? [];
  return (items as Record<string, unknown>[]).map((i) => {
    const content = (i.content ?? {}) as { number?: number; repository?: string; url?: string; title?: string };
    const ref = content.repository && content.number ? `${content.repository}#${content.number}` : String(i.id ?? i.title ?? '');
    return { ref, title: String(i.title ?? content.title ?? ref), url: content.url ?? null, status: typeof i.status === 'string' && i.status ? i.status : 'No status' };
  });
}

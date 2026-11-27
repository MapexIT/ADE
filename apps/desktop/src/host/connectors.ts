import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findOnPath } from '@ade/acp-client';
import type { ConnectorSecret, WorkItem, WorkItemRole } from '@ade/contracts';
import { nextCursor, shortcutMember } from './shortcut-actions.ts';
import type { WorkItemProvider } from './work-items.ts';

/** Connector tokens, held in memory only. Main decrypts them from safeStorage and hands them over (rule 7). */
export class CredentialCache {
  private values: Partial<Record<ConnectorSecret, string>> = {};
  set(values: Partial<Record<ConnectorSecret, string>>) {
    this.values = { ...values };
  }
  get(key: ConnectorSecret): string | null {
    return this.values[key] ?? null;
  }
}

export type Runner = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runFile: Runner = (file, args, env, cwd) =>
  new Promise((resolve) => {
    execFile(file, args, { env, ...(cwd ? { cwd } : {}), windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  url: string;
  repository: { nameWithOwner: string };
  labels?: { name: string }[];
}

/**
 * GitHub issues assigned to the user, through the `gh` CLI ("plus the gh CLI where it is simpler",
 * docs/ARCHITECTURE.md section 10). Uses the user's own `gh` login, or a token from the credential store.
 */
export class GitHubCliProvider implements WorkItemProvider {
  readonly source = 'github' as const;
  constructor(
    private readonly creds: CredentialCache,
    private readonly run: Runner = runFile,
    private readonly gh: string | null = findOnPath('gh'),
  ) {}

  available(): boolean {
    return !!this.gh;
  }

  async connected(): Promise<boolean> {
    if (!this.gh) return false;
    if (this.creds.get('github')) return true;
    return (await this.run(this.gh, ['auth', 'status'], process.env)).code === 0;
  }

  /**
   * CO-01: owner is `--assignee=@me`, requester `--author=@me`, and team the issues that mention one of the user's
   * teams (`--team-mentions org/slug`, the only team filter GitHub search has), grouped by team.
   */
  async list(_query?: string, role: WorkItemRole = 'owner'): Promise<WorkItem[]> {
    if (!this.gh) throw new Error('The GitHub CLI (gh) is not installed.');
    const gh = this.gh;
    const token = this.creds.get('github');
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', ...(token ? { GH_TOKEN: token } : {}) };
    const search = async (filter: string, group?: string): Promise<WorkItem[]> => {
      const res = await this.run(gh, ['search', 'issues', filter, '--state=open', '--limit', '100', '--json', 'number,title,body,state,url,repository,labels'], env);
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'gh could not list your issues. Sign in with `gh auth login`.');
      return (JSON.parse(res.stdout || '[]') as GhIssue[]).map((i) => ({
        ref: `${i.repository.nameWithOwner}#${i.number}`,
        source: 'github',
        title: i.title,
        description: i.body ?? '',
        state: i.labels?.length ? `Open · ${i.labels.map((l) => l.name).join(', ')}` : 'Open',
        url: i.url,
        group: group ?? i.repository.nameWithOwner,
      }));
    };
    if (role === 'owner') return search('--assignee=@me');
    if (role === 'requester') return search('--author=@me');
    const res = await this.run(gh, ['api', 'user/teams', '--paginate', '--jq', '.[] | [.organization.login, .slug, .name] | @tsv'], env);
    if (res.code !== 0) throw new Error(`GitHub did not list your teams; that needs the read:org scope (gh auth refresh -s read:org). ${res.stderr.trim()}`.trim());
    const lists = await Promise.all(parseGhTeams(res.stdout).map((t) => search(`--team-mentions=${t.org}/${t.slug}`, `${t.name} · ${t.org}`)));
    return lists.flat();
  }
}

/** Teams from `gh api user/teams --jq '... | @tsv'`: one `org<TAB>slug<TAB>name` line each. Pure. */
export function parseGhTeams(stdout: string): { org: string; slug: string; name: string }[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && !!p[0] && !!p[1])
    .map(([org, slug, name]) => ({ org: org!, slug: slug!, name: name || slug! }));
}

/** Fields the work item list reads from a Shortcut search (see parseStories). */
const STORY_FIELDS = ['id', 'name', 'description', 'app_url', 'workflow_state', 'iterations', 'epic'];
type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** Thin Adapter over the official MCP client for one HTTP server. */
export class McpHttpConnection {
  private client: Client | null = null;
  constructor(
    private readonly url: string,
    private readonly token: () => string | null,
  ) {}

  async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const token = this.token();
    if (!token) throw new Error('Not connected.');
    const client = new Client({ name: 'ade', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }
}

type ToolInfo = { name: string; description?: string; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } };

/** Picks a story-search tool and its free-text argument from the server's own tool list (never guessed). */
export function pickSearchTool(tools: ToolInfo[]): { name: string; queryArg: string } | null {
  const ranked = tools.filter((t) => /stor(y|ies)/i.test(t.name) && /search|list|find/i.test(t.name));
  for (const t of ranked) {
    const props = Object.entries(t.inputSchema?.properties ?? {});
    const q = props.find(([k, v]) => /^(query|q|search|text)$/i.test(k) && (v.type === 'string' || v.type === undefined));
    if (q) return { name: t.name, queryArg: q[0] };
  }
  return null;
}

/** Reads stories out of an MCP tool result defensively: JSON text content with an array of story-like objects. */
export function parseStories(result: { content?: { type: string; text?: string }[] }): WorkItem[] {
  const out: WorkItem[] = [];
  for (const c of result.content ?? []) {
    if (c.type !== 'text' || !c.text) continue;
    let data: unknown;
    try {
      data = JSON.parse(c.text);
    } catch {
      continue;
    }
    const d = data as { entities?: unknown[]; stories?: unknown[]; data?: unknown[]; results?: unknown[] };
    const list = Array.isArray(data) ? data : (d.entities ?? d.stories ?? d.data ?? d.results ?? []);
    for (const raw of list as Record<string, unknown>[]) {
      if (!raw || (raw.id === undefined && raw.story_id === undefined)) continue;
      const id = String(raw.id ?? raw.story_id);
      const state = (raw.workflow_state_name ?? (raw.workflow_state as { name?: string } | undefined)?.name ?? raw.state ?? 'Unknown') as string;
      out.push({
        ref: `sc-${id}`,
        source: 'shortcut',
        title: String(raw.name ?? raw.title ?? `Story ${id}`),
        description: String(raw.description ?? ''),
        state,
        url: typeof raw.app_url === 'string' ? raw.app_url : null,
        group:
          typeof raw.iteration_name === 'string'
            ? raw.iteration_name
            : typeof raw.epic_name === 'string'
              ? raw.epic_name
              : (((raw.iterations as { entities?: { name?: unknown }[] } | undefined)?.entities?.[0]?.name as string | undefined) ?? null),
      });
    }
  }
  return out;
}

/** Shortcut stories through the hosted Shortcut MCP server (docs/ARCHITECTURE.md section 10). */
export class ShortcutMcpProvider implements WorkItemProvider {
  readonly source = 'shortcut' as const;
  static readonly URL = 'https://mcp.shortcut.com/mcp';
  private readonly conn: McpHttpConnection;

  constructor(private readonly creds: CredentialCache) {
    this.conn = new McpHttpConnection(ShortcutMcpProvider.URL, () => creds.get('shortcut'));
  }

  async connected(): Promise<boolean> {
    return !!this.creds.get('shortcut');
  }

  /** The MCP connection, shared with the Shortcut actions (CO-05, CO-08, CO-09). */
  get connection(): McpHttpConnection {
    return this.conn;
  }

  /**
   * CO-01: open stories the member owns (`owner:`), requested (`requester:`), or that belong to one of their teams
   * (`team:"name"`, teams from get_whoami), grouped by team. Operators checked against the hosted server on 2026-11-27.
   */
  async list(query?: string, role: WorkItemRole = 'owner'): Promise<WorkItem[]> {
    const client = await this.conn.ensure();
    const { tools } = await client.listTools();
    const tool = pickSearchTool(tools as ToolInfo[]);
    if (!tool) throw new Error('The Shortcut MCP server did not offer a story search tool ADE recognises.');
    const props = (tools as ToolInfo[]).find((t) => t.name === tool.name)?.inputSchema?.properties ?? {};
    // `owner:me` matches nothing on Shortcut; the search needs the member's mention name.
    const me = await shortcutMember(client);
    const fields = 'fields' in props ? { fields: STORY_FIELDS } : {};
    const search = async (filter: string, group?: string): Promise<WorkItem[]> => {
      const args: Record<string, unknown> = { [tool.queryArg]: `${filter} !is:done ${query ?? ''}`.trim(), ...fields, ...('limit' in props ? { limit: 100 } : {}) };
      const out: WorkItem[] = [];
      let result = (await client.callTool({ name: tool.name, arguments: args })) as ToolResult;
      for (let page = 0; page < 3; page++) {
        if (result.isError) throw new Error(`Shortcut search failed: ${result.content?.find((c) => c.type === 'text')?.text?.slice(0, 300) ?? 'unknown error'}`);
        out.push(...parseStories(result).map((i) => (group ? { ...i, group } : i)));
        const cursor = 'cursor' in props ? nextCursor(result) : null;
        if (!cursor) break;
        result = (await client.callTool({ name: tool.name, arguments: { cursor, ...fields } })) as ToolResult;
      }
      return out;
    };
    if (role === 'owner') return search(`owner:${me.mentionName}`);
    if (role === 'requester') return search(`requester:${me.mentionName}`);
    const lists = await Promise.all(me.teams.map((t) => search(`team:"${t.name.replace(/"/g, '')}"`, t.name)));
    return lists.flat();
  }

  async reset() {
    await this.conn.close();
  }
}

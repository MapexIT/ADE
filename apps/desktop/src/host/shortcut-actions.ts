import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpHttpConnection } from './connectors.ts';

export interface ShortcutState {
  id: number;
  name: string;
  type: string;
  position: number;
}

export interface ShortcutStory {
  id: number;
  name: string;
  url: string | null;
  /** A state name, or a state id when the server returned only the id. */
  state: string | number | null;
}

/**
 * CO-05, CO-08, CO-09: the Shortcut actions ADE uses. Tool names and arguments were checked against the hosted
 * Shortcut MCP server's own schemas (update_story with workflow_state_id and external_links_add,
 * create_story_comment, list_workflow_states, get_current_iterations, list_iteration_stories).
 */
export interface ShortcutActions {
  moveStory(storyId: number, workflowStateId: number, link?: string): Promise<void>;
  comment(storyId: number, text: string): Promise<void>;
  workflowStates(): Promise<ShortcutState[]>;
  currentIteration(): Promise<{ id: number; name: string } | null>;
  iterationStories(iterationId: number): Promise<ShortcutStory[]>;
  /** CO-09: stories the signed-in member owns: every open one, and those completed in the last `doneDays` days. */
  ownedStories(doneDays?: number): Promise<ShortcutStory[]>;
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** The first JSON value in a tool result's text content, unwrapped from common envelopes. Pure. */
export function resultList(result: ToolResult): Record<string, unknown>[] {
  for (const c of result.content ?? []) {
    if (c.type !== 'text' || !c.text) continue;
    let data: unknown;
    try {
      data = JSON.parse(c.text);
    } catch {
      continue;
    }
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
      // The hosted server wraps lists as { entities: [...] } (seen in its search_stories and list responses).
      for (const key of ['entities', 'data', 'results', 'stories', 'workflow_states', 'iterations', 'items']) {
        const v = (data as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v as Record<string, unknown>[];
      }
      return [data as Record<string, unknown>];
    }
  }
  return [];
}

/** The member in a get_whoami result (`{ entity: { member: { id, mention_name } } }`). Pure. */
export function parseWhoami(result: ToolResult): { id: string; mentionName: string } | null {
  const [data] = resultList(result);
  const entity = (data?.entity ?? data) as Record<string, unknown> | undefined;
  const member = (entity?.member ?? entity) as Record<string, unknown> | undefined;
  return member && typeof member.id === 'string' && typeof member.mention_name === 'string' ? { id: member.id, mentionName: member.mention_name } : null;
}

/** The cursor of the next page, read from a paged result's `next_page_url`. Pure. */
export function nextCursor(result: ToolResult): string | null {
  for (const c of result.content ?? []) {
    if (c.type !== 'text' || !c.text) continue;
    try {
      const url = (JSON.parse(c.text) as { next_page_url?: unknown }).next_page_url;
      return typeof url === 'string' ? new URL(url).searchParams.get('cursor') : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** Story rows from a list or search result. Pure. */
export function toStories(list: Record<string, unknown>[]): (ShortcutStory & { owners: string[] })[] {
  return list
    .filter((s) => typeof s.id === 'number')
    .map((s) => {
      const ws = s.workflow_state;
      const state = ws && typeof ws === 'object' ? String((ws as { name?: unknown }).name ?? (ws as { id?: unknown }).id) : typeof ws === 'number' || typeof ws === 'string' ? ws : null;
      const o = s.owners as { entities?: { id?: unknown }[] } | unknown[] | undefined;
      const owners = (Array.isArray(o) ? o : (o?.entities ?? [])).map((x) => (typeof x === 'string' ? x : String((x as { id?: unknown }).id ?? ''))).filter(Boolean);
      return { id: s.id as number, name: String(s.name ?? `Story ${s.id}`), url: typeof s.app_url === 'string' ? s.app_url : null, state, owners };
    });
}

const memberCache = new WeakMap<Client, { id: string; mentionName: string }>();
/**
 * The signed-in member, from get_whoami. Shortcut's search takes `owner:<mention name>`; `owner:me` matches
 * nothing (checked against the hosted server on 2026-11-27).
 */
export async function shortcutMember(client: Client): Promise<{ id: string; mentionName: string }> {
  const cached = memberCache.get(client);
  if (cached) return cached;
  const result = (await client.callTool({ name: 'get_whoami', arguments: {} })) as ToolResult;
  const me = result.isError ? null : parseWhoami(result);
  if (!me) throw new Error('Shortcut did not say who is signed in (get_whoami).');
  memberCache.set(client, me);
  return me;
}

const errorText = (r: ToolResult) => r.content?.find((c) => c.type === 'text')?.text?.slice(0, 500) ?? 'unknown error';

export class McpShortcutActions implements ShortcutActions {
  constructor(private readonly conn: McpHttpConnection) {}

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.conn.ensure();
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === name)) throw new Error(`The Shortcut MCP server does not offer ${name}.`);
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    if (result.isError) throw new Error(`Shortcut ${name} failed: ${errorText(result)}`);
    return result;
  }

  async moveStory(storyId: number, workflowStateId: number, link?: string) {
    await this.call('update_story', { story_public_id: storyId, workflow_state_id: workflowStateId, ...(link ? { external_links_add: [link] } : {}) });
  }

  async comment(storyId: number, text: string) {
    await this.call('create_story_comment', { story_public_id: storyId, text });
  }

  async workflowStates(): Promise<ShortcutState[]> {
    const list = resultList(await this.call('list_workflow_states', { limit: 100 }));
    return list
      .filter((s) => typeof s.id === 'number')
      .map((s) => ({ id: s.id as number, name: String(s.name ?? s.id), type: String(s.type ?? ''), position: Number(s.position ?? 0) }));
  }

  async currentIteration() {
    const first = resultList(await this.call('get_current_iterations', { limit: 10 })).find((i) => typeof i.id === 'number');
    return first ? { id: first.id as number, name: String(first.name ?? `Iteration ${first.id}`) } : null;
  }

  async iterationStories(iterationId: number): Promise<ShortcutStory[]> {
    return toStories(resultList(await this.call('list_iteration_stories', { iteration_public_id: iterationId, limit: 100, fields: ['id', 'name', 'app_url', 'workflow_state'] })));
  }

  async ownedStories(doneDays = 14): Promise<ShortcutStory[]> {
    const me = await shortcutMember(await this.conn.ensure());
    const since = new Date(Date.now() - doneDays * 86_400_000).toISOString().slice(0, 10);
    const fields = ['id', 'name', 'app_url', 'workflow_state', 'owners'];
    const search = async (query: string) => {
      const out: ReturnType<typeof toStories> = [];
      let result = await this.call('search_stories', { query, limit: 100, fields });
      for (let page = 0; page < 5; page++) {
        out.push(...toStories(resultList(result)));
        const cursor = nextCursor(result);
        if (!cursor) break;
        result = await this.call('search_stories', { cursor, fields });
      }
      return out;
    };
    const [open, done] = await Promise.all([search(`owner:${me.mentionName} !is:done`), search(`owner:${me.mentionName} is:done completed:>${since}`)]);
    // The search is by mention name; keep only stories whose owners include this member, in case names collide.
    const seen = new Set<number>();
    return [...open, ...done].filter((s) => (s.owners.length === 0 || s.owners.includes(me.id)) && !seen.has(s.id) && seen.add(s.id)).map(({ owners: _owners, ...s }) => s);
  }
}

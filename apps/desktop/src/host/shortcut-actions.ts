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
      for (const key of ['data', 'results', 'stories', 'workflow_states', 'iterations', 'items']) {
        const v = (data as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v as Record<string, unknown>[];
      }
      return [data as Record<string, unknown>];
    }
  }
  return [];
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
    const list = resultList(await this.call('list_iteration_stories', { iteration_public_id: iterationId, limit: 100, fields: ['id', 'name', 'app_url', 'workflow_state'] }));
    return list
      .filter((s) => typeof s.id === 'number')
      .map((s) => {
        const ws = s.workflow_state;
        const state = ws && typeof ws === 'object' ? String((ws as { name?: unknown }).name ?? (ws as { id?: unknown }).id) : typeof ws === 'number' || typeof ws === 'string' ? ws : null;
        return { id: s.id as number, name: String(s.name ?? `Story ${s.id}`), url: typeof s.app_url === 'string' ? s.app_url : null, state };
      });
  }
}

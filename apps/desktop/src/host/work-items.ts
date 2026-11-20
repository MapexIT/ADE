import type { WorkItem } from '@ade/contracts';

/**
 * A source of work items (CO-01). Implementations talk to a connector's MCP server; the panel only sees
 * this interface, so adding a connector never touches the UI.
 */
export interface WorkItemProvider {
  readonly source: WorkItem['source'];
  connected(): Promise<boolean>;
  list(query?: string): Promise<WorkItem[]>;
}

/** Registry of connected providers. Unconnected sources answer with an empty list, never an error. */
export class WorkItemService {
  private readonly providers = new Map<WorkItem['source'], WorkItemProvider>();

  register(provider: WorkItemProvider): void {
    this.providers.set(provider.source, provider);
  }

  unregister(source: WorkItem['source']): void {
    this.providers.delete(source);
  }

  async sources(): Promise<{ source: WorkItem['source']; connected: boolean }[]> {
    const all: WorkItem['source'][] = ['shortcut', 'github'];
    return Promise.all(all.map(async (source) => ({ source, connected: (await this.providers.get(source)?.connected().catch(() => false)) ?? false })));
  }

  async list(source: WorkItem['source'], query?: string): Promise<WorkItem[]> {
    const p = this.providers.get(source);
    if (!p) return [];
    const items = await p.list(query);
    const q = query?.trim().toLowerCase();
    return q ? items.filter((i) => i.title.toLowerCase().includes(q) || i.ref.toLowerCase().includes(q)) : items;
  }
}

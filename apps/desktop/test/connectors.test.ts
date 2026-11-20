import { describe, expect, it } from 'vitest';
import { CredentialCache, GitHubCliProvider, parseStories, pickSearchTool, type Runner } from '../src/host/connectors.ts';
import { WorkItemService } from '../src/host/work-items.ts';

describe('GitHubCliProvider', () => {
  it('lists assigned issues through gh with read-only arguments and the stored token', async () => {
    const calls: { args: string[]; token: string | undefined }[] = [];
    const run: Runner = async (_file, args, env) => {
      calls.push({ args, token: env.GH_TOKEN });
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify([{ number: 7, title: 'Fix login', body: 'Steps', state: 'open', url: 'https://github.com/o/r/issues/7', repository: { nameWithOwner: 'o/r' }, labels: [{ name: 'bug' }] }]),
      };
    };
    const creds = new CredentialCache();
    creds.set({ github: 'token-from-store' });
    const items = await new GitHubCliProvider(creds, run, 'gh').list();
    expect(items).toEqual([{ ref: 'o/r#7', source: 'github', title: 'Fix login', description: 'Steps', state: 'Open · bug', url: 'https://github.com/o/r/issues/7', group: 'o/r' }]);
    expect(calls[0]?.args.slice(0, 4)).toEqual(['search', 'issues', '--assignee=@me', '--state=open']);
    expect(calls[0]?.token).toBe('token-from-store');
  });

  it('reports a gh failure as an error the panel can show', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });
    await expect(new GitHubCliProvider(new CredentialCache(), run, 'gh').list()).rejects.toThrow('not logged in');
  });
});

describe('Shortcut MCP helpers', () => {
  it('picks a story search tool and its query argument from the server tool list', () => {
    const tools: Parameters<typeof pickSearchTool>[0] = [
      { name: 'get-story', inputSchema: { properties: { id: { type: 'number' } } } },
      { name: 'stories-search', inputSchema: { properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
    ];
    expect(pickSearchTool(tools)).toEqual({ name: 'stories-search', queryArg: 'query' });
    expect(pickSearchTool([{ name: 'list-members' }])).toBeNull();
  });

  it('parses stories from JSON text content and names them sc-<id>', () => {
    const items = parseStories({
      content: [{ type: 'text', text: JSON.stringify({ stories: [{ id: 4821, name: 'Fix login redirect', description: 'd', workflow_state_name: 'In Development', app_url: 'https://app.shortcut.com/x/story/4821' }] }) }],
    });
    expect(items[0]).toMatchObject({ ref: 'sc-4821', title: 'Fix login redirect', state: 'In Development' });
  });
});

describe('WorkItemService', () => {
  it('answers unconnected sources with an empty list and reports connection state', async () => {
    const service = new WorkItemService();
    expect(await service.list('shortcut')).toEqual([]);
    service.register({ source: 'github', connected: async () => true, list: async () => [{ ref: 'o/r#1', source: 'github', title: 'Alpha', description: '', state: 'Open', url: null, group: null }] });
    expect(await service.sources()).toEqual([
      { source: 'shortcut', connected: false },
      { source: 'github', connected: true },
    ]);
    expect(await service.list('github', 'alp')).toHaveLength(1);
    expect(await service.list('github', 'zzz')).toHaveLength(0);
  });
});

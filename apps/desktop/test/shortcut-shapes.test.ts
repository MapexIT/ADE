import { describe, expect, it } from 'vitest';
import { parseStories } from '../src/host/connectors.ts';
import { nextCursor, parseWhoami, resultList, toStories } from '../src/host/shortcut-actions.ts';

// Shapes as the hosted Shortcut MCP server returned them on 2026-11-27 (ids and names replaced).
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const ME = 'member-1';
const search = text({
  current_page: 1,
  entities: [
    {
      id: 101,
      name: 'Parser',
      app_url: 'https://app.shortcut.com/x/story/101',
      owners: { current_items: 1, entities: [{ entity_type: 'member:slim', id: ME, name: 'Someone' }], total_items: 1 },
      iterations: { current_items: 1, entities: [{ id: 7465, name: 'Continues Kanban' }], total_items: 1 },
      workflow_state: { entity_type: 'workflow-state:slim', id: 500000008, name: 'In Development' },
    },
    {
      id: 102,
      name: 'Shared',
      owners: { entities: [{ id: 'member-2' }] },
      workflow_state: { id: 500000009, name: 'In Review' },
    },
  ],
  total_items: 36,
  next_page_url: 'https://api.app.shortcut.com/api/v4/x/stories/search?cursor=ABC_123-x',
});

describe('CO-01, CO-09 Shortcut response shapes', () => {
  it('reads the member from get_whoami', () => {
    expect(parseWhoami(text({ entity: { entity_type: 'whoami', member: { id: ME, mention_name: 'someone', name: 'Someone' } } }))).toEqual({ id: ME, mentionName: 'someone' });
    expect(parseWhoami(text({ entity: {} }))).toBeNull();
  });

  it('unwraps the entities envelope and reads owners and state', () => {
    expect(resultList(search)).toHaveLength(2);
    expect(toStories(resultList(search))).toEqual([
      { id: 101, name: 'Parser', url: 'https://app.shortcut.com/x/story/101', state: 'In Development', owners: [ME] },
      { id: 102, name: 'Shared', url: null, state: 'In Review', owners: ['member-2'] },
    ]);
  });

  it('finds the next page cursor', () => {
    expect(nextCursor(search)).toBe('ABC_123-x');
    expect(nextCursor(text({ entities: [] }))).toBeNull();
  });

  it('lists work items from the entities envelope with their iteration as the group', () => {
    const items = parseStories(search);
    expect(items.map((i) => [i.ref, i.state, i.group])).toEqual([
      ['sc-101', 'In Development', 'Continues Kanban'],
      ['sc-102', 'In Review', null],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { CredentialCache, GitHubCliProvider, parseGhTeams, type Runner } from '../src/host/connectors.ts';
import { parseWhoami } from '../src/host/shortcut-actions.ts';

const issue = (n: number, repo: string) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', url: `https://github.com/${repo}/issues/${n}`, repository: { nameWithOwner: repo }, labels: [] });
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

describe('CO-01 owner, requester and team work items', () => {
  it('asks GitHub for assigned, authored and team-mentioned issues, grouping team items by team', async () => {
    const calls: string[][] = [];
    const run: Runner = async (_file, args) => {
      calls.push(args);
      if (args[0] === 'api') return { code: 0, stderr: '', stdout: 'org\tcore\tCore team\norg\tweb\tWeb\n' };
      const team = args.find((a) => a.startsWith('--team-mentions='));
      return { code: 0, stderr: '', stdout: JSON.stringify(team === '--team-mentions=org/web' ? [issue(2, 'org/site')] : [issue(1, 'org/app')]) };
    };
    const gh = new GitHubCliProvider(new CredentialCache(), run, 'gh');
    expect((await gh.list(undefined, 'owner'))[0]?.group).toBe('org/app');
    expect(calls.at(-1)?.[2]).toBe('--assignee=@me');
    await gh.list(undefined, 'requester');
    expect(calls.at(-1)?.[2]).toBe('--author=@me');
    calls.length = 0;
    const team = await gh.list(undefined, 'team');
    expect(calls[0]?.slice(0, 2)).toEqual(['api', 'user/teams']);
    expect(team.map((i) => [i.ref, i.group])).toEqual([
      ['org/app#1', 'Core team · org'],
      ['org/site#2', 'Web · org'],
    ]);
  });

  it('explains the missing scope when GitHub will not list teams', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' });
    await expect(new GitHubCliProvider(new CredentialCache(), run, 'gh').list(undefined, 'team')).rejects.toThrow(/read:org/);
  });

  it('parses team lines and the Shortcut member’s teams', () => {
    expect(parseGhTeams('a\tb\tB team\r\n\nc\td\t\n')).toEqual([
      { org: 'a', slug: 'b', name: 'B team' },
      { org: 'c', slug: 'd', name: 'd' },
    ]);
    // Shape as get_whoami returned it on 2026-11-27, ids replaced.
    const me = parseWhoami(text({ entity: { member: { id: 'm1', mention_name: 'me', teams: { entities: [{ id: 't1', name: 'Speedtrain' }, { id: 't2', name: 'Engineering' }] } } } }));
    expect(me).toEqual({ id: 'm1', mentionName: 'me', teams: [{ id: 't1', name: 'Speedtrain' }, { id: 't2', name: 'Engineering' }] });
  });
});

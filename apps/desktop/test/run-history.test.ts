import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/host/db.ts';
import { Repositories } from '../src/host/repositories.ts';

const run = (n: number) => ({ runConfigId: null, sessionId: null, worktreePath: '/repo', command: ['echo', String(n)], startedAt: `2026-11-27T10:0${n}:00Z`, endedAt: null, exitCode: 0, output: '' });

describe('CR-15 deleting run history', () => {
  it('deletes chosen runs, never another workspace’s, and clears the rest', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repos = new Repositories(db);
    const a = repos.workspaces.upsert('/a', 'a');
    const b = repos.workspaces.upsert('/b', 'b');
    const [r1, r2, r3] = [1, 2, 3].map((n) => repos.runs.record(run(n), a.id));
    const other = repos.runs.record(run(4), b.id);

    expect(repos.runs.delete(a.id, [r2!.id, other.id])).toBe(1);
    expect(repos.runs.history(a.id).map((r) => r.id)).toEqual([r3!.id, r1!.id]);
    expect(repos.runs.history(b.id)).toHaveLength(1);

    expect(repos.runs.delete(a.id)).toBe(2);
    expect(repos.runs.history(a.id)).toEqual([]);
    expect(repos.runs.history(b.id)).toHaveLength(1);
  });
});

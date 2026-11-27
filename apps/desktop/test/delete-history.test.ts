import { BlockBuilder } from '@ade/shell-integration';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/host/db.ts';
import { Repositories } from '../src/host/repositories.ts';

const setup = () => {
  const db = openDatabase(':memory:');
  migrate(db);
  return { db, repos: new Repositories(db) };
};

const session = (id: string, workspaceId: string, state: string) => ({
  id,
  workspaceId,
  agentId: 'fake' as const,
  title: id,
  state: state as never,
  baseCommit: 'abc',
  branch: `agent/${id}`,
  worktreePath: `/wt/${id}`,
  permissionProfile: 'ask' as const,
  sandboxState: 'not-sandboxed' as const,
  containment: 'none' as const,
  inPlace: false,
  compareGroup: null,
  agentSessionId: null,
  workItemRef: null,
  createdAt: '2026-11-27T10:00:00Z',
  endedAt: null,
});

describe('HI-13 deleting history', () => {
  it('deletes only ended sessions of the workspace, with their events, and keeps the audit log', () => {
    const { db, repos } = setup();
    const a = repos.workspaces.upsert('/a', 'a');
    const b = repos.workspaces.upsert('/b', 'b');
    for (const [id, ws, state] of [['landed', a.id, 'landed'], ['discarded', a.id, 'discarded'], ['live', a.id, 'ready'], ['other', b.id, 'landed']] as const) {
      repos.sessions.insert(session(id, ws, state));
      repos.events.append({ sessionId: id, type: 'notice', level: 'info', text: `hello ${id}` } as never);
    }
    repos.audit.append({ workspaceId: a.id, sessionId: 'landed', actor: 'user', action: 'session.landed', detail: {} });

    expect(repos.sessions.deleteEnded(a.id, ['landed', 'live', 'other'])).toEqual(['landed']);
    expect(repos.sessions.get('landed')).toBeNull();
    expect(repos.events.list('landed')).toEqual([]);
    expect(repos.sessions.get('live')).not.toBeNull();
    expect(repos.sessions.get('other')).not.toBeNull();
    expect(repos.sessions.deleteEnded(a.id).sort()).toEqual(['discarded']);
    expect(repos.sessions.list(a.id).map((s) => s.id)).toEqual(['live']);
    expect(db.all('SELECT * FROM audit_log')).toHaveLength(1);
  });

  it('deletes finished workflow runs only', () => {
    const { repos } = setup();
    const ws = repos.workspaces.upsert('/a', 'a');
    for (const [id, status] of [['r1', 'succeeded'], ['r2', 'failed'], ['r3', 'running'], ['r4', 'paused']]) {
      repos.workflowRuns.insert({ id: id!, workspaceId: ws.id, workflowId: 'w', yaml: '', status: status!, state: {}, context: {} } as never);
    }
    expect(repos.workflowRuns.deleteFinished(ws.id, ['r1', 'r3'])).toBe(1);
    expect(repos.workflowRuns.deleteFinished(ws.id)).toBe(1);
    expect(repos.workflowRuns.list(ws.id).map((r) => r.id).sort()).toEqual(['r3', 'r4']);
  });

  it('forgets terminal commands, one or all, per workspace', () => {
    const { repos } = setup();
    for (const [ws, command] of [['w1', 'npm test'], ['w1', 'git status'], ['w2', 'ls']]) repos.history.record({ workspaceId: ws!, sessionId: null, command: command!, cwd: null, exitCode: 0 });
    expect(repos.history.clear('w1', ['npm test'])).toBe(1);
    expect(repos.history.search('', 'w1').map((e) => e.command)).toEqual(['git status']);
    expect(repos.history.clear('w1')).toBe(1);
    expect(repos.history.search('', 'w2').map((e) => e.command)).toEqual(['ls']);
  });

  it('clears finished command blocks', () => {
    const b = new BlockBuilder();
    b.blocks.push({ id: 'x' } as never);
    b.clearFinished();
    expect(b.blocks).toEqual([]);
  });
});

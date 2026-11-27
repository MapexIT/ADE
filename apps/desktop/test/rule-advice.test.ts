import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEventOf } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

async function makeRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  await git(['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: dir });
  await git(['commit', '-q', '-m', 'init'], { cwd: dir, env: ID });
  return dir;
}

const newHost = () => {
  const h = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
  h.repos.settings.set('sandbox.byDefault', false);
  return h;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-advice-'));
  repo = await makeRepo('repo');
  host = newHost();
});

afterEach(async () => {
  await host.dispose();
  removeTemp(root);
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const text = (t: string) => [{ type: 'text' as const, text: t }];
type Answer = 'allow-once' | 'reject-once';

const pendingRequest = (sessionId: string) => {
  const events = host.repos.events.list(sessionId);
  const decided = new Set(events.flatMap((e) => (e.type === 'permission.decided' ? [e.requestId] : [])));
  return events.find((e): e is SessionEventOf<'permission.requested'> => e.type === 'permission.requested' && !decided.has(e.requestId)) ?? null;
};

/**
 * Runs one session of `ask` lines and answers each request in turn: one answer per line, or the same for all.
 * Returns the session id once it is ready.
 */
async function run(workspaceId: string, commands: string[], answers: Answer | Answer[] = 'allow-once') {
  const session = await host.handlers['sessions.create']({
    workspaceId,
    agentId: 'fake',
    prompt: text([...commands.map((c) => `ask ${c}`), 'say done'].join('\n')),
    permissionProfile: 'ask',
    bringChanges: false,
  });
  let i = 0;
  for (;;) {
    const state = await waitFor(() => {
      const s = host.repos.sessions.require(session.id).state;
      return s === 'ready' || s === 'waiting-on-user' ? s : null;
    });
    if (state === 'ready') return session.id;
    const req = await waitFor(() => pendingRequest(session.id));
    const optionId = Array.isArray(answers) ? answers[i]! : answers;
    i++;
    await host.handlers['sessions.answerPermission']({ sessionId: session.id, requestId: req.requestId, optionId });
    await waitFor(() => pendingRequest(session.id)?.requestId !== req.requestId);
  }
}

const open = (path = repo) => host.handlers['workspace.open']({ path });
const advice = (workspaceId: string) => host.handlers['rules.advice']({ workspaceId });

describe('AP-09 rule suggestions in the host', () => {
  it('1, 2: suggests the exact command after three approvals, not after two', async () => {
    const ws = await open();
    await run(ws.id, ['npm test', 'npm test']);
    expect((await advice(ws.id)).suggestions).toEqual([]);
    await run(ws.id, ['npm test']);
    const { suggestions, requests } = await advice(ws.id);
    expect(requests).toBe(3);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      key: 'allow:npm test',
      decision: 'allow',
      pattern: 'npm test',
      wider: 'npm test *',
      risk: 'project',
      evidence: { allowed: 3, rejected: 0, sessions: 2, agents: ['fake'] },
      rehearsal: { considered: 3, wouldAnswer: 3, conflict: 0 },
    });
  }, 60_000);

  it('3, 4: widens to the stem for different arguments, and keeps it exact around a rejection', async () => {
    const ws = await open();
    await run(ws.id, ['git status', 'git status -s', 'git status --short']);
    expect((await advice(ws.id)).suggestions[0]).toMatchObject({ pattern: 'git status *', risk: 'read', wider: null });
    await run(ws.id, ['npm test', 'npm test', 'npm test', 'npm test -- --watch'], ['allow-once', 'allow-once', 'allow-once', 'reject-once']);
    const npm = (await advice(ws.id)).suggestions.find((s) => s.key === 'allow:npm test');
    expect(npm).toMatchObject({ pattern: 'npm test', wider: null });
  }, 60_000);

  it('5: offers deny after two rejections and never an allow rule for deletion', async () => {
    const ws = await open();
    await run(ws.id, ['git push origin main', 'git push origin main'], 'reject-once');
    await run(ws.id, ['rm -rf build', 'rm -rf build', 'rm -rf build']);
    const { suggestions } = await advice(ws.id);
    expect(suggestions.map((s) => [s.decision, s.pattern])).toEqual([['deny', 'git push *']]);
  }, 60_000);

  it('6, 7: adopting adds a rule that answers the next request, audits counts only, and still asks about a chain', async () => {
    const ws = await open();
    await run(ws.id, ['npm test', 'npm test', 'npm test']);
    const [s] = (await advice(ws.id)).suggestions;
    await host.handlers['rules.adopt']({ workspaceId: ws.id, key: s!.key, rule: { id: 'draft', decision: 'allow', kind: 'execute', pattern: s!.pattern } });
    const rules = await host.handlers['rules.list']({ workspaceId: ws.id });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ decision: 'allow', kind: 'execute', pattern: 'npm test' });
    expect(rules[0]!.id).not.toBe('draft');

    const audit = host.repos.audit.list(ws.id).find((a) => a.action === 'rules.suggestion.accepted')!;
    expect(audit.detail).toMatchObject({
      key: 'allow:npm test',
      evidence: { allowed: 3, rejected: 0, sessions: 1 },
      rehearsal: { considered: 3, wouldAnswer: 3, agree: 3, conflict: 0 },
    });
    expect(JSON.stringify(audit.detail)).not.toMatch(/covers|conflicts|examples/);
    expect((await advice(ws.id)).suggestions).toEqual([]);

    // A new session: the rule answers `npm test`, and the chain is asked about.
    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('ask npm test\nask npm test && rm -rf build\nsay done'),
      permissionProfile: 'ask',
      bringChanges: false,
    });
    const chain = await waitFor(() => pendingRequest(session.id));
    expect(chain.detail).toBe('npm test && rm -rf build');
    const decided = host.repos.events.list(session.id).flatMap((e) => (e.type === 'permission.decided' ? [e] : []));
    expect(decided.map((d) => d.decidedBy)).toEqual([`rule:${rules[0]!.id}`]);
    expect((await host.handlers['inbox.list']({})).some((i) => i.sessionId === session.id)).toBe(true);
    await host.handlers['sessions.answerPermission']({ sessionId: session.id, requestId: chain.requestId, optionId: 'reject-once' });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
  }, 60_000);

  it('8: Not now hides until three more approvals; Never hides for good; both survive a restart', async () => {
    const ws = await open();
    await run(ws.id, ['npm test', 'npm test', 'npm test', 'git status', 'git status', 'git status']);
    await host.handlers['rules.dismissSuggestion']({ workspaceId: ws.id, key: 'allow:npm test', forever: false });
    await host.handlers['rules.dismissSuggestion']({ workspaceId: ws.id, key: 'allow:git status', forever: true });
    expect((await advice(ws.id)).suggestions).toEqual([]);
    expect(host.repos.audit.list(ws.id).filter((a) => a.action === 'rules.suggestion.dismissed').map((a) => a.detail)).toEqual(
      expect.arrayContaining([
        { key: 'allow:npm test', forever: false },
        { key: 'allow:git status', forever: true },
      ]),
    );

    await host.dispose();
    host = newHost();
    const again = await open();
    expect(again.id).toBe(ws.id);
    expect((await advice(ws.id)).suggestions).toEqual([]);
    await run(ws.id, ['npm test', 'npm test', 'git status', 'git status', 'git status']);
    expect((await advice(ws.id)).suggestions).toEqual([]);
    await run(ws.id, ['npm test']);
    expect((await advice(ws.id)).suggestions.map((s) => s.key)).toEqual(['allow:npm test']);
  }, 90_000);

  it('9: rehearses a hand-written rule with covered commands and conflicts', async () => {
    const ws = await open();
    await run(ws.id, ['npm test', 'npm run build', 'npm publish'], ['allow-once', 'allow-once', 'reject-once']);
    const r = await host.handlers['rules.rehearse']({ workspaceId: ws.id, rule: { id: 'new', decision: 'allow', kind: 'any', pattern: 'npm *' } });
    expect(r).toMatchObject({ considered: 3, wouldAnswer: 3, agree: 2, conflict: 1, agents: ['fake'] });
    expect(r.covers.map((c) => c.text).sort()).toEqual(['npm publish', 'npm run build', 'npm test']);
    expect(r.conflicts[0]).toMatchObject({ text: 'npm publish', decided: 'rejected' });
  }, 60_000);

  it('10: reports usage and the commands a rule answered that were never approved by hand', async () => {
    const ws = await open();
    await run(ws.id, ['git status']);
    await host.handlers['rules.save']({ workspaceId: ws.id, rules: [{ id: 'g', decision: 'allow', kind: 'execute', pattern: 'git status *' }] });
    await run(ws.id, ['git status', 'git status -s']);
    const { usage } = await advice(ws.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ ruleId: 'g', answered: 2, unused: false, unseen: [{ text: 'git status -s', count: 1 }] });
    expect(usage[0]!.lastTs).toEqual(expect.any(String));
    // `rules.save` stamped the new rule's creation time.
    expect(host.repos.settings.get<Record<string, string>>(`rules.created.${ws.id}`, {})).toEqual({ g: expect.any(String) });
  }, 60_000);

  it('11: switching suggestions off hides them but keeps usage', async () => {
    const ws = await open();
    await host.handlers['rules.save']({ workspaceId: ws.id, rules: [{ id: 'x', decision: 'allow', kind: 'execute', pattern: 'ls' }] });
    await run(ws.id, ['npm test', 'npm test', 'npm test']);
    await host.handlers['settings.set']({ key: 'ruleAdvice', value: { enabled: false } });
    const a = await advice(ws.id);
    expect(a.suggestions).toEqual([]);
    expect(a.usage.map((u) => u.ruleId)).toEqual(['x']);
  }, 60_000);

  it('12: answers by profiles and rules are not evidence', async () => {
    const ws = await open();
    const session = await run(ws.id, []);
    for (const by of ['profile:autonomous', 'profile:autonomous', 'rule:gone', 'system']) {
      const requestId = `${by}-${Math.random()}`;
      host.repos.events.append({
        sessionId: session,
        type: 'permission.requested',
        requestId,
        toolCallId: requestId,
        title: 'Run npm test',
        kind: 'execute',
        detail: 'npm test',
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      });
      host.repos.events.append({ sessionId: session, type: 'permission.decided', requestId, decision: { outcome: 'selected', optionId: 'allow-once' }, decidedBy: by, note: null });
    }
    const a = await advice(ws.id);
    expect(a.requests).toBe(0);
    expect(a.suggestions).toEqual([]);
  }, 60_000);

  it('13: keeps workspaces apart', async () => {
    const ws = await open();
    const other = await open(await makeRepo('other'));
    await run(ws.id, ['npm test', 'npm test', 'npm test']);
    expect((await advice(ws.id)).suggestions).toHaveLength(1);
    expect(await advice(other.id)).toMatchObject({ suggestions: [], requests: 0 });
  }, 60_000);

  it('14: reads 4,000 events quickly', async () => {
    const ws = await open();
    const session = await run(ws.id, []);
    const db = host.repos.db;
    const ts = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        const requestId = `syn-${i}`;
        const cmd = `node tool${i % 40}.js --n ${i % 7}`;
        const requested = { sessionId: session, seq: 1_000 + i * 2, ts, type: 'permission.requested', requestId, toolCallId: requestId, title: `Run ${cmd}`, kind: 'execute', detail: cmd, options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }] };
        const decided = { sessionId: session, seq: 1_001 + i * 2, ts, type: 'permission.decided', requestId, decision: { outcome: 'selected', optionId: i % 5 ? 'a' : 'r' }, decidedBy: 'user', note: null };
        for (const e of [requested, decided]) db.run('INSERT INTO events (session_id, seq, ts, type, turn_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)', session, e.seq, ts, e.type, null, JSON.stringify(e));
      }
    });
    await host.handlers['rules.save']({ workspaceId: ws.id, rules: [{ id: 'n', decision: 'allow', kind: 'execute', pattern: 'node tool1.js *' }] });
    await advice(ws.id); // warm up
    const started = performance.now();
    const a = await advice(ws.id);
    const took = performance.now() - started;
    expect(a.requests).toBe(2_000);
    expect(took).toBeLessThan(process.env.CI ? 300 : 100);
  }, 60_000);
});

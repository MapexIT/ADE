import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionEvent, SessionEventOf, Turn } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { claimVerdict, openItems, receiptsFrom } from '@ade/session-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { EventBus } from '../src/host/bus.ts';
import { ReceiptService } from '../src/host/receipts.ts';
import { removeTemp } from './cleanup.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const NODE = `"${process.execPath}"`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-receipts-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  writeFileSync(join(repo, '.gitignore'), '*.log\n');
  // Node's own test runner: the same on Windows and Linux, no npm needed.
  writeFileSync(join(repo, 'pass.test.mjs'), "import test from 'node:test';\ntest('passes', () => {});\n");
  writeFileSync(join(repo, 'fail.test.mjs'), "import test from 'node:test';\ntest('fails', () => { throw new Error('no'); });\n");
  writeFileSync(join(repo, 'old.test.js'), "it('works', () => {});\n");
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
  });
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(prompt: string) {
  const ws = await host.handlers['workspace.open']({ path: repo });
  return host.handlers['sessions.create']({ workspaceId: ws.id, agentId: 'fake', prompt: text(prompt), permissionProfile: 'ask', bringChanges: false });
}

const events = (id: string) => host.repos.events.list(id);
const receipts = (id: string) => events(id).filter((e): e is SessionEventOf<'receipt.issued'> => e.type === 'receipt.issued');
const ended = (id: string, turns = 1) => host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns && host.repos.sessions.require(id).state === 'ready';
/** Waits for the turns to end and gives an asynchronous receipt time to arrive. */
const settle = async (id: string, turns = 1) => {
  await waitFor(() => ended(id, turns));
  await pause(600);
};
const receiptAfter = async (id: string, n = 1) => {
  await waitFor(() => receipts(id).length >= n);
  return receipts(id)[n - 1]!;
};
async function prompt(id: string, script: string, turns: number) {
  await host.handlers['sessions.prompt']({ sessionId: id, content: text(script) });
  await waitFor(() => ended(id, turns));
}

describe('RV-16 turn receipt with the fake agent', () => {
  it('flags an unproven claim once, with the files Git changed and one notification', async () => {
    const notes: { title: string; body: string }[] = [];
    host.bus.on('notify', (n) => notes.push(n));
    const session = await start('edit a.txt one\nsay All tests pass.');
    const r = await receiptAfter(session.id);
    expect(r.claims).toEqual([{ category: 'tests', quote: 'All tests pass.', status: 'unseen', evidence: null }]);
    expect(r.facts).toMatchObject({ filesChanged: 1, editsReported: 1, commands: 0 });
    expect(r.findings).toEqual([]);
    expect(r.turnIndex).toBe(0);
    const turn = events(session.id).find((e) => e.type === 'turn.started');
    expect(turn?.type === 'turn.started' && turn.turnId).toBe(r.turnId);
    await settle(session.id);
    expect(receipts(session.id)).toHaveLength(1);
    expect(notes.filter((n) => n.title === 'A finished turn has something to check')).toEqual([
      { sessionId: session.id, title: 'A finished turn has something to check', body: expect.stringContaining('Says the tests pass. ADE saw no test command in this turn.') },
    ]);
  });

  it('issues nothing for a pure chat turn', async () => {
    const session = await start('say Hello.');
    await settle(session.id);
    expect(receipts(session.id)).toEqual([]);
  });

  it('judges a claim by the order of the test run and the last edit', async () => {
    const session = await start(`run ${NODE} --test pass.test.mjs\nedit a.txt one\nsay All tests pass.`);
    const stale = await receiptAfter(session.id, 1);
    expect(stale.claims[0]).toMatchObject({ category: 'tests', status: 'stale' });
    expect(stale.claims[0]!.evidence).toContain('--test pass.test.mjs (exit 0)');
    expect(stale.passed).toEqual([]);

    await prompt(session.id, `edit a.txt two\nrun ${NODE} --test pass.test.mjs\nsay All tests pass.`, 2);
    const supported = await receiptAfter(session.id, 2);
    expect(supported.claims[0]).toMatchObject({ category: 'tests', status: 'supported' });
    expect(supported.passed).toEqual(['tests']);

    await prompt(session.id, `run ${NODE} --test fail.test.mjs\nsay All tests pass.`, 3);
    const contradicted = await receiptAfter(session.id, 3);
    expect(contradicted.claims[0]).toMatchObject({ category: 'tests', status: 'contradicted' });
    expect(contradicted.claims[0]!.evidence).toContain('(exit 1)');
    expect(contradicted.facts).toMatchObject({ commands: 1, commandsFailed: 1, filesChanged: 0 });
  }, 60_000);

  it('reads claims only from the closing statement', async () => {
    const session = await start('say First.\nread README.md\nsay All tests pass.');
    expect((await receiptAfter(session.id)).claims.map((c) => c.category)).toEqual(['tests']);
    const other = await start('edit a.txt one\nsay All tests pass.\nread README.md\nsay Done.');
    expect((await receiptAfter(other.id)).claims).toEqual([]);
  });

  it('flags an edit Git does not see, unless Git ignores the path', async () => {
    const session = await start('ghost b.txt x\nsay Done.');
    expect((await receiptAfter(session.id)).findings).toEqual([{ kind: 'phantom-edit', level: 'warning', paths: ['b.txt'], more: 0, detail: null }]);
    const ignored = await start('ghost debug.log x\nsay Done.');
    await settle(ignored.id);
    expect(receipts(ignored.id)).toEqual([]);
  });

  it('notes a file changed without a reported edit and does not notify about a note', async () => {
    const notes: string[] = [];
    host.bus.on('notify', (n) => notes.push(n.title));
    const session = await start('touch c.txt x\nsay Done.');
    const r = await receiptAfter(session.id);
    expect(r.findings).toEqual([{ kind: 'unreported-change', level: 'note', paths: ['c.txt'], more: 0, detail: 'No edit or command was reported for these files.' }]);
    await settle(session.id);
    expect(notes).not.toContain('A finished turn has something to check');
  });

  it('flags switched-off tests and deleted test files', async () => {
    const session = await start("edit math.test.js it.skip('adds', () => {})\nsay Done.");
    expect((await receiptAfter(session.id)).findings).toEqual([
      { kind: 'tests-skipped', level: 'warning', paths: ['math.test.js'], more: 0, detail: '1 marker added' },
    ]);
    const deleted = await start('delete old.test.js\nsay Done.');
    expect((await receiptAfter(deleted.id)).findings).toEqual([{ kind: 'tests-deleted', level: 'warning', paths: ['old.test.js'], more: 0, detail: null }]);
  });

  it('issues nothing for a cancelled or a failed turn', async () => {
    const cancelled = await start('edit a.txt one\nsay All tests pass.\nhang');
    // The message is stored when the turn ends (chunks are coalesced), so wait for the edit and give it time.
    await waitFor(() => host.repos.sessions.require(cancelled.id).state === 'working' && events(cancelled.id).some((e) => e.type === 'tool.update'));
    await pause(300);
    await host.handlers['sessions.cancel']({ sessionId: cancelled.id });
    await settle(cancelled.id);
    expect(events(cancelled.id).find((e) => e.type === 'turn.ended')).toMatchObject({ stopReason: 'cancelled' });
    expect(receipts(cancelled.id)).toEqual([]);
    const failed = await start('edit a.txt one\nsay All tests pass.\nfail on purpose');
    await waitFor(() => events(failed.id).some((e) => e.type === 'turn.ended'));
    await pause(600);
    expect(events(failed.id).find((e) => e.type === 'turn.ended')).toMatchObject({ stopReason: 'error' });
    expect(receipts(failed.id)).toEqual([]);
  }, 40_000);

  it('follows the settings: off records nothing, no notify still records', async () => {
    const notes: string[] = [];
    host.bus.on('notify', (n) => notes.push(n.title));
    await host.handlers['settings.set']({ key: 'receipts', value: { enabled: false, notify: true } });
    const off = await start('edit a.txt one\nsay All tests pass.');
    await settle(off.id);
    expect(receipts(off.id)).toEqual([]);
    await host.handlers['settings.set']({ key: 'receipts', value: { enabled: true, notify: false } });
    const quiet = await start('edit a.txt one\nsay All tests pass.');
    await receiptAfter(quiet.id);
    await settle(quiet.id);
    expect(notes).not.toContain('A finished turn has something to check');
  });

  it('"Mark as checked" records an event and an audit entry once', async () => {
    const session = await start('edit a.txt one\nsay All tests pass.');
    const r = await receiptAfter(session.id);
    await host.handlers['sessions.acknowledgeReceipt']({ sessionId: session.id, turnId: r.turnId });
    await host.handlers['sessions.acknowledgeReceipt']({ sessionId: session.id, turnId: r.turnId });
    expect(events(session.id).filter((e) => e.type === 'receipt.acknowledged')).toHaveLength(1);
    expect(host.repos.audit.forSession(session.id, 'receipt.acknowledged')).toEqual([
      expect.objectContaining({ actor: 'user', detail: { turnIndex: 0, items: ['Says the tests pass. ADE saw no test command in this turn.'] } }),
    ]);
    expect(openItems(receiptsFrom(events(session.id)))).toEqual([]);
  });

  it('issues receipts in turn order when the next turn was queued', async () => {
    const session = await start('edit a.txt one\nsay All tests pass.');
    await host.handlers['sessions.prompt']({ sessionId: session.id, content: text('edit a.txt two\nsay The build succeeds.') });
    await receiptAfter(session.id, 2);
    expect(receipts(session.id).map((r) => [r.turnIndex, r.claims[0]?.category])).toEqual([
      [0, 'tests'],
      [1, 'build'],
    ]);
    const turns = host.repos.turns.list(session.id);
    expect(receipts(session.id).map((r) => r.turnId)).toEqual(turns.map((t) => t.id));
  });
});

describe('RV-16 receipts, checks and landing', () => {
  it("attaches ADE's checks to the receipt and confirms the claim", async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const config = host.repos.runs.saveUser({ workspaceId: ws.id, name: 'Unit tests', command: [process.execPath, '--test', 'pass.test.mjs'], cwd: ws.rootPath });
    await host.handlers['checks.saveSettings']({ workspaceId: ws.id, settings: { configIds: [config.id], afterTurn: false } });
    const session = await start('edit a.txt one\nsay All tests pass.');
    const r = await receiptAfter(session.id);
    await settle(session.id);
    expect((await host.handlers['checks.run']({ sessionId: session.id }))[0]!.exitCode).toBe(0);
    const checked = await waitFor(() => events(session.id).find((e): e is SessionEventOf<'receipt.checked'> => e.type === 'receipt.checked'));
    expect(checked).toMatchObject({ turnId: r.turnId, turnIndex: 0, checks: [{ name: 'Unit tests', categories: ['tests'], exitCode: 0 }] });
    const list = receiptsFrom(events(session.id));
    expect(claimVerdict(list, list[0]!, list[0]!.claims[0]!)).toEqual({ status: 'confirmed', check: 'Unit tests', exitCode: 0 });
    expect(openItems(list)).toEqual([]);
  }, 40_000);

  it('closes an earlier claim when a later turn passes the same command', async () => {
    const session = await start('edit a.txt one\nsay All tests pass.');
    await receiptAfter(session.id);
    expect(openItems(receiptsFrom(events(session.id)))).toHaveLength(1);
    await prompt(session.id, `run ${NODE} --test pass.test.mjs\nsay All tests pass.`, 2);
    expect((await receiptAfter(session.id, 2)).passed).toEqual(['tests']);
    const list = receiptsFrom(events(session.id));
    expect(claimVerdict(list, list[0]!, list[0]!.claims[0]!)).toEqual({ status: 'superseded' });
    expect(openItems(list)).toEqual([]);
  }, 40_000);

  it('names open items in the land audit entry and still lands', async () => {
    const session = await start('edit a.txt one\nsay All tests pass.');
    await receiptAfter(session.id);
    await settle(session.id);
    await host.handlers['sessions.land']({ sessionId: session.id, mode: 'apply', files: ['a.txt'] });
    expect(host.repos.sessions.require(session.id).state).toBe('landed');
    expect(host.repos.audit.forSession(session.id, 'session.land.apply')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ receiptWarnings: ['Turn 1: Says the tests pass. ADE saw no test command in this turn.'] }) }),
    ]);
  }, 40_000);
});

describe('RV-16 receipt service failures', () => {
  it('records nothing and throws nothing when Git fails', async () => {
    const bus = new EventBus();
    const recorded: unknown[] = [];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const session = { id: 's1', workspaceId: 'w', title: 'T', worktreePath: join(root, 'gone') } as Session;
    const turn: Turn = { id: 't1', sessionId: 's1', index: 0, startedAt: '', endedAt: 'x', stopReason: 'end_turn', startCheckpoint: 'a', endCheckpoint: 'b' };
    const service = new ReceiptService({
      bus,
      record: (_id, e) => recorded.push(e),
      settings: () => ({ enabled: true, notify: true }),
      session: () => session,
      turns: () => [turn],
      receiptEvents: () => [],
      git: {
        changedFiles: () => Promise.reject(new Error('worktree gone')),
        diffPatch: () => Promise.reject(new Error('no')),
        ignoredPaths: () => Promise.reject(new Error('no')),
      },
      audit: () => undefined,
    });
    let seq = 0;
    const emit = (e: object) => bus.emit('session.event', { sessionId: 's1', seq: seq++, ts: '', ...e } as SessionEvent);
    try {
      emit({ type: 'turn.started', turnId: 't1', index: 0 });
      emit({ type: 'agent.message', messageId: 'm', text: 'All tests pass.' });
      expect(() => emit({ type: 'turn.ended', turnId: 't1', stopReason: 'end_turn', usage: null })).not.toThrow();
      await pause(50);
      expect(recorded).toEqual([]);
      expect(errors).toHaveLength(1);
      await service.onChecks('s1', []);
      expect(recorded).toEqual([]);
    } finally {
      console.error = original;
      service.dispose();
    }
  });
});

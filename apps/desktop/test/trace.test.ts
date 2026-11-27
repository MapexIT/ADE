import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceLine } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';

let root: string;
let repo: string;
let host: Host;

const ID = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-trace-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\nkeep\nold line\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
});

afterEach(async () => {
  await host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 45_000): Promise<T> {
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
const ended = (id: string, turns: number) => host.repos.turns.list(id).filter((t) => t.endedAt).length >= turns && host.repos.sessions.require(id).state === 'ready';
async function prompt(id: string, script: string, turns: number) {
  await host.handlers['sessions.prompt']({ sessionId: id, content: text(script) });
  await waitFor(() => ended(id, turns));
}
const show = (lines: TraceLine[]) => lines.map((l) => `${l.side}${l.line}:${l.kind}:${l.turnIndex ?? '-'}`);

describe('RV-17 trace with Git checkpoints and the fake agent', () => {
  it('follows three turns over two files with an undo, a command-written file and a user edit', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: text('edit app.txt alpha\\nbeta\nsay Wrote app.txt.'),
      permissionProfile: 'ask',
      bringChanges: false,
    });
    await waitFor(() => ended(session.id, 1));
    // Turn 2 (index 1) is undone; turn 3 (index 2) rewrites beta and removes a README line; a file appears unreported.
    await prompt(session.id, 'edit app.txt alpha\\nWRONG\nedit README.md # Demo\\nkeep\\nwrong\\n', 2);
    await host.handlers['sessions.undoTurn']({ sessionId: session.id, turnIndex: 1 });
    await prompt(session.id, 'think Beta needs capitals.\nedit app.txt alpha\\nBETA\\ngamma\nedit README.md # Demo\\nkeep\\n\ntouch gen.txt generated\\n\nsay Done.', 3);

    const app = await host.handlers['sessions.trace']({ sessionId: session.id, path: 'app.txt' });
    expect(show(app.lines)).toEqual(['new1:agent:0', 'new2:agent:2', 'new3:agent:2']);
    expect(app.lines[1]!.toolCallId).toBeTruthy();
    expect(app.lines[1]!.toolCallId).not.toBe(app.lines[0]!.toolCallId);

    const readme = await host.handlers['sessions.trace']({ sessionId: session.id, path: 'README.md' });
    expect(show(readme.lines)).toEqual(['old3:agent:2']);

    const gen = await host.handlers['sessions.trace']({ sessionId: session.id, path: 'gen.txt' });
    expect(show(gen.lines)).toEqual(['new1:unreported:2']);

    const detail = await host.handlers['sessions.traceDetail']({ sessionId: session.id, turnIndex: 2, toolCallId: app.lines[1]!.toolCallId });
    expect(detail.prompt).toContain('think Beta needs capitals.');
    expect(detail.toolCall?.title).toBe('Edit app.txt');
    expect(detail.preceding).toEqual({ kind: 'thought', text: 'Beta needs capitals.' });

    // The user edits app.txt in ADE while the agent is idle.
    const worktree = host.repos.sessions.require(session.id).worktreePath!;
    await host.handlers['files.write']({ path: join(worktree, 'app.txt'), content: 'alpha\nBETA\ngamma\nmine\n', expectedMtimeMs: null, sessionId: session.id });
    const edited = await host.handlers['sessions.trace']({ sessionId: session.id, path: 'app.txt' });
    // gamma gained a line break: Git shows it rewritten, and it is still turn 3's line.
    expect(show(edited.lines)).toEqual(['new1:agent:0', 'new2:agent:2', 'new3:agent:2', 'new4:user:-']);

    const byPrompt = await host.handlers['sessions.changesByPrompt']({ sessionId: session.id });
    expect(byPrompt.groups.map((g) => [g.kind, g.turnIndex, g.additions, g.deletions])).toEqual([
      ['turn', 0, 1, 0],
      ['turn', 2, 2, 1],
      ['unreported', null, 1, 0],
      ['user', null, 1, 0],
    ]);
    expect(byPrompt.groups[0]!.prompt).toContain('edit app.txt');
    const files = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: null });
    expect(byPrompt.additions).toBe(files.reduce((n, f) => n + f.additions, 0));
    expect(byPrompt.deletions).toBe(files.reduce((n, f) => n + f.deletions, 0));
  }, 60_000);
});

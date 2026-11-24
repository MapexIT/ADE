import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowRunView } from '@ade/contracts';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';

let root: string;
let repo: string;
let host: Host;

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const ALL_FAKE = { 'claude-code': 'fake', codex: 'fake', opencode: 'fake' } as const;

function makeHost() {
  return createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
  });
}

/** A node script that passes when `file` exists in the working folder. */
const exists = (file: string) => `[node, -e, "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"]`;

function writeWorkflow(name: string, yaml: string) {
  mkdirSync(join(repo, '.ade', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.ade', 'workflows', `${name}.yaml`), yaml);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-wf-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = makeHost();
});

afterEach(async () => {
  await host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const run = (id: string): WorkflowRunView => host.workflows.get(id)!;
const until = (id: string, status: WorkflowRunView['status'], current?: string) =>
  waitFor(() => {
    const r = run(id);
    return r.status === status && (current === undefined || r.current === current) ? r : null;
  });
const node = (r: WorkflowRunView, id: string) => r.nodes.find((n) => n.id === id)!;

const STORY = `
name: Story to pull request (test)
budgets: { loops: 3 }
nodes:
  - { id: plan, type: agent, agent: claude-code, profile: read-only, prompt: "say The plan for {{workItem.title}} is one file." }
  - { id: approve-plan, type: gate, question: "Is the plan right?" }
  - { id: build, type: agent, agent: codex, model: fake-large, profile: auto-edit, prompt: "edit feature.txt built\\nwhichmodel\\nsay Got: {{summary}}" }
  - { id: tests, type: command, run: ${exists('feature.txt')} }
  - { id: retry, type: loop, max: 3 }
  - { id: critique, type: agent, agent: opencode, profile: read-only, prompt: "say Reviewed the change." }
  - { id: review, type: gate, question: "Review the change before the pull request" }
  - { id: open-pr, type: land, mode: pull-request }
edges:
  - { from: plan, to: approve-plan }
  - { from: approve-plan, to: build, when: pass }
  - { from: build, to: tests }
  - { from: tests, to: critique, when: pass }
  - { from: tests, to: retry, when: fail }
  - { from: retry, to: build }
  - { from: critique, to: review }
  - { from: review, to: open-pr, when: pass }
`;

describe('workflow runs with real sessions (M6-T02)', () => {
  it('M6 gate: three agents, stops at both gates, hands off, lands one commit', async () => {
    writeWorkflow('story', STORY);
    const ws = await host.handlers['workspace.open']({ path: repo });
    const base = (await git(['rev-parse', 'HEAD'], { cwd: repo })).trim();
    const started = await host.workflows.start({
      workspaceId: ws.id,
      workflowId: 'repo:story.yaml',
      workItem: { title: 'Dark mode', ref: 'sc-42' },
      agentOverrides: ALL_FAKE,
    });

    // Gate 1.
    let r = await until(started.id, 'waiting-gate', 'approve-plan');
    expect(node(r, 'plan').summary).toBe('The plan for Dark mode is one file.');
    const inbox = host.sessions.inbox();
    expect(inbox.find((i) => i.kind === 'gate' && i.runId === started.id)?.title).toBe('Is the plan right?');
    expect(() =>
      host.handlers['workflows.decideGate']({ runId: started.id, nodeId: 'build', approved: true }),
    ).toThrow('not waiting');
    host.handlers['workflows.decideGate']({ runId: started.id, nodeId: 'approve-plan', approved: true });

    // Gate 2, after build (hand-off), tests and a third agent.
    r = await until(started.id, 'waiting-gate', 'review');
    const sessions = ['plan', 'build', 'critique'].map((id) => node(r, id).sessionId!);
    expect(new Set(sessions).size).toBe(3);
    expect(node(r, 'tests').status).toBe('passed');
    expect(node(r, 'build').attempts).toBe(1);
    const build = host.repos.sessions.require(sessions[1]!);
    const events = host.repos.events.list(build.id);
    expect(events.some((e) => e.type === 'agent.message' && e.text.includes('Model: fake-large'))).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'agent.message' && e.text.includes('Got: The plan for Dark mode is one file.'),
      ),
    ).toBe(true);
    // The third agent starts from the build's end checkpoint, so it sees the built file.
    const critique = host.repos.sessions.require(sessions[2]!);
    expect(readFileSync(join(critique.worktreePath!, 'feature.txt'), 'utf8')).toBe('built');
    // Nothing has landed yet.
    expect((await git(['log', '--oneline', 'main'], { cwd: repo })).trim().split('\n')).toHaveLength(1);

    host.handlers['workflows.decideGate']({ runId: started.id, nodeId: 'review', approved: true });
    r = await until(started.id, 'succeeded');
    expect(node(r, 'open-pr').summary).toContain('push the branch and open the pull request yourself');

    // One commit with every node's work, directly on top of the run's base.
    const landed = host.repos.sessions.require(critique.id);
    expect(landed.state).toBe('landed');
    const parent = (await git(['rev-parse', `${landed.branch}~1`], { cwd: repo })).trim();
    expect(parent).toBe(base);
    expect(
      (await git(['show', '--name-only', '--format=%s', landed.branch!], { cwd: repo })).trim().split('\n'),
    ).toEqual(['Dark mode', '', 'feature.txt']);
    const audit = host.repos.audit.list(ws.id).map((a) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining(['workflow.started', 'workflow.gate.approved', 'workflow.landed']),
    );
  }, 60_000);

  it('a failing check loops back, pauses at the loop limit, and resumes', async () => {
    writeWorkflow(
      'loop',
      `
name: Loop
nodes:
  - { id: build, type: agent, agent: fake, prompt: "say Trying." }
  - { id: tests, type: command, run: ${exists('never.txt')} }
  - { id: retry, type: loop, max: 2 }
  - { id: gate, type: gate }
edges:
  - { from: build, to: tests }
  - { from: tests, to: gate, when: pass }
  - { from: tests, to: retry, when: fail }
  - { from: retry, to: build }
`,
    );
    const ws = await host.handlers['workspace.open']({ path: repo });
    const started = await host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:loop.yaml' });
    let r = await until(started.id, 'paused');
    expect(r.pauseReason).toContain('looped 2 times');
    expect(node(r, 'build').attempts).toBe(3);
    expect(host.sessions.inbox().some((i) => i.kind === 'paused' && i.runId === started.id)).toBe(true);
    const history = host.repos.runs.history(ws.id);
    expect(history.length).toBe(3);
    expect(history[0]!.exitCode).toBe(1);

    host.handlers['workflows.resume']({ runId: started.id });
    r = await waitFor(() => {
      const x = run(started.id);
      return x.status === 'paused' && node(x, 'build').attempts === 5 ? x : null;
    });
    await host.handlers['workflows.cancel']({ runId: started.id });
    expect(run(started.id).status).toBe('cancelled');
    expect(host.sessions.inbox().some((i) => i.runId === started.id)).toBe(false);
  }, 60_000);

  it('fans out to parallel checks, waits at a gate while the cycle goes round once, then pauses (WF-12, WF-13)', async () => {
    writeWorkflow(
      'fan',
      `
name: Fan
nodes:
  - { id: build, type: agent, agent: fake, prompt: "say Built." }
  - { id: a, type: command, run: ${exists('README.md')} }
  - { id: b, type: command, run: ${exists('never.txt')} }
  - { id: review, type: gate, question: "Both checks ran" }
edges:
  - { from: build, to: a }
  - { from: build, to: b }
  - { from: a, to: review }
  - { from: b, to: review, when: pass }
  - { from: b, to: build, when: fail }
`,
    );
    const ws = await host.handlers['workspace.open']({ path: repo });
    const started = await host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:fan.yaml' });
    expect(started.edges.map((e) => e.cycle)).toEqual([false, false, false, false, true]);
    const r = await until(started.id, 'paused');
    expect(r.pauseReason).toBe('The cycle back to build reached its limit of 1 round.');
    expect(node(r, 'build').attempts).toBe(2);
    expect(node(r, 'a').attempts).toBe(2);
    expect(node(r, 'b').attempts).toBe(2);
    expect(r.rounds).toEqual({ '4': 1 });
    // The gate waits for a decision even though the run is paused; both show in the inbox.
    expect(node(r, 'review').status).toBe('waiting');
    const items = host.sessions.inbox().filter((i) => i.runId === started.id);
    expect(items.map((i) => i.kind).sort()).toEqual(['gate', 'paused']);
    await host.handlers['workflows.cancel']({ runId: started.id });
  }, 60_000);

  it('cancelling a run cancels the running agent', async () => {
    writeWorkflow(
      'hang',
      `name: Hang\nnodes:\n  - { id: work, type: agent, agent: fake, prompt: "say Starting.\\nhang" }\n`,
    );
    const ws = await host.handlers['workspace.open']({ path: repo });
    const started = await host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:hang.yaml' });
    const sessionId = await waitFor(() => node(run(started.id), 'work').sessionId);
    await waitFor(() => host.repos.sessions.require(sessionId).state === 'working');
    await host.handlers['workflows.cancel']({ runId: started.id });
    expect(run(started.id).status).toBe('cancelled');
    await waitFor(() =>
      host.repos.events.list(sessionId).some((e) => e.type === 'turn.ended' && e.stopReason === 'cancelled'),
    );
  }, 30_000);

  it('a waiting gate survives a restart; an unknown or invalid workflow is refused', async () => {
    writeWorkflow(
      'gate',
      `name: Gate\nnodes:\n  - { id: hello, type: agent, agent: fake, prompt: "say Hi." }\n  - { id: ok, type: gate }\nedges:\n  - { from: hello, to: ok }\n`,
    );
    writeWorkflow(
      'bad',
      `name: Bad\nnodes:\n  - { id: a, type: agent, agent: fake, prompt: "x" }\n  - { id: ship, type: land, mode: commit }\nedges:\n  - { from: a, to: ship }\n`,
    );
    const ws = await host.handlers['workspace.open']({ path: repo });
    await expect(
      host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:bad.yaml' }),
    ).rejects.toMatchObject({ code: 'invalid_workflow' });
    await expect(
      host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:../escape.yaml' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const started = await host.workflows.start({ workspaceId: ws.id, workflowId: 'repo:gate.yaml' });
    await until(started.id, 'waiting-gate', 'ok');
    await host.dispose();
    host = makeHost();
    expect(run(started.id).status).toBe('waiting-gate');
    expect(host.sessions.inbox().some((i) => i.kind === 'gate' && i.runId === started.id)).toBe(true);
    host.handlers['workflows.decideGate']({ runId: started.id, nodeId: 'ok', approved: true });
    await until(started.id, 'succeeded');
    expect(host.workflows.list(ws.id).map((x) => x.id)).toContain(started.id);
  }, 30_000);

  it('saves an edited workflow as YAML and tests one node on sample input (WF-01, WF-11)', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const tpl = await host.workflows.detail(ws.id, 'template:cross-review');
    const def = tpl.definition as { name: string; nodes: { id: string; prompt?: string }[] };
    def.name = 'My review';
    def.nodes[0]!.prompt = 'Build it carefully';
    const saved = await host.workflows.save(ws.id, 'my-review.yaml', def);
    expect(saved).toMatchObject({ id: 'repo:my-review.yaml', name: 'My review', source: 'repository' });
    expect(readFileSync(join(repo, '.ade', 'workflows', 'my-review.yaml'), 'utf8')).toContain(
      'Build it carefully',
    );
    expect((await host.workflows.detail(ws.id, 'repo:my-review.yaml')).summary.name).toBe('My review');
    // An empty workflow (started from scratch) saves; it only cannot run until it has a first step.
    const empty = await host.workflows.save(ws.id, 'x.yaml', { name: 'x', nodes: [] });
    expect(empty.problems.map((p) => p.message)).toEqual(['This workflow has no steps yet. Add a first step from the palette.']);
    await expect(host.workflows.save(ws.id, 'y.yaml', { name: 'y', nodes: [{ id: 'Bad Id', type: 'gate' }] })).rejects.toMatchObject({
      code: 'invalid_workflow',
    });

    const tested = await host.workflows.testNode({
      workspaceId: ws.id,
      node: { id: 'echo', type: 'agent', agent: 'fake', prompt: 'say Got {{checkOutput}}' },
      sample: { checkOutput: 'three failures' },
      workItem: {},
      agentOverrides: {},
    });
    const done = await until(tested.id, 'succeeded');
    const sessionId = node(done, 'echo').sessionId!;
    expect(
      host.repos.events
        .list(sessionId)
        .some((e) => e.type === 'agent.message' && e.text === 'Got three failures'),
    ).toBe(true);
    await expect(
      host.workflows.testNode({
        workspaceId: ws.id,
        node: { id: 'ship', type: 'land', mode: 'commit' },
        sample: {},
        workItem: {},
        agentOverrides: {},
      }),
    ).rejects.toMatchObject({ code: 'not_testable' });
  }, 30_000);

  it('event triggers start repository workflows only when allowed, and never from their own sessions (WF-10)', async () => {
    writeWorkflow(
      'on-ready',
      `name: Second opinion
trigger: ready-session
nodes:
  - { id: check, type: agent, agent: fake, profile: read-only, prompt: "say Checked: {{summary}}" }
  - { id: ok, type: gate }
edges:
  - { from: check, to: ok }
`,
    );
    writeWorkflow(
      'on-fail',
      `name: Fix it
trigger: failed-check
nodes:
  - { id: fix, type: agent, agent: fake, prompt: "say Fixing: {{checkOutput}}" }
  - { id: ok, type: gate }
edges:
  - { from: fix, to: ok }
`,
    );
    const ws = await host.handlers['workspace.open']({ path: repo });
    const text = (t: string) => [{ type: 'text' as const, text: t }];
    const start = (prompt: string) =>
      host.handlers['sessions.create']({
        workspaceId: ws.id,
        agentId: 'fake',
        prompt: text(prompt),
        permissionProfile: 'auto-edit',
        bringChanges: false,
      });

    // Off by default: a ready session starts nothing.
    const quiet = await start('say Nothing to see.');
    await waitFor(() => host.repos.sessions.require(quiet.id).state === 'ready');
    await new Promise((r) => setTimeout(r, 200));
    expect(host.workflows.list(ws.id)).toHaveLength(0);

    host.repos.settings.set('workflows.autoTriggers', true);
    const session = await start('edit notes.txt hello\nsay Wrote the notes.');
    const triggered = await waitFor(() =>
      host.workflows.list(ws.id).find((r) => r.workflowName === 'Second opinion'),
    );
    const r = await until(triggered.id, 'waiting-gate', 'ok');
    const checker = host.repos.sessions.require(node(r, 'check').sessionId!);
    // The run continues from the session's work, and its own session finishing triggered nothing more.
    expect(readFileSync(join(checker.worktreePath!, 'notes.txt'), 'utf8')).toBe('hello');
    expect(
      host.repos.events
        .list(checker.id)
        .some((e) => e.type === 'agent.message' && e.text === 'Checked: Wrote the notes.'),
    ).toBe(true);
    expect(host.workflows.list(ws.id).filter((x) => x.workflowName === 'Second opinion')).toHaveLength(1);
    expect(
      host.repos.audit.list(ws.id).some((a) => a.action === 'workflow.triggered' && a.actor === 'workflow'),
    ).toBe(true);

    // A failed run starts the failed-check workflow with the output as {{checkOutput}}.
    host.handlers['runs.record']({
      runConfigId: null,
      sessionId: session.id,
      worktreePath: session.worktreePath!,
      command: ['pnpm', 'test'],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 1,
      output: 'boom',
    });
    const fix = await waitFor(() => host.workflows.list(ws.id).find((x) => x.workflowName === 'Fix it'));
    const fr = await until(fix.id, 'waiting-gate', 'ok');
    const fixer = node(fr, 'fix').sessionId!;
    expect(
      host.repos.events
        .list(fixer)
        .some((e) => e.type === 'agent.message' && e.text === 'Fixing: $ pnpm test'),
    ).toBe(true);
  }, 60_000);
});

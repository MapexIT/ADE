import type { CommandBlock } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { compareRuns, fanOutRefusal, planFanOut, problemsText, rowOutcome, runBlock, shortDuration, type CompareRowView } from '../src/renderer/src/lib/fan-out.ts';

const ws = { id: 'w1', rootPath: '/repo' };
let n = 0;
const session = (id: string, patch: Partial<Parameters<typeof planFanOut>[0][number]> = {}) => ({
  id,
  workspaceId: 'w1',
  title: `Session ${id}`,
  agentId: 'fake' as const,
  branch: `ade/${id}`,
  state: 'idle',
  worktreePath: `/wt/${id}`,
  createdAt: `2026-11-27T10:00:${String(n++).padStart(2, '0')}Z`,
  ...patch,
});

describe('planFanOut (SM-21)', () => {
  it('lists the origin as ran here, ticks other live worktrees and leaves the checkout unticked', () => {
    const plan = planFanOut([session('a'), session('b'), session('c')], ws, { sessionId: 'a' });
    expect(plan[0]).toMatchObject({ key: 'a', ranHere: true, defaultTicked: false });
    expect(plan.filter((t) => t.defaultTicked).map((t) => t.key).sort()).toEqual(['b', 'c']);
    expect(plan.at(-1)).toMatchObject({ key: 'checkout', label: 'Your checkout', cwd: '/repo', ranHere: false, defaultTicked: false });
  });

  it('excludes sessions without a live worktree, in-place sessions and other workspaces', () => {
    const plan = planFanOut(
      [session('a'), session('landed', { state: 'landed' }), session('gone', { state: 'discarded' }), session('none', { worktreePath: null }), session('inplace', { inPlace: true }), session('other', { workspaceId: 'w2' })],
      ws,
      { sessionId: null },
    );
    expect(plan.map((t) => t.key)).toEqual(['checkout', 'a']);
    expect(plan[0]?.ranHere).toBe(true);
  });

  it('ticks at most six', () => {
    const plan = planFanOut(Array.from({ length: 9 }, (_, i) => session(`s${i}`)), ws, { sessionId: null });
    expect(plan.filter((t) => t.defaultTicked)).toHaveLength(6);
  });
});

describe('fanOutRefusal', () => {
  it('refuses destructive and multi-line commands and allows a harmless one', () => {
    expect(fanOutRefusal('rm -rf build')).toMatch(/one worktree at a time/);
    expect(fanOutRefusal('git reset --hard HEAD~1')).toMatch(/one worktree at a time/);
    expect(fanOutRefusal('pnpm build\npnpm test')).toBe('Run one command at a time in other worktrees.');
    expect(fanOutRefusal('pnpm test')).toBeNull();
  });
});

const block = (id: string, exitCode: number | null, endedAt: number | null = 41_000): CommandBlock => ({ id, command: 'pnpm test', cwd: null, startedAt: 0, endedAt, exitCode, output: '', truncated: false });
const view = (label: string, outcome: ReturnType<typeof rowOutcome>, ranHere = false, problems = ''): CompareRowView => ({ label, ranHere, outcome, problems });

describe('rowOutcome and compareRuns', () => {
  const idle = { started: true, error: null, stopped: null };

  it('says the result in words', () => {
    expect(rowOutcome(idle, block('b', 0)).text).toBe('Passed');
    expect(rowOutcome(idle, block('b', 1)).text).toBe('Failed · exit 1');
    expect(rowOutcome(idle, block('b', null, null)).text).toBe('Running…');
    expect(rowOutcome({ started: false, error: null, stopped: null }, null).text).toBe('Waiting');
    expect(rowOutcome({ started: true, error: 'fish was not found.', stopped: null }, null).text).toBe('Could not start: fish was not found.');
    expect(rowOutcome({ started: true, error: null, stopped: 'the session ended.' }, null).text).toBe('Stopped: the session ended.');
  });

  it('summarises all passed and mixed results', () => {
    expect(compareRuns('pnpm test', [view('A', rowOutcome(idle, block('a', 0)), true), view('B', rowOutcome(idle, block('b', 0)))]).summary).toBe('2 of 2 passed.');
    expect(compareRuns('pnpm test', [view('Fix login', rowOutcome(idle, block('a', 0)), true), view('Fix login, second try', rowOutcome(idle, block('b', 1)))]).summary).toBe(
      '1 of 2 passed. Fix login, second try failed with exit 1.',
    );
  });

  it('says when runs are still going and when one could not start', () => {
    expect(compareRuns('x', [view('A', rowOutcome(idle, block('a', 0)), true), view('B', rowOutcome(idle, block('b', null, null)))]).summary).toBe('1 of 2 passed so far; 1 still to finish.');
    expect(compareRuns('x', [view('A', rowOutcome(idle, block('a', 0)), true), view('B', rowOutcome({ started: true, error: 'gone', stopped: null }, null))]).summary).toBe('1 of 2 passed. B could not start.');
  });

  it('writes the comparison as a table for the agent', () => {
    const { text } = compareRuns('pnpm test', [view('Fix login', rowOutcome(idle, block('a', 0)), true, 'none'), view('Fix | two', rowOutcome(idle, block('b', 1)), false, '3 · 2 new')]);
    expect(text).toContain('Run in other worktrees: `pnpm test`');
    expect(text).toContain('| Fix login (ran here) | Passed | 41 s | none |');
    expect(text).toContain('| Fix \\| two | Failed · exit 1 | 41 s | 3 · 2 new |');
    expect(text.trim().endsWith('1 of 2 passed. Fix | two failed with exit 1.')).toBe(true);
  });

  it('formats durations and problems', () => {
    expect(shortDuration(800)).toBe('800 ms');
    expect(shortDuration(3210)).toBe('3.2 s');
    expect(shortDuration(41_400)).toBe('41 s');
    const done = rowOutcome(idle, block('b', 1));
    expect(problemsText(null, false, done)).toBe('none');
    expect(problemsText({ total: 3, new: 2 }, true, done)).toBe('3 · 2 new');
    expect(problemsText({ total: 3, new: 2 }, false, done)).toBe('3');
    expect(problemsText({ total: 3, new: 0 }, true, rowOutcome(idle, block('b', null, null)))).toBe('');
  });

  it('finds the run block as the first block typed after the known ones', () => {
    const blocks = [block('old', 0), block('run', null, null)];
    expect(runBlock(blocks, ['old'])?.id).toBe('run');
    expect(runBlock(blocks, ['old', 'run'])).toBeNull();
  });
});

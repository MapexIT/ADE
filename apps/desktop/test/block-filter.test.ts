import { describe, expect, it, vi } from 'vitest';
import {
  changedLines,
  countText,
  errorsMatcher,
  filteredHeading,
  filterInWorker,
  filterLines,
  selectLines,
  shownText,
  splitLines,
  tryFilterLines,
  type WorkerLike,
} from '../src/renderer/src/lib/block-filter.ts';
import { followFilters, previousRun, type FilterState } from '../src/renderer/src/lib/block-filters.ts';
import type { CommandBlock } from '@ade/contracts';

const base = { query: '', regex: false, matchCase: false, invert: false, context: 0 };
const lines = ['alpha', 'Error: one', 'beta', 'gamma', 'delta', 'an error two', 'epsilon', 'zeta', 'eta', 'theta'];

describe('splitLines', () => {
  it('splits CRLF and LF and drops the empty line after a trailing newline', () => {
    expect(splitLines('a\r\nb\nc\r\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual([]);
  });

  it('keeps the last state of a line redrawn with a lone carriage return', () => {
    expect(splitLines('Downloading 10%\rDownloading 50%\rDownloading 100%\r\ndone')).toEqual(['Downloading 100%', 'done']);
  });
});

describe('filterLines', () => {
  it('returns every line for an empty query', () => {
    const r = filterLines(lines, base);
    expect(r.rows).toHaveLength(lines.length);
    expect(r.total).toBe(10);
  });

  it('matches plain text without and with case', () => {
    expect(filterLines(lines, { ...base, query: 'error' }).matched).toBe(2);
    expect(filterLines(lines, { ...base, query: 'error', matchCase: true }).rows.map((r) => r.n)).toEqual([6]);
  });

  it('treats a plain query with regex characters and backslashes literally', () => {
    const paths = ['C:\\repo\\src\\a.ts(1,1)', 'other'];
    expect(filterLines(paths, { ...base, query: 'C:\\repo\\src' }).rows.map((r) => r.n)).toEqual([1]);
    expect(filterLines(paths, { ...base, query: '(1,1)' }).matched).toBe(1);
  });

  it('records highlight ranges and original line numbers', () => {
    const r = filterLines(lines, { ...base, query: 'error' });
    expect(r.rows[0]).toMatchObject({ n: 2, hit: true, ranges: [[0, 5]], gapBefore: true });
    expect(r.rows[1]).toMatchObject({ n: 6, ranges: [[3, 8]] });
  });

  it('hides matching lines when inverted', () => {
    const r = filterLines(lines, { ...base, query: 'error', invert: true });
    expect(r.matched).toBe(8);
    expect(r.rows.every((row) => row.ranges.length === 0)).toBe(true);
    expect(r.rows.map((row) => row.n)).not.toContain(2);
  });

  it('adds context lines, merges overlapping ranges and marks gaps', () => {
    const one = filterLines(lines, { ...base, query: 'error', context: 1 });
    expect(one.rows.map((r) => [r.n, r.hit, r.gapBefore])).toEqual([
      [1, false, false],
      [2, true, false],
      [3, false, false],
      [5, false, true],
      [6, true, false],
      [7, false, false],
    ]);
    const wide = filterLines(lines, { ...base, query: 'error', context: 3 });
    const ns = wide.rows.map((r) => r.n);
    expect(new Set(ns).size).toBe(ns.length);
    expect(ns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(wide.rows.some((r) => r.gapBefore)).toBe(false);
  });

  it('caps context at nine lines', () => {
    expect(filterLines(lines, { ...base, query: 'theta', context: 50 }).rows).toHaveLength(10);
  });

  it('matches regular expressions and reports an invalid one', () => {
    expect(filterLines(lines, { ...base, query: '^(alpha|beta)$', regex: true }).matched).toBe(2);
    expect(tryFilterLines(lines, { ...base, query: '([', regex: true })).toEqual({ error: 'invalid' });
    expect(filterLines(lines, { ...base, query: '^', regex: true }).matched).toBe(10);
  });

  it('counts and describes the result', () => {
    const r = filterLines(Array.from({ length: 3120 }, (_, i) => (i < 42 ? 'error' : 'ok')), { ...base, query: 'error' });
    expect(countText(r)).toBe('42 of 3,120 lines');
    expect(filteredHeading('pnpm build', r, 'error')).toBe('Filtered output of `pnpm build`: 42 of 3,120 lines, filter: error');
  });

  it('writes the shown lines with a marker where lines were skipped', () => {
    const r = filterLines(lines, { ...base, query: 'error' });
    expect(shownText(r.rows)).toBe('…\nError: one\n…\nan error two');
  });
});

describe('changedLines', () => {
  it('ignores differences in numbers only', () => {
    expect([...changedLines(['done in 41 s', 'ok'], ['done in 38 s', 'ok'])]).toEqual([]);
  });

  it('returns nothing for identical runs and finds a changed line', () => {
    expect(changedLines(lines, lines).size).toBe(0);
    const next = [...lines];
    next[4] = 'delta changed';
    expect([...changedLines(next, lines)]).toEqual([4]);
  });

  it('respects duplicates as a multiset', () => {
    expect([...changedLines(['x', 'x', 'y'], ['x', 'y'])]).toEqual([1]);
  });

  it('selects changed lines through selectLines', () => {
    const changed = changedLines(['a', 'b', 'c'], ['a', 'c']);
    const r = selectLines(['a', 'b', 'c'], (_l, i) => (changed.has(i) ? [] : null), { invert: false, context: 0 });
    expect(r.rows.map((x) => x.text)).toEqual(['b']);
    expect(r.matched).toBe(1);
  });
});

describe('the errors and warnings preset', () => {
  const pick = (out: string) => selectLines(splitLines(out), errorsMatcher, { invert: false, context: 0 }).rows.map((r) => r.text);

  it('finds tsc, pytest and cargo problems', () => {
    expect(pick('src/a.ts(1,1): error TS2322: Type mismatch.\nFound 1 error.')).toHaveLength(2);
    expect(pick('tests/test_a.py::test_x FAILED\n=== 1 failed, 3 passed in 0.12s ===\nTraceback (most recent call last):')).toHaveLength(3);
    expect(pick('warning: unused variable `x`\nerror[E0425]: cannot find value\nthread main panicked at src/main.rs')).toHaveLength(3);
  });

  it('keeps a clean log empty', () => {
    expect(pick('Compiling demo v0.1.0\nFinished dev profile in 2.1s\nall tests passed')).toEqual([]);
    expect(pick('terrorist mirror')).toEqual([]);
  });
});

class StubWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  constructor(private readonly answer: boolean) {}
  postMessage(message: unknown) {
    if (!this.answer) return;
    const { lines: l, opts } = message as { lines: string[]; opts: typeof base };
    queueMicrotask(() => this.onmessage?.({ data: tryFilterLines(l, opts) }));
  }
  terminate() {
    this.terminated = true;
  }
}

describe('filterInWorker', () => {
  it('resolves with the worker answer and terminates it', async () => {
    const w = new StubWorker(true);
    const r = await filterInWorker(() => w, { lines, opts: { ...base, query: 'err', regex: true } });
    expect(r.error).toBeUndefined();
    expect(w.terminated).toBe(true);
  });

  it('stops a worker that does not answer within the budget', async () => {
    vi.useFakeTimers();
    try {
      const w = new StubWorker(false);
      const p = filterInWorker(() => w, { lines, opts: { ...base, query: '(a+)+$', regex: true } }, 250);
      vi.advanceTimersByTime(260);
      expect(await p).toEqual({ error: 'slow' });
      expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

const block = (id: string, command: string, endedAt: number | null = 1, output = ''): CommandBlock => ({ id, command, cwd: null, startedAt: 0, endedAt, exitCode: 0, output, truncated: false });

describe('filters follow the command', () => {
  const filter: FilterState = { terminalId: 't1', commandKey: 'pnpm build', blockId: 'b1', query: 'error', regex: false, matchCase: false, invert: false, context: 0, preset: null, focusNonce: 0 };

  it('moves to the latest finished run of the same command', () => {
    const blocks = [block('b1', 'pnpm build'), block('b2', 'ls'), block('b3', 'pnpm  build'), block('b4', 'pnpm build', null)];
    const next = followFilters({ k: filter }, 't1', blocks);
    expect(next.k?.blockId).toBe('b3');
  });

  it('returns the same object when nothing moved', () => {
    const byCommand = { k: filter };
    expect(followFilters(byCommand, 't1', [block('b1', 'pnpm build')])).toBe(byCommand);
    expect(followFilters(byCommand, 't2', [block('b9', 'pnpm build')])).toBe(byCommand);
  });

  it('finds the previous run for "Changed since last run"', () => {
    const blocks = [block('b1', 'pnpm build'), block('b2', 'ls'), block('b3', 'pnpm build')];
    expect(previousRun(blocks, blocks[2]!)?.id).toBe('b1');
    expect(previousRun(blocks, blocks[0]!)).toBeNull();
  });
});

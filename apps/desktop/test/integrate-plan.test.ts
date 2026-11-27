import { describe, expect, it } from 'vitest';
import { briefing, checkVerdict, classifyFit, defaultOrder, sharedPaths, staleness } from '../src/host/integrate-plan.ts';

describe('PL-06 matrix cells', () => {
  it('reads conflicts first, then shared files, then fits', () => {
    expect(classifyFit(['b.txt', 'a.txt'], ['a.txt', 'b.txt', 'c.txt'])).toEqual({ fit: 'conflicts', files: ['a.txt', 'b.txt'] });
    expect(classifyFit([], ['c.txt', 'a.txt'])).toEqual({ fit: 'same-files', files: ['a.txt', 'c.txt'] });
    expect(classifyFit([], [])).toEqual({ fit: 'fits', files: [] });
  });

  it('finds the paths both change sets touch', () => {
    expect(sharedPaths(['a', 'b', 'c'], ['c', 'd', 'a', 'a'])).toEqual(['a', 'c']);
    expect(sharedPaths([], ['a'])).toEqual([]);
  });
});

describe('PL-06 default order', () => {
  it('puts the fewest changed lines first, then the title, then the id', () => {
    const items = [
      { sessionId: '3', title: 'Big', additions: 50, deletions: 10 },
      { sessionId: '2', title: 'Beta', additions: 1, deletions: 1 },
      { sessionId: '1', title: 'Alpha', additions: 2, deletions: 0 },
      { sessionId: '0', title: 'Alpha', additions: 0, deletions: 2 },
    ];
    expect(defaultOrder(items).map((i) => i.sessionId)).toEqual(['0', '1', '2', '3']);
    expect(items[0]!.sessionId).toBe('3'); // the input is left alone
  });
});

describe('PL-06 staleness', () => {
  const trial = { head: 'h1', members: [{ sessionId: 'a', checkpoint: 'c1' }, { sessionId: 'b', checkpoint: 'c2' }] };
  const now = (over: Partial<Record<'a' | 'b', { checkpoint: string | null; ended: boolean; title: string } | undefined>> = {}, head = 'h1') => ({
    head,
    members: { a: { checkpoint: 'c1', ended: false, title: 'A' }, b: { checkpoint: 'c2', ended: false, title: 'B' }, ...over },
  });

  it('is current while nothing moved', () => {
    expect(staleness(trial, now())).toBeNull();
  });

  it('is out of date after a new checkpoint, an ended or missing session, or a moved checkout', () => {
    expect(staleness(trial, now({ b: { checkpoint: 'c3', ended: false, title: 'B' } }))).toBe('"B" changed since the trial.');
    expect(staleness(trial, now({ a: { checkpoint: 'c1', ended: true, title: 'A' } }))).toBe('"A" has ended.');
    expect(staleness(trial, now({ a: undefined }))).toBe('A session in this trial no longer exists.');
    expect(staleness(trial, now({}, 'h2'))).toBe('Your checkout moved to another commit.');
  });

  it('ignores sessions this trial already landed', () => {
    expect(staleness({ ...trial, landed: ['a'] }, now({ a: { checkpoint: 'c1', ended: true, title: 'A' } }))).toBeNull();
  });
});

describe('PL-06 check verdicts', () => {
  it('passes when the combination passes, whatever happened alone', () => {
    expect(checkVerdict(0, ['failed', 'not-run'])).toBe('passes');
  });

  it('says "passed alone, fails together" only when every session passed alone', () => {
    expect(checkVerdict(1, ['passed', 'passed'])).toBe('passed-alone-fails-together');
    expect(checkVerdict(null, ['passed'])).toBe('passed-alone-fails-together');
  });

  it('is a plain failure when any session failed or never ran the check alone', () => {
    expect(checkVerdict(1, ['passed', 'not-run'])).toBe('fails');
    expect(checkVerdict(1, ['passed', 'failed'])).toBe('fails');
    expect(checkVerdict(1, [])).toBe('fails');
  });
});

describe('PL-06 briefing', () => {
  const before = [{ title: 'Add login', files: ['a.txt', 'auth.ts'], lastMessage: 'I added the login form.' }];

  it('lists the conflicted files, the order and what the earlier sessions changed', () => {
    const text = briefing({ order: ['Add login', 'Rename user'], position: 1, before, onto: 'abcdef1234567890', conflicts: ['a.txt'], failed: [] });
    expect(text).toContain('1. Add login, 2. Rename user. You are number 2.');
    expect(text).toContain('commit abcdef123456');
    expect(text).toContain('conflict markers (<<<<<<<, =======, >>>>>>>): a.txt.');
    expect(text).toContain('- "Add login" changed a.txt, auth.ts.');
    expect(text).toContain('Its last message: I added the login form.');
  });

  it('carries the failing checks with their output for "fails together"', () => {
    const text = briefing({ order: ['A', 'B'], position: 1, before, onto: 'abc', conflicts: [], failed: [{ name: 'npm test', output: 'boom\n' }] });
    expect(text).toContain('Each change passed its checks alone, but together these fail:');
    expect(text).toContain('- npm test:\n```\nboom\n```');
  });

  it('shortens long messages and file lists', () => {
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const text = briefing({ order: ['A', 'B'], position: 1, before: [{ title: 'A', files, lastMessage: 'x'.repeat(2000) }], onto: 'abc', conflicts: [], failed: [] });
    expect(text).toContain('and 10 more');
    expect(text).toContain(`${'x'.repeat(1500)}…`);
  });
});

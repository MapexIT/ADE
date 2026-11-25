import type { ReviewState } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { landWarning, nextUnreviewed, receiptLandWarning } from '../src/renderer/src/lib/review.ts';

const states = (entries: Record<string, ReviewState>) => new Map(Object.entries(entries));

describe('RV-15 next unreviewed file', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('moves forward and wraps round, skipping reviewed files', () => {
    const s = states({ a: 'unreviewed', b: 'reviewed', c: 'changed', d: 'reviewed' });
    expect(nextUnreviewed(order, s, 'a')).toBe('c');
    expect(nextUnreviewed(order, s, 'c')).toBe('a');
    expect(nextUnreviewed(order, s, 'd')).toBe('a');
    expect(nextUnreviewed(order, s, null)).toBe('a');
  });

  it('counts a file with no state as not reviewed', () => {
    expect(nextUnreviewed(order, states({ a: 'reviewed', b: 'reviewed' }), 'a')).toBe('c');
  });

  it('returns null when every other file is reviewed', () => {
    const s = states({ a: 'reviewed', b: 'reviewed', c: 'reviewed', d: 'reviewed' });
    expect(nextUnreviewed(order, s, 'b')).toBeNull();
    expect(nextUnreviewed(order, states({ a: 'unreviewed', b: 'reviewed', c: 'reviewed', d: 'reviewed' }), 'a')).toBeNull();
    expect(nextUnreviewed([], s, null)).toBeNull();
  });
});

describe('RV-15 land warning', () => {
  it('says nothing when every selected file is reviewed', () => {
    expect(landWarning(['a', 'b'], states({ a: 'reviewed', b: 'reviewed', c: 'unreviewed' }))).toBe('');
    expect(landWarning([], states({}))).toBe('');
  });

  it('names one unreviewed file', () => {
    expect(landWarning(['a'], states({ a: 'changed' }))).toBe('The selected file is not marked as reviewed: a.');
    expect(landWarning(['a', 'b', 'c'], states({ a: 'reviewed', b: 'reviewed' }))).toBe('1 of the 3 selected files is not marked as reviewed: c.');
  });

  it('names several, capped at five', () => {
    expect(landWarning(['a.ts', 'b.ts', 'c.ts'], states({ c: 'reviewed', 'c.ts': 'reviewed' }))).toBe('2 of the 3 selected files are not marked as reviewed: a.ts, b.ts.');
    const many = ['1', '2', '3', '4', '5', '6', '7'];
    expect(landWarning(many, states({}))).toBe('7 of the 7 selected files are not marked as reviewed: 1, 2, 3, 4, 5 and 2 more.');
  });
});

describe('RV-16 receipt land warning', () => {
  const item = (turnIndex: number, text: string) => ({ turnIndex, text });

  it('says nothing without open items, names one, and the first three of five', () => {
    expect(receiptLandWarning([])).toBe('');
    expect(receiptLandWarning([item(0, 'Says the tests pass. ADE saw no test command in this turn.')])).toBe(
      "The agent's receipts still have 1 thing to check: Turn 1: Says the tests pass. ADE saw no test command in this turn.",
    );
    const five = [item(0, 'A.'), item(0, 'Reported an edit that Git does not see: b.txt'), item(1, 'C.'), item(1, 'D.'), item(2, 'E.')];
    expect(receiptLandWarning(five)).toBe(
      "The agent's receipts still have 5 things to check: Turn 1: A. Turn 1: Reported an edit that Git does not see: b.txt. Turn 2: C. And 2 more.",
    );
  });
});

import { describe, expect, it } from 'vitest';
import { clampShare, parseShare, shareFromPointer } from '../src/renderer/src/lib/split.ts';

const limits = { minStart: 300, minEnd: 200 };

describe('split pane maths', () => {
  it('keeps both panes at least their minimum width', () => {
    expect(clampShare(0.42, 1000, limits)).toBeCloseTo(0.42);
    expect(clampShare(0.05, 1000, limits)).toBeCloseTo(0.2); // end pane >= 200px
    expect(clampShare(0.95, 1000, limits)).toBeCloseTo(0.7); // start pane >= 300px
  });

  it('shares a too-small container in proportion to the minimums', () => {
    expect(clampShare(0.9, 400, limits)).toBeCloseTo(0.4);
  });

  it('turns a pointer position into the end pane share', () => {
    expect(shareFromPointer(600, 1000, limits)).toBeCloseTo(0.4);
    expect(shareFromPointer(990, 1000, limits)).toBeCloseTo(0.2);
    expect(shareFromPointer(10, 1000, limits)).toBeCloseTo(0.7);
    expect(shareFromPointer(10, 0, limits)).toBe(0.5);
  });

  it('reads a stored share, falling back on anything unusable', () => {
    expect(parseShare('0.3', 0.42)).toBe(0.3);
    expect(parseShare(null, 0.42)).toBe(0.42);
    expect(parseShare('abc', 0.42)).toBe(0.42);
    expect(parseShare('1.5', 0.42)).toBe(0.42);
    expect(parseShare('0', 0.42)).toBe(0.42);
  });
});

import { describe, expect, it } from 'vitest';
import type { PromptBox } from '@ade/contracts';
import { boardExtent, boardPrompt, BOX_H, BOX_W, boxesInRect, freeSlot, moveBox, newBox, overlaps, readingOrder, rectFromPoints, resizeBox, selectByBand } from '../src/renderer/src/lib/prompt-board.ts';

const box = (id: string, x: number, y: number, extra: Partial<PromptBox> = {}): PromptBox => ({ id, title: '', text: id, x, y, w: BOX_W, h: BOX_H, selected: true, ...extra });

describe('GN-02 prompt board', () => {
  it('places a new box in the first free slot, left to right, then down', () => {
    expect(freeSlot([], 1000)).toEqual({ x: 16, y: 16 });
    const first = newBox([], 1000, 'a');
    expect(freeSlot([first], 1000)).toEqual({ x: 16 + BOX_W + 16, y: 16 });
    // Narrow boards wrap to the next row.
    expect(freeSlot([first], 400)).toEqual({ x: 16, y: 16 + BOX_H + 16 });
    expect(first.selected).toBe(true);
  });

  it('snaps moves and sizes to the grid and keeps boxes on the board', () => {
    expect(moveBox(box('a', 0, 0), 13, -40)).toMatchObject({ x: 16, y: 0 });
    expect(resizeBox(box('a', 0, 0), 10, 5000)).toMatchObject({ w: 160, h: 4000 });
  });

  it('reads boxes top to bottom, and left to right within a row', () => {
    const boxes = [box('c', 400, 210), box('b', 400, 20), box('a', 16, 30), box('d', 16, 220)];
    expect(readingOrder(boxes).map((b) => b.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('builds the prompt from selected, non-empty boxes, with titles as headings', () => {
    const boxes = [
      box('goal', 16, 16, { title: 'Goal', text: 'Fix the parser.' }),
      box('skip', 320, 16, { selected: false, text: 'Not this' }),
      box('blank', 16, 200, { text: '   ' }),
      box('rules', 320, 200, { text: 'Add a test.' }),
    ];
    expect(boardPrompt(boxes)).toBe('## Goal\nFix the parser.\n\nAdd a test.');
    expect(boardPrompt([])).toBe('');
  });

  it('grows the board to fit every box', () => {
    expect(boardExtent([], 500, 300)).toEqual({ w: 500, h: 300 });
    expect(boardExtent([box('a', 600, 400)], 500, 300)).toEqual({ w: 600 + BOX_W + 16, h: 400 + BOX_H + 16 });
  });

  it('normalises a rubber band dragged in any direction', () => {
    expect(rectFromPoints({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(rectFromPoints({ x: 50, y: 20 }, { x: 10, y: 80 })).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });

  it('finds the boxes a rubber band touches, partly or wholly, but not by an edge alone', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(overlaps(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(overlaps(a, { x: 10, y: 10, w: 10, h: 10 })).toBe(true);
    expect(overlaps(a, { x: 100, y: 0, w: 10, h: 10 })).toBe(false);
    expect(overlaps(a, { x: 0, y: 200, w: 10, h: 10 })).toBe(false);
    const boxes = [box('a', 16, 16), box('b', 320, 16), box('c', 16, 200)];
    expect([...boxesInRect(boxes, rectFromPoints({ x: 0, y: 0 }, { x: 330, y: 30 }))].sort()).toEqual(['a', 'b']);
    expect(boxesInRect(boxes, { x: 1000, y: 1000, w: 50, h: 50 }).size).toBe(0);
  });

  it('replaces the selection with a rubber band, adds to it when additive, and keeps it when the band hits nothing', () => {
    const boxes = [box('a', 16, 16), box('b', 320, 16, { selected: false }), box('c', 16, 200, { selected: false })];
    const ids = (bs: PromptBox[]) => bs.filter((b) => b.selected).map((b) => b.id);
    expect(ids(selectByBand(boxes, new Set(['b']), false))).toEqual(['b']);
    expect(ids(selectByBand(boxes, new Set(['b']), true))).toEqual(['a', 'b']);
    expect(selectByBand(boxes, new Set(), false)).toBe(boxes);
    // Unchanged boxes keep their identity.
    expect(selectByBand(boxes, new Set(['a']), true)[0]).toBe(boxes[0]);
  });
});

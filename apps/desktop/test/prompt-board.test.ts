import { describe, expect, it } from 'vitest';
import type { PromptBox } from '@ade/contracts';
import { boardExtent, boardPrompt, BOX_H, BOX_W, freeSlot, moveBox, newBox, readingOrder, resizeBox } from '../src/renderer/src/lib/prompt-board.ts';

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
});

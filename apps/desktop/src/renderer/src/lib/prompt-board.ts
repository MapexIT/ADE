import type { PromptBox } from '@ade/contracts';

/** Boxes snap to this grid when moved or resized. */
export const GRID = 8;
export const BOX_W = 280;
export const BOX_H = 168;
export const MIN_W = 160;
export const MIN_H = 96;
const GAP = 16;
/** Boxes whose tops are this close count as one row when reading the board. */
const ROW_TOLERANCE = 32;

export const snap = (n: number) => Math.round(n / GRID) * GRID;

function overlaps(a: Pick<PromptBox, 'x' | 'y' | 'w' | 'h'>, b: Pick<PromptBox, 'x' | 'y' | 'w' | 'h'>) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The first free slot, scanning a grid of default-sized cells left to right, then down, inside `width`. */
export function freeSlot(boxes: PromptBox[], width: number): { x: number; y: number } {
  const cols = Math.max(1, Math.floor((Math.max(width, BOX_W + 2 * GAP) - GAP) / (BOX_W + GAP)));
  for (let row = 0; row < 200; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = { x: GAP + col * (BOX_W + GAP), y: GAP + row * (BOX_H + GAP), w: BOX_W, h: BOX_H };
      if (!boxes.some((b) => overlaps(cell, b))) return { x: cell.x, y: cell.y };
    }
  }
  return { x: GAP, y: GAP };
}

export function newBox(boxes: PromptBox[], width: number, id: string): PromptBox {
  return { id, title: '', text: '', ...freeSlot(boxes, width), w: BOX_W, h: BOX_H, selected: true };
}

/** Moves a box, snapped to the grid and kept on the board (left and top edges at 0). */
export function moveBox(box: PromptBox, x: number, y: number): PromptBox {
  return { ...box, x: Math.max(0, snap(x)), y: Math.max(0, snap(y)) };
}

export function resizeBox(box: PromptBox, w: number, h: number): PromptBox {
  return { ...box, w: Math.min(4000, Math.max(MIN_W, snap(w))), h: Math.min(4000, Math.max(MIN_H, snap(h))) };
}

/** Top to bottom; boxes on roughly the same row go left to right. */
export function readingOrder(boxes: PromptBox[]): PromptBox[] {
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PromptBox[][] = [];
  for (const b of byTop) {
    const row = rows.at(-1);
    if (row && b.y - row[0]!.y <= ROW_TOLERANCE) row.push(b);
    else rows.push([b]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

/** The prompt the selected boxes make: in reading order, a titled box under a heading, empty boxes left out. */
export function boardPrompt(boxes: PromptBox[]): string {
  return readingOrder(boxes.filter((b) => b.selected && b.text.trim()))
    .map((b) => (b.title.trim() ? `## ${b.title.trim()}\n${b.text.trim()}` : b.text.trim()))
    .join('\n\n');
}

/** The board's size: big enough for every box plus a margin, never smaller than the view. */
export function boardExtent(boxes: PromptBox[], minW: number, minH: number) {
  return {
    w: Math.max(minW, ...boxes.map((b) => b.x + b.w + GAP)),
    h: Math.max(minH, ...boxes.map((b) => b.y + b.h + GAP)),
  };
}

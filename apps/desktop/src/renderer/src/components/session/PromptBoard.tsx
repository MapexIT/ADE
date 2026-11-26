import { GripVertical, Plus, SquareCheck, SquareDashed, Trash2 } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { PromptBox } from '@ade/contracts';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useComposer } from '../../lib/composer.ts';
import { boardExtent, boardPrompt, boxesInRect, GRID, moveBox, newBox, readingOrder, rectFromPoints, resizeBox, selectByBand } from '../../lib/prompt-board.ts';

const EMPTY_BOXES: PromptBox[] = [];

type Drag = { id: string; kind: 'move' | 'resize'; startX: number; startY: number; box: PromptBox };
type Point = { x: number; y: number };
/** A rubber band in board coordinates. `client` is the last pointer position, so scrolling can move the band's end. */
type Band = { start: Point; end: Point; client: Point; additive: boolean; moved: boolean };
/** A press on empty board space becomes a rubber band once the pointer has moved this far. */
const BAND_THRESHOLD = 4;

/**
 * GN-02: the prompt as a board of text boxes. Boxes can be placed and sized freely; the selected ones, read top to
 * bottom and left to right, are the prompt's input. The board belongs to the workspace: every session there shares
 * it, and placement, size, content and selection are saved across restarts.
 */
export function PromptBoard({ workspaceId }: { workspaceId: string }) {
  const boxes = useComposer((c) => c.boards[workspaceId] ?? EMPTY_BOXES);
  const updateBoard = useComposer((c) => c.updateBoard);
  const loadBoard = useComposer((c) => c.loadBoard);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [band, setBand] = useState<Band | null>(null);

  useEffect(() => {
    void loadBoard(workspaceId);
  }, [workspaceId, loadBoard]);

  const setBoxes = (change: (b: PromptBox[]) => PromptBox[]) => updateBoard(workspaceId, change);
  const patch = (id: string, change: (b: PromptBox) => PromptBox) => setBoxes((all) => all.map((b) => (b.id === id ? change(b) : b)));

  const add = () => {
    const box = newBox(boxes, viewport.current?.clientWidth ?? 600, crypto.randomUUID());
    setBoxes((all) => [...all, box]);
    // Focus the new box's text once it is rendered, and bring it into view.
    requestAnimationFrame(() => {
      const ta = document.getElementById(`box-text-${box.id}`) as HTMLTextAreaElement | null;
      ta?.focus();
      ta?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, box: PromptBox, kind: Drag['kind']) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: box.id, kind, startX: e.clientX, startY: e.clientY, box });
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    patch(drag.id, () => (drag.kind === 'move' ? moveBox(drag.box, drag.box.x + dx, drag.box.y + dy) : resizeBox(drag.box, drag.box.w + dx, drag.box.h + dy)));
  };
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(null);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, box: PromptBox, kind: Drag['kind']) => {
    const step = e.shiftKey ? GRID * 4 : GRID;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    patch(box.id, (b) => (kind === 'move' ? moveBox(b, b.x + d[0]!, b.y + d[1]!) : resizeBox(b, b.w + d[0]!, b.h + d[1]!)));
  };

  // Rubber-band selection, like a desktop: press on empty board space and drag. Boxes the band touches are selected
  // on release; a plain drag replaces the selection, Ctrl or Shift adds to it. A click without a drag, or a band that
  // touches nothing, leaves the selection alone.
  const toBoard = (client: Point): Point => {
    const r = canvas.current?.getBoundingClientRect();
    return r ? { x: client.x - r.left, y: client.y - r.top } : client;
  };
  const onBoardPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const client = { x: e.clientX, y: e.clientY };
    const start = toBoard(client);
    setBand({ start, end: start, client, additive: e.ctrlKey || e.shiftKey || e.metaKey, moved: false });
  };
  const onBoardPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!band) return;
    const client = { x: e.clientX, y: e.clientY };
    // Dragging past the edge of the view scrolls the board, so a band can reach boxes out of sight.
    const v = viewport.current;
    if (v) {
      const r = v.getBoundingClientRect();
      const clamp = (n: number) => Math.max(-24, Math.min(24, n));
      const dx = client.x < r.left ? client.x - r.left : client.x > r.right ? client.x - r.right : 0;
      const dy = client.y < r.top ? client.y - r.top : client.y > r.bottom ? client.y - r.bottom : 0;
      if (dx || dy) v.scrollBy(clamp(dx), clamp(dy));
    }
    const end = toBoard(client);
    const moved = band.moved || Math.hypot(end.x - band.start.x, end.y - band.start.y) >= BAND_THRESHOLD;
    setBand({ ...band, end, client, moved });
  };
  const onBoardPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!band) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (band.moved && e.type === 'pointerup') {
      const rect = rectFromPoints(band.start, toBoard({ x: e.clientX, y: e.clientY }));
      setBoxes((all) => selectByBand(all, boxesInRect(all, rect), band.additive));
    }
    setBand(null);
  };
  // Scrolling while banding (the wheel, or the edge scroll above) keeps the band's end under the pointer.
  const onViewportScroll = () => {
    if (band) setBand({ ...band, end: toBoard(band.client) });
  };

  const selected = boxes.filter((b) => b.selected);
  const chars = boardPrompt(boxes).length;
  // The board fills the view (CSS) and grows to fit the boxes; it is never measured, so it cannot feed back.
  const extent = boardExtent(boxes, 0, 0);
  const allSelected = boxes.length > 0 && selected.length === boxes.length;
  const order = new Map(readingOrder(selected).map((b, i) => [b.id, i + 1]));
  const bandRect = band?.moved ? rectFromPoints(band.start, band.end) : null;
  const banded = bandRect ? boxesInRect(boxes, bandRect) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="dense" onClick={add} icon={<Plus className="size-4" aria-hidden="true" />}>
          Add text box
        </Button>
        <Button
          size="dense"
          variant="ghost"
          disabled={!boxes.length}
          onClick={() => setBoxes((all) => all.map((b) => ({ ...b, selected: !allSelected })))}
          icon={allSelected ? <SquareDashed className="size-4" aria-hidden="true" /> : <SquareCheck className="size-4" aria-hidden="true" />}
        >
          {allSelected ? 'Clear selection' : 'Select all'}
        </Button>
        <span className="ml-auto text-[12px] text-ink-muted" aria-live="polite">
          Shared by this workspace&apos;s sessions · {selected.length} of {boxes.length} box{boxes.length === 1 ? '' : 'es'} in the prompt · {chars.toLocaleString('en-GB')} characters
        </span>
      </div>
      <div
        ref={viewport}
        role="region"
        aria-label="Prompt board"
        onScroll={onViewportScroll}
        className="relative h-56 min-h-40 resize-y overflow-auto rounded-[var(--radius)] border border-line bg-bg [background-image:radial-gradient(var(--color-line)_1px,transparent_1px)] [background-size:16px_16px]"
      >
        <div
          ref={canvas}
          className="relative min-h-full min-w-full"
          style={{ width: extent.w, height: extent.h }}
          onPointerDown={onBoardPointerDown}
          onPointerMove={onBoardPointerMove}
          onPointerUp={onBoardPointerUp}
          onPointerCancel={onBoardPointerUp}
        >
          {boxes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-ink-muted">
              Add text boxes for the parts of your prompt, such as the goal, the context and the constraints. Selected boxes are sent together, read top to bottom and left to right. Click a box&apos;s header to include it, or drag across the board to select several.
            </div>
          ) : null}
          {boxes.map((b) => {
            const name = b.title.trim() || 'Untitled box';
            return (
              <section
                key={b.id}
                aria-label={`Text box: ${name}`}
                className={cx(
                  'absolute flex flex-col overflow-hidden rounded-[var(--radius)] border bg-surface shadow-[var(--shadow-pop)]',
                  b.selected ? 'border-accent' : 'border-line opacity-80',
                  banded?.has(b.id) && 'opacity-100 outline-2 outline-offset-2 outline-accent',
                  drag?.id === b.id && 'z-10',
                )}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              >
                <div
                  className={cx(
                    'relative flex items-center gap-1 border-b px-1 py-0.5 transition-colors duration-[var(--motion)] ease-[var(--ease)] motion-reduce:transition-none',
                    b.selected ? 'border-accent bg-accent text-bg' : 'border-line bg-surface-raised text-ink-muted',
                  )}
                >
                  {/* The whole header toggles the box in or out of the prompt. It is a button under the header's other
                      controls, so a click on any free part of the header lands on it, and it is one Tab stop. */}
                  <button
                    type="button"
                    aria-pressed={b.selected}
                    aria-label={`Include ${name} in the prompt`}
                    title={b.selected ? 'In the prompt. Click to leave it out' : 'Click to include in the prompt'}
                    onClick={() => patch(b.id, (x) => ({ ...x, selected: !x.selected }))}
                    className={cx(
                      'absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2',
                      b.selected ? 'focus-visible:outline-ink' : 'hover:bg-line focus-visible:outline-accent',
                    )}
                  />
                  <button
                    type="button"
                    aria-label={`Move ${name}. Arrow keys move it; hold Shift for bigger steps.`}
                    title="Drag to move"
                    className={cx(
                      'relative flex min-h-7 min-w-7 cursor-grab touch-none items-center justify-center rounded focus-visible:outline-2 active:cursor-grabbing',
                      b.selected ? 'hover:bg-accent-soft focus-visible:outline-ink' : 'hover:text-ink focus-visible:outline-accent',
                    )}
                    onPointerDown={(e) => onPointerDown(e, b, 'move')}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onKeyDown={(e) => onKey(e, b, 'move')}
                  >
                    <GripVertical className="size-4" aria-hidden="true" />
                  </button>
                  {order.has(b.id) ? (
                    <span className="pointer-events-none relative min-w-4 text-center text-[11px] font-semibold" title="Position in the prompt">
                      {order.get(b.id)}
                    </span>
                  ) : null}
                  {/* Sized to its text, so the rest of the header stays free to click. */}
                  <input
                    value={b.title}
                    onChange={(e) => patch(b.id, (x) => ({ ...x, title: e.target.value.slice(0, 200) }))}
                    placeholder="Title (optional)"
                    aria-label={`Title of ${name}`}
                    className={cx(
                      'relative min-w-12 max-w-full shrink rounded bg-transparent px-1 text-[12px] font-semibold [field-sizing:content] placeholder:font-normal focus:bg-bg focus:text-ink focus:outline-none focus:placeholder:text-ink-muted',
                      b.selected ? 'text-bg placeholder:text-bg' : 'text-ink placeholder:text-ink-muted',
                    )}
                  />
                  <button
                    type="button"
                    aria-label={`Delete ${name}`}
                    title="Delete"
                    onClick={() => setBoxes((all) => all.filter((x) => x.id !== b.id))}
                    className={cx(
                      'relative ml-auto flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded focus-visible:outline-2',
                      b.selected ? 'hover:bg-accent-soft focus-visible:outline-ink' : 'hover:text-ink focus-visible:outline-accent',
                    )}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <textarea
                  id={`box-text-${b.id}`}
                  value={b.text}
                  onChange={(e) => patch(b.id, (x) => ({ ...x, text: e.target.value }))}
                  placeholder="Write part of the prompt…"
                  aria-label={`Text of ${name}`}
                  className="min-h-0 flex-1 resize-none bg-transparent p-2 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none"
                />
                <button
                  type="button"
                  aria-label={`Resize ${name}. Arrow keys change its size.`}
                  title="Drag to resize"
                  className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none bg-[linear-gradient(135deg,transparent_50%,var(--color-line-strong)_50%)] focus-visible:outline-2 focus-visible:outline-accent"
                  onPointerDown={(e) => onPointerDown(e, b, 'resize')}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  onKeyDown={(e) => onKey(e, b, 'resize')}
                />
              </section>
            );
          })}
          {bandRect ? (
            <div
              aria-hidden="true"
              data-testid="prompt-board-band"
              className="pointer-events-none absolute z-20 rounded-[2px] border border-accent bg-accent/15"
              style={{ left: bandRect.x, top: bandRect.y, width: bandRect.w, height: bandRect.h }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

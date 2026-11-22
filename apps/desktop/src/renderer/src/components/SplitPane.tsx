import { cx } from '@ade/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { clampShare, parseShare, shareFromPointer, type SplitLimits } from '../lib/split.ts';

const STEP = 0.02;

function readShare(key: string, fallback: number): number {
  try {
    return parseShare(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function writeShare(key: string, share: number) {
  try {
    localStorage.setItem(key, share.toFixed(4));
  } catch {
    // Storage can be unavailable; the split then lasts until the window closes.
  }
}

/**
 * Two panes side by side with a draggable divider (WAI-ARIA window splitter). The end pane's share of the width
 * is remembered per `storageKey`. Arrow keys move the divider, Home and End go to the limits, and a double-click
 * restores the default. When the container is too narrow for both panes, only the start pane is shown.
 */
export function SplitPane({
  start,
  end,
  storageKey,
  defaultShare = 0.42,
  minStart = 280,
  minEnd = 220,
  label,
  className,
}: {
  start: ReactNode;
  end: ReactNode;
  storageKey: string;
  defaultShare?: number;
  minStart?: number;
  minEnd?: number;
  /** The divider's accessible name, e.g. "Resize command blocks". */
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startId = useId();
  const limits: SplitLimits = { minStart, minEnd };
  const [share, setShare] = useState(() => readShare(storageKey, defaultShare));
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While dragging, the whole window shows the resize cursor and text is not selected.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  const showEnd = width === 0 || width >= minStart + minEnd;
  const shown = clampShare(share, width, limits);
  const commit = (next: number) => {
    const clamped = clampShare(next, width, limits);
    setShare(clamped);
    writeShare(storageKey, clamped);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    setShare(shareFromPointer(e.clientX - box.left, box.width, limits));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    commit(share);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The value is the start pane's share: Left makes it smaller, Right larger.
    if (e.key === 'ArrowLeft') commit(shown + STEP);
    else if (e.key === 'ArrowRight') commit(shown - STEP);
    else if (e.key === 'Home') commit(1);
    else if (e.key === 'End') commit(0);
    else if (e.key === 'Enter') commit(defaultShare);
    else return;
    e.preventDefault();
  };

  const startPct = Math.round((1 - shown) * 100);
  return (
    <div ref={ref} className={cx('flex min-h-0 min-w-0 flex-1', className)}>
      <div id={startId} className="min-h-0 min-w-0 flex-1">
        {start}
      </div>
      {showEnd ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-controls={startId}
            aria-valuenow={startPct}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => commit(defaultShare)}
            onKeyDown={onKeyDown}
            className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none"
          >
            <span
              aria-hidden="true"
              className={cx(
                'absolute inset-y-0 left-1/2 -translate-x-1/2 transition-[width,background-color] duration-150',
                dragging ? 'w-0.5 bg-accent' : 'w-px bg-line group-hover:w-0.5 group-hover:bg-accent-soft group-focus-visible:w-0.5 group-focus-visible:bg-accent',
              )}
            />
          </div>
          <div className="min-h-0 shrink-0" style={{ width: `${shown * 100}%` }}>
            {end}
          </div>
        </>
      ) : null}
    </div>
  );
}

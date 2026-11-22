/** Limits for a two-pane split, in pixels of the container. */
export interface SplitLimits {
  /** Smallest width either pane may have. */
  minStart: number;
  minEnd: number;
}

/**
 * The end pane's share of the container (0..1), kept so both panes stay at least their minimum width. When the
 * container is too small for both minimums, the space is shared in proportion to them.
 */
export function clampShare(share: number, container: number, limits: SplitLimits): number {
  if (!Number.isFinite(share)) share = 0.5;
  if (container <= 0) return Math.min(1, Math.max(0, share));
  const { minStart, minEnd } = limits;
  if (minStart + minEnd >= container) return minEnd / (minStart + minEnd);
  const lo = minEnd / container;
  const hi = 1 - minStart / container;
  return Math.min(hi, Math.max(lo, share));
}

/** The end pane's share after dragging the divider to `x` pixels from the container's left edge. */
export function shareFromPointer(x: number, container: number, limits: SplitLimits): number {
  if (container <= 0) return 0.5;
  return clampShare((container - x) / container, container, limits);
}

/** Reads a stored share; anything unusable falls back to the default. */
export function parseShare(raw: string | null, fallback: number): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
}

import type { GitCommit } from '@ade/contracts';

/** One row of the drawn graph: where the commit's dot sits and which lines cross the row. */
export interface GraphRow {
  commit: GitCommit;
  lane: number;
  /** Lines from the top edge to the bottom edge, straight down (other branches passing by). */
  through: number[];
  /** Lines from a lane at the top edge into the dot (children that converge here). */
  into: number[];
  /** Lines from the dot to a lane at the bottom edge (one per parent that is drawn). */
  out: number[];
  /** True when nothing above leads into the dot: a branch tip. */
  tip: boolean;
}

/**
 * Lays commits (newest first, topological order) out in lanes, the way `git log --graph` does: each lane waits for
 * one commit; a commit takes the lane waiting for it (or the first free one), its first parent continues in that
 * lane, and other parents get a lane of their own unless one already waits for them. Lanes stay put, so lines that
 * pass by are straight. Parents outside the loaded range keep a line to the bottom. Pure.
 */
export function layoutGraph(commits: GitCommit[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  for (const commit of commits) {
    const before = [...lanes];
    let lane = before.indexOf(commit.hash);
    const tip = lane === -1;
    if (tip) lane = free();
    const into = before.flatMap((h, i) => (h === commit.hash ? [i] : []));
    const through = before.flatMap((h, i) => (h !== null && h !== commit.hash ? [i] : []));
    // Every lane that waited for this commit is done.
    for (const i of into) lanes[i] = null;
    const out: number[] = [];
    commit.parents.forEach((p, n) => {
      if (n === 0) {
        lanes[lane] = p;
        out.push(lane);
        return;
      }
      const waiting = lanes.indexOf(p);
      if (waiting !== -1) out.push(waiting);
      else {
        const slot = free();
        lanes[slot] = p;
        out.push(slot);
      }
    });
    if (!commit.parents.length) lanes[lane] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lane + 1, ...through.map((i) => i + 1), ...out.map((i) => i + 1));
    rows.push({ commit, lane, through, into, out, tip });
  }
  return { rows, width };
}

/** Relative time in UK English, e.g. "3 hours ago". */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  const units: [number, string][] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** The canvas layout for workflow graphs (WF-01, WF-18), kept free of React so it can be unit-tested. */

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** WF-17: this edge closes a cycle. */
  cycle?: boolean | undefined;
}

/**
 * WF-18: the steps a run starts with: every step nothing leads into except connections that close a cycle (the same
 * rule as the engine's `startNodes`, given edges marked with `cycle`); the first step when none qualifies.
 */
export function startIds(nodes: LayoutNode[], edges: LayoutEdge[]): Set<string> {
  const led = new Set(edges.filter((e) => !e.cycle).map((e) => e.to));
  const starts = nodes.filter((n) => !led.has(n.id));
  return new Set((starts.length ? starts : nodes.slice(0, 1)).map((n) => n.id));
}

/**
 * Layered left-to-right layout over the forward connections (cycle edges left out): every start sits in column 0
 * and each other step one column after the furthest step that leads into it, so a join comes after all its inputs.
 */
export function columns(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, number> {
  const depth = new Map<string, number>();
  const ids = new Set(nodes.map((n) => n.id));
  const forward = edges.filter((e) => !e.cycle && ids.has(e.from) && ids.has(e.to));
  const waiting = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of forward) waiting.set(e.to, waiting.get(e.to)! + 1);
  const queue = [...startIds(nodes, edges)].filter((id) => waiting.get(id) === 0);
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of forward.filter((x) => x.from === id)) {
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, depth.get(id)! + 1));
      waiting.set(e.to, waiting.get(e.to)! - 1);
      if (waiting.get(e.to) === 0) queue.push(e.to);
    }
  }
  // Steps on a loop of forward edges (not expected once cycles are marked) go after the last column, still visible.
  const last = Math.max(-1, ...depth.values()) + 1;
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, last);
  return depth;
}

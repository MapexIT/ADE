import { describe, expect, it } from 'vitest';
import {
  columns,
  startIds,
  type LayoutEdge as GraphEdge,
  type LayoutNode as GraphNode,
} from '../src/renderer/src/lib/workflow-layout.ts';

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));
const col = (ns: GraphNode[], es: GraphEdge[]) => Object.fromEntries(columns(ns, es));

describe('workflow canvas layout (WF-01, WF-18)', () => {
  it('puts every start in column 0 and a join after the furthest of its inputs', () => {
    const ns = nodes('a', 'a2', 'b', 'join');
    const es: GraphEdge[] = [
      { from: 'a', to: 'a2' },
      { from: 'a2', to: 'join' },
      { from: 'b', to: 'join' },
    ];
    expect([...startIds(ns, es)]).toEqual(['a', 'b']);
    expect(col(ns, es)).toEqual({ a: 0, b: 0, a2: 1, join: 2 });
  });

  it('ignores connections that close a cycle, so the first step of a retry cycle is a start', () => {
    const ns = nodes('lint', 'fix', 'check', 'join');
    const es: GraphEdge[] = [
      { from: 'lint', to: 'join' },
      { from: 'fix', to: 'check' },
      { from: 'check', to: 'fix', cycle: true },
      { from: 'check', to: 'join' },
    ];
    expect([...startIds(ns, es)]).toEqual(['lint', 'fix']);
    expect(col(ns, es)).toEqual({ lint: 0, fix: 0, check: 1, join: 2 });
  });

  it('falls back to the first step when every step has an input', () => {
    const ns = nodes('a', 'b');
    const es: GraphEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect([...startIds(ns, es)]).toEqual(['a']);
    expect(col(ns, es)).toEqual({ a: 0, b: 0 });
  });
});

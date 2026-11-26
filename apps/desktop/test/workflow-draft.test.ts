import { parseWorkflow, TEMPLATES } from '@ade/workflow-engine';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  canStartHere,
  connect,
  cycleEdge,
  fileNameFor,
  isStart,
  makeStart,
  problemsOf,
  removeEdge,
  removeNode,
  toDraft,
  updateNode,
} from '../src/renderer/src/lib/workflow-draft.ts';

const base = () => parseWorkflow(TEMPLATES['cross-review']!);

describe('workflow drafts (WF-01)', () => {
  it('adds nodes with unique ids and defaults that validate', () => {
    let wf = base();
    const a = addNode(wf, 'gate');
    const b = addNode(a.wf, 'gate');
    expect([a.id, b.id]).toEqual(['gate-2', 'gate-3']);
    wf = connect(connect(b.wf, 'gate', 'gate-2'), 'gate-2', 'gate-3');
    expect(problemsOf(wf).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('renaming a node rewires its edges; removing it drops them', () => {
    const wf = base();
    const build = wf.nodes.find((n) => n.id === 'build')!;
    const renamed = updateNode(wf, 'build', { ...build, id: 'implement' });
    expect(renamed.edges[0]).toMatchObject({ from: 'implement', to: 'review' });
    const removed = removeNode(renamed, 'review');
    expect(removed.edges).toEqual([]);
    expect(removed.nodes.map((n) => n.id)).toEqual(['implement', 'gate']);
  });

  it('connects once, never to itself, cycles conditions and removes edges', () => {
    let wf = base();
    expect(connect(wf, 'build', 'build')).toBe(wf);
    expect(connect(wf, 'build', 'review')).toBe(wf);
    wf = cycleEdge(wf, 0);
    expect(wf.edges[0]!.when).toBe('pass');
    wf = cycleEdge(wf, 0);
    expect(wf.edges[0]!.when).toBe('fail');
    wf = cycleEdge(wf, 0);
    expect(wf.edges[0]).not.toHaveProperty('when');
    expect(removeEdge(wf, 0).edges).toHaveLength(1);
  });

  it('reports a land without a gate, and moving a node first makes it the start', () => {
    let wf = addNode(base(), 'land').wf;
    wf = connect(wf, 'review', 'land');
    expect(problemsOf(wf).some((p) => p.level === 'error')).toBe(true);
    expect(makeStart(wf, 'gate').nodes[0]!.id).toBe('gate');
  });

  it('a run starts at every step nothing leads into; "Start here" only applies on a cycle no start leads into (WF-18)', () => {
    let wf = toDraft({ name: 'x', nodes: [{ id: 'a', type: 'gate' }, { id: 'b', type: 'gate' }, { id: 'c', type: 'gate' }] })!;
    expect(['a', 'b', 'c'].map((id) => isStart(wf, id))).toEqual([true, true, true]);
    wf = connect(connect(wf, 'a', 'c'), 'b', 'c');
    expect(['a', 'b', 'c'].map((id) => isStart(wf, id))).toEqual([true, true, false]);
    // c waits for a and b: listing it first cannot make it a start.
    expect(canStartHere(wf, 'c')).toBe(false);
    expect(canStartHere(wf, 'a')).toBe(false);
    // A ring with no way in: the step listed first is where the run enters, and any other step can take its place.
    const ring = connect(connect(toDraft({ name: 'r', nodes: [{ id: 'x', type: 'gate' }, { id: 'y', type: 'gate' }] })!, 'x', 'y'), 'y', 'x');
    expect(isStart(ring, 'x')).toBe(true);
    expect(canStartHere(ring, 'y')).toBe(true);
    expect(isStart(makeStart(ring, 'y'), 'y')).toBe(true);
  });

  it('reads definitions and names files', () => {
    expect(toDraft({ name: 'x' })).toMatchObject({ name: 'x', nodes: [], edges: [] });
    expect(toDraft({ nodes: 'nope' })).toBeNull();
    expect(toDraft({ name: 'x', nodes: [{ id: 'a', type: 'gate' }] })?.nodes[0]).toMatchObject({
      question: 'Review before continuing',
    });
    expect(fileNameFor('Story to PR!')).toBe('story-to-pr.yaml');
    expect(fileNameFor('***')).toBe('workflow.yaml');
  });
});

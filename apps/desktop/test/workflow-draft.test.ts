import { parseWorkflow, TEMPLATES } from '@ade/workflow-engine';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  cycleEdge,
  fileNameFor,
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

  it('reads definitions and names files', () => {
    expect(toDraft({ name: 'x' })).toBeNull();
    expect(toDraft({ name: 'x', nodes: [{ id: 'a', type: 'gate' }] })?.nodes[0]).toMatchObject({
      question: 'Review before continuing',
    });
    expect(fileNameFor('Story to PR!')).toBe('story-to-pr.yaml');
    expect(fileNameFor('***')).toBe('workflow.yaml');
  });
});

import { describe, expect, it } from 'vitest';
import { PANELS, placePanel } from '../src/renderer/src/lib/layout.ts';

const openSet =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

describe('panel placement', () => {
  it('puts the editor as a tab beside the session when it is open', () => {
    expect(placePanel('editor', openSet('session', 'sessions'))).toEqual({
      id: 'editor',
      component: 'editor',
      title: 'Editor',
      position: { referencePanel: 'session', direction: 'within' },
    });
  });

  it('falls back to another open panel when the session panel is closed', () => {
    expect(placePanel('editor', openSet('inspector', 'terminal')).position).toEqual({
      referencePanel: 'inspector',
      direction: 'left',
    });
    expect(placePanel('session', openSet('terminal')).position).toEqual({
      referencePanel: 'terminal',
      direction: 'above',
    });
  });

  it('fills the empty dock when every panel is closed, instead of naming a missing reference', () => {
    for (const p of PANELS) {
      const opts = placePanel(p.id, openSet());
      expect(opts).not.toHaveProperty('position');
      expect(opts).not.toHaveProperty('initialWidth');
    }
  });

  it('never refers to the panel being added', () => {
    for (const p of PANELS) expect(p.places.every((x) => x.ref !== p.id)).toBe(true);
  });

  it('keeps split sizes only for splits', () => {
    expect(placePanel('sessions', openSet('session'))).toMatchObject({ initialWidth: 280 });
    expect(placePanel('terminal', openSet('session'))).toMatchObject({ initialHeight: 240 });
  });
});

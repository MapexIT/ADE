import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFeatures, searchFeatures, shippedAreas, tabFor } from '../src/renderer/src/lib/help.ts';

const doc = readFileSync(join(__dirname, '../../../docs/FEATURES.md'), 'utf8');

describe('help centre content', () => {
  const areas = parseFeatures(doc);

  it('reads every feature of docs/FEATURES.md', () => {
    const count = Number(/(\d+) features in/.exec(doc)?.[1]);
    expect(areas.flatMap((a) => a.features)).toHaveLength(count);
    expect(areas.map((a) => a.title)).toContain('Start a session');
    expect(areas.find((a) => a.title === 'Agent workflows and skills')?.prefixes).toEqual(['WF', 'SK']);
  });

  it('lists only shipped features', () => {
    const shipped = shippedAreas(areas).flatMap((a) => a.features);
    expect(shipped.some((f) => f.phase === 'Later')).toBe(false);
    expect(shipped.find((f) => f.id === 'TM-04')?.name).toBe('Agent command terminals');
  });

  it('searches every word across ID, name and description', () => {
    expect(searchFeatures(areas, 'reject note').map((f) => f.id)).toEqual(['AP-03']);
    expect(searchFeatures(areas, 'tm-01').map((f) => f.id)).toEqual(['TM-01']);
    expect(searchFeatures(areas, '')).toHaveLength(areas.flatMap((a) => a.features).length);
  });

  it('knows where each area lives in the app', () => {
    expect(tabFor('RV-01')).toBe('review');
    expect(tabFor('CO-01')).toBe('work-items');
    expect(tabFor('PK-01')).toBeUndefined();
  });
});

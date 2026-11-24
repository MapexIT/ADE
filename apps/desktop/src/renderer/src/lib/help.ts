import type { Tab } from './store.ts';

/** One feature from docs/FEATURES.md, as the help centre shows it. */
export interface HelpFeature {
  id: string;
  name: string;
  phase: 'MVP' | 'v1' | 'Later';
  description: string;
  area: string;
}

export interface HelpArea {
  /** The area title from the document, e.g. "Start a session". */
  title: string;
  /** The ID prefixes the area covers, e.g. ["ST"]. */
  prefixes: string[];
  features: HelpFeature[];
}

/** Where each feature prefix lives in the app, so the help centre can take the user there. */
export const PREFIX_TAB: Record<string, Tab | undefined> = {
  ST: 'sessions',
  WA: 'sessions',
  SR: 'sessions',
  GN: 'sessions',
  CN: 'sessions',
  AP: 'sessions',
  RV: 'review',
  PL: 'sessions',
  TM: 'terminals',
  SM: 'terminals',
  CR: 'run',
  CO: 'work-items',
  WF: 'workflows',
  SK: 'skills',
  ED: 'sessions',
};

/**
 * Parses the feature tables of docs/FEATURES.md: every `## Title (XX)` heading starts an area and every
 * `| XX-00 | Name | Phase | Description |` row is a feature. Pure, so it is unit tested against the real file.
 */
export function parseFeatures(markdown: string): HelpArea[] {
  const areas: HelpArea[] = [];
  let current: HelpArea | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const prefixes = [...heading[1]!.matchAll(/\(([A-Z]{2})\)/g)].map((m) => m[1]!);
      const title = heading[1]!.replace(/\s*\([A-Z]{2}\)/g, '').trim();
      current = { title, prefixes, features: [] };
      areas.push(current);
      continue;
    }
    const row = /^\|\s*([A-Z]{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*(MVP|v1|Later)\s*\|\s*(.*?)\s*\|\s*$/.exec(
      line,
    );
    if (row && current) {
      current.features.push({
        id: row[1]!,
        name: row[2]!,
        phase: row[3] as HelpFeature['phase'],
        description: row[4]!.replace(/`/g, '') === '-' ? '' : row[4]!.replace(/`/g, ''),
        area: current.title,
      });
    }
  }
  return areas.filter((a) => a.features.length);
}

/** What the help centre lists: features ADE ships (MVP and v1). "Later" items are not built yet. */
export function shippedAreas(areas: HelpArea[]): HelpArea[] {
  return areas
    .map((a) => ({ ...a, features: a.features.filter((f) => f.phase !== 'Later') }))
    .filter((a) => a.features.length);
}

/** Case-insensitive match on ID, name, description and area; every word of the query must match. */
export function searchFeatures(areas: HelpArea[], query: string): HelpFeature[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = areas.flatMap((a) => a.features);
  if (!words.length) return all;
  return all.filter((f) => {
    const text = `${f.id} ${f.name} ${f.description} ${f.area}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Features that live on a different page from the rest of their area. */
const ID_TAB: Record<string, Tab> = { 'WA-07': 'observe', 'WA-08': 'observe', 'WA-09': 'observe', 'HI-09': 'git' };

export const tabFor = (id: string): Tab | undefined => ID_TAB[id] ?? PREFIX_TAB[id.slice(0, 2)];

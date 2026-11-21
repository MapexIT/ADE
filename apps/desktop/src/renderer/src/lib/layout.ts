import type { AddPanelOptions, DockviewApi } from 'dockview-react';

/** The panels of the sessions workspace. Each can be closed and shown again. */
export type PanelId = 'sessions' | 'session' | 'inspector' | 'terminal' | 'editor';

type Direction = 'left' | 'right' | 'above' | 'below' | 'within';

interface PanelSpec {
  id: PanelId;
  title: string;
  /** Where the panel goes, tried in order against the panels that are open. The first that exists wins. */
  places: { ref: PanelId; direction: Direction }[];
  size?: { initialWidth?: number; initialHeight?: number };
}

export const PANELS: readonly PanelSpec[] = [
  {
    id: 'session',
    title: 'Session',
    places: [
      { ref: 'editor', direction: 'within' },
      { ref: 'sessions', direction: 'right' },
      { ref: 'inspector', direction: 'left' },
      { ref: 'terminal', direction: 'above' },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions',
    places: [
      { ref: 'session', direction: 'left' },
      { ref: 'editor', direction: 'left' },
      { ref: 'inspector', direction: 'left' },
      { ref: 'terminal', direction: 'above' },
    ],
    size: { initialWidth: 280 },
  },
  {
    id: 'inspector',
    title: 'Inspector',
    places: [
      { ref: 'session', direction: 'right' },
      { ref: 'editor', direction: 'right' },
      { ref: 'sessions', direction: 'right' },
      { ref: 'terminal', direction: 'above' },
    ],
    size: { initialWidth: 320 },
  },
  {
    id: 'terminal',
    title: 'Terminal',
    places: [
      { ref: 'session', direction: 'below' },
      { ref: 'editor', direction: 'below' },
      { ref: 'sessions', direction: 'right' },
      { ref: 'inspector', direction: 'left' },
    ],
    size: { initialHeight: 240 },
  },
  {
    id: 'editor',
    title: 'Editor',
    places: [
      { ref: 'session', direction: 'within' },
      { ref: 'sessions', direction: 'right' },
      { ref: 'inspector', direction: 'left' },
      { ref: 'terminal', direction: 'above' },
    ],
  },
];

export const panelSpec = (id: PanelId) => PANELS.find((p) => p.id === id)!;

/**
 * The options that add a panel next to whatever is still open. A layout with none of its reference panels
 * (all closed) gets the panel on its own, filling the dock. Pure, so it is unit tested.
 */
export function placePanel(id: PanelId, open: (id: string) => boolean): AddPanelOptions {
  const spec = panelSpec(id);
  const place = spec.places.find((p) => open(p.ref));
  return {
    id,
    component: id,
    title: spec.title,
    ...(place ? { position: { referencePanel: place.ref, direction: place.direction } } : {}),
    // A size only makes sense for a split, not for a tab in an existing group or a lone panel.
    ...(place && place.direction !== 'within' ? spec.size : {}),
  };
}

/** Shows a panel: focuses it when open, otherwise adds it back in a sensible place. */
export function showPanel(api: DockviewApi, id: PanelId) {
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel(placePanel(id, (ref) => !!api.getPanel(ref)));
}

export function closePanel(api: DockviewApi, id: PanelId) {
  api.getPanel(id)?.api.close();
}

/** The layout ADE starts with. */
export function defaultLayout(api: DockviewApi) {
  api.clear();
  for (const id of ['session', 'sessions', 'inspector', 'terminal'] as const) showPanel(api, id);
}

/** The live workspace, registered by the sessions workspace so menus and commands can reach it. */
let current: DockviewApi | null = null;
const listeners = new Set<() => void>();

export const workspaceLayout = {
  attach(api: DockviewApi | null) {
    current = api;
    listeners.forEach((l) => l());
  },
  get api() {
    return current;
  },
  /** Called whenever panels open or close, for menus that show which are open. */
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  changed() {
    listeners.forEach((l) => l());
  },
};

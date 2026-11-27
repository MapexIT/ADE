import { useTerminals } from './terminals.ts';

/**
 * SM-19, SM-20, SM-21: Ctrl+Shift+M (watch), Ctrl+Shift+L (filter) and Ctrl+Shift+E (run in other worktrees). They
 * act on the active terminal: the watch control, or the focused block (else the latest finished one). The visible
 * button is clicked, so a shortcut does exactly what the button does, from the terminal or from its blocks.
 */
export type TerminalShortcut = 'watch' | 'filter' | 'compare';

export const TERMINAL_SHORTCUTS: Record<TerminalShortcut, { keys: string; title: string }> = {
  watch: { keys: 'Ctrl Shift M', title: 'Watch the command in the active terminal' },
  filter: { keys: 'Ctrl Shift L', title: "Filter a block's output" },
  compare: { keys: 'Ctrl Shift E', title: 'Run a block in other worktrees' },
};

const KEYS: Record<string, TerminalShortcut> = { m: 'watch', l: 'filter', e: 'compare' };

/** The terminal shortcut a key event is, if any. xterm must not see these (Ctrl+M would press Enter). */
export function terminalShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'key'>): TerminalShortcut | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return null;
  return KEYS[e.key.toLowerCase()] ?? null;
}

const visible = (el: Element) => el.getClientRects().length > 0;

/** Clicks the matching button for the active terminal. Returns false when there is nothing to act on. */
export function runTerminalShortcut(action: TerminalShortcut): boolean {
  const id = useTerminals.getState().active;
  if (!id) return false;
  const esc = CSS.escape(id);
  if (action === 'watch') {
    const button = [...document.querySelectorAll<HTMLButtonElement>(`button[data-watch-for="${esc}"]`)].find((b) => visible(b) && !b.disabled);
    button?.click();
    return !!button;
  }
  const list = [...document.querySelectorAll(`[data-blocks-for="${esc}"]`)].find(visible);
  if (!list) return false;
  const selector = `button[data-action="${action}"]`;
  const sections = [...list.querySelectorAll<HTMLElement>('section[data-block-id]')].filter((s) => s.querySelector(selector));
  const active = document.activeElement;
  const target = sections.find((s) => active && s.contains(active)) ?? sections.find((s) => s.hasAttribute('data-focused')) ?? sections.at(-1);
  const button = target?.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

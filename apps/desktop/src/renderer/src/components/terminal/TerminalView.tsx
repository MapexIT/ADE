import { FitAddon } from '@xterm/addon-fit';
import { palette } from '@ade/ui';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { pty } from '../../lib/bridge.ts';
import { useStore } from '../../lib/store.ts';
import { destructiveReason, isMultiLinePaste } from '../../lib/terminal-intel.ts';
import { scrollback, subscribeData } from '../../lib/terminals.ts';

// Terminal output stays inside black, white and violet: every ANSI hue maps onto them.
const THEME = {
  background: palette.surfaceSunken,
  foreground: '#e4e4e7',
  cursor: palette.accent,
  cursorAccent: palette.surfaceSunken,
  selectionBackground: '#3b2a63',
  black: palette.surfaceSunken,
  brightBlack: palette.inkFaint,
  red: palette.white,
  brightRed: palette.white,
  green: palette.accentSoft,
  brightGreen: palette.accentSoft,
  yellow: palette.attention,
  brightYellow: palette.attention,
  blue: palette.accent,
  brightBlue: palette.accentSoft,
  magenta: palette.accent,
  brightMagenta: palette.accentSoft,
  cyan: palette.inkMuted,
  brightCyan: palette.ink,
  white: '#e4e4e7',
  brightWhite: palette.white,
};

/** TM-01: one xterm per pty, WebGL when available, with search and resize. */
export function TerminalView({ id, autoFocus }: { id: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [search, setSearch] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      theme: THEME,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    searchRef.current = searchAddon;
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.open(el);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // Falls back to the DOM renderer.
    }
    const replay = scrollback(id);
    if (replay) term.write(replay);
    const off = subscribeData(id, (d) => term.write(d));
    const input = term.onData((data) => void pty.call('pty.write', { id, data }));
    let confirmed = false;
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        setSearch('');
        return false;
      }
      // SM-14: Enter on a destructive command line asks first. The line is read from the terminal buffer.
      if (e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey && !confirmed) {
        const buf = term.buffer.active;
        const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '';
        const why = destructiveReason(line);
        if (why) {
          useStore.getState().ask({
            title: 'Run a destructive command?',
            body: `This command ${why}:\n${line.trim().slice(0, 300)}`,
            confirmLabel: 'Run it',
            danger: true,
            onConfirm: () => {
              confirmed = true;
              void pty.call('pty.write', { id, data: '\r' });
              setTimeout(() => (confirmed = false), 0);
              term.focus();
            },
          });
          return false;
        }
      }
      return true;
    });
    // SM-14: a multi-line paste asks before it runs several commands at once.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!isMultiLinePaste(text)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useStore.getState().ask({
        title: 'Paste several lines?',
        body: `Pasting ${text.trim().split(/\r?\n/).length} lines may run each one as a command:\n${text.slice(0, 400)}`,
        confirmLabel: 'Paste',
        onConfirm: () => {
          term.paste(text);
          term.focus();
        },
      });
    };
    el.addEventListener('paste', onPaste, true);
    const resize = () => {
      try {
        fit.fit();
        void pty.call('pty.resize', { id, cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) });
      } catch {
        // not visible yet
      }
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    resize();
    if (autoFocus) term.focus();
    return () => {
      el.removeEventListener('paste', onPaste, true);
      ro.disconnect();
      off();
      input.dispose();
      term.dispose();
    };
  }, [id, autoFocus]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface-sunken">
      {search !== null ? (
        <div className="absolute top-1 right-2 z-10 flex items-center gap-1 rounded-[var(--radius-small)] border border-line bg-surface p-1">
          <label htmlFor={`search-${id}`} className="sr-only">
            Search the terminal
          </label>
          <input
            id={`search-${id}`}
            autoFocus
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              searchRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') searchRef.current?.[e.shiftKey ? 'findPrevious' : 'findNext'](search);
              if (e.key === 'Escape') setSearch(null);
            }}
            placeholder="Search"
            className="min-h-8 w-48 rounded border border-line bg-bg px-2 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
          />
          <button type="button" className="min-h-8 min-w-8 rounded text-ink-muted hover:text-ink" aria-label="Close search" onClick={() => setSearch(null)}>
            ×
          </button>
        </div>
      ) : null}
      <div ref={ref} className="min-h-0 flex-1" />
    </div>
  );
}

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { pty } from '../../lib/bridge.ts';
import { useStore } from '../../lib/store.ts';
import { destructiveReason, isMultiLinePaste } from '../../lib/terminal-intel.ts';
import { scrollback, subscribeData } from '../../lib/terminals.ts';

const THEME = {
  background: '#0B0E13',
  foreground: '#D7DEE8',
  cursor: '#7FA6F5',
  selectionBackground: '#1E2A40',
  black: '#0B0E13',
  brightBlack: '#5C6878',
  blue: '#7FA6F5',
  brightBlue: '#B7CDFB',
  red: '#FF9B9B',
  brightRed: '#FF9B9B',
  yellow: '#FFB86B',
  brightYellow: '#FFB86B',
  // Keep terminal output inside the three-hue palette: green maps to the accent.
  green: '#B7CDFB',
  brightGreen: '#B7CDFB',
  cyan: '#9AA7B6',
  brightCyan: '#E6EAF0',
  magenta: '#B7CDFB',
  brightMagenta: '#B7CDFB',
  white: '#D7DEE8',
  brightWhite: '#FFFFFF',
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

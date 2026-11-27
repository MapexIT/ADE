import type { TerminalInfo, WatchFired } from '@ade/contracts';
import { watchNotificationText, watchReasonText } from '@ade/shell-integration/watch';
import { host, main, pty } from './bridge.ts';
import { useStore } from './store.ts';
import { onWatchFired, useTerminals } from './terminals.ts';
import { AUTO_WATCH_SETTING, autoWatchTargets } from './auto-watch.ts';

export { AUTO_WATCH_SETTING };

const TITLES: Record<WatchFired['reason'], string> = {
  finished: 'A command finished',
  failed: 'A command failed',
  quiet: 'A command may be waiting for you',
  matched: 'A command printed what you watched for',
};

/** Where a terminal works, in words. */
function place(terminal: TerminalInfo): string {
  if (!terminal.sessionId) return 'your checkout';
  return useStore.getState().sessions[terminal.sessionId]?.title ?? 'a session';
}

let autoWatch = true;
/** Settings, Terminals: "Tell me when a long command finishes in a terminal I am not looking at". */
export function setAutoWatch(enabled: boolean) {
  autoWatch = enabled;
}

let wired = false;
/**
 * A fired watch shows a toast, and an OS notification through `main.notify` (which main skips while the window has
 * focus). The notification carries the command and the reason, never the output.
 */
export function wireWatch() {
  if (wired) return;
  wired = true;
  onWatchFired((terminal, f) => {
    const s = useStore.getState();
    s.toast(`${f.command.slice(0, 80)} · ${watchReasonText(f)}`, f.reason === 'failed' ? 'danger' : 'info');
    void main('main.notify', {
      title: TITLES[f.reason],
      body: `${f.command.slice(0, 80)} in ${place(terminal)}. ${watchNotificationText(f)}`.slice(0, 1000),
      ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
    }).catch(() => undefined);
  });
  void host
    .call('settings.get', { key: AUTO_WATCH_SETTING })
    .then((v) => setAutoWatch(v.value !== false))
    .catch(() => undefined);
  const done = new Set<string>();
  setInterval(() => {
    if (!autoWatch) return;
    const t = useTerminals.getState();
    const targets = autoWatchTargets(t.terminals, t.blocks, { active: t.active, focused: document.hasFocus(), now: Date.now(), done });
    for (const { terminalId, blockId } of targets) {
      done.add(blockId);
      void pty.call('pty.watch', { id: terminalId, rule: { end: 'any', quietSeconds: null, match: null, auto: true } }).catch(() => undefined);
    }
  }, 5000);
}

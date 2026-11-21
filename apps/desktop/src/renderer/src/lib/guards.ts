import { pty } from './bridge.ts';
import { useStore } from './store.ts';
import { destructiveReason, findSecrets, isMultiLinePaste } from './terminal-intel.ts';

/**
 * SM-14: runs a command in a terminal on the user's behalf (suggestions, saved commands, history, re-run),
 * asking first when it is destructive or would run several lines.
 */
export function runInTerminal(terminalId: string, command: string, opts: { enter?: boolean } = {}) {
  const enter = opts.enter ?? true;
  const write = () => void pty.call('pty.write', { id: terminalId, data: enter ? `${command}\r` : command });
  const why = destructiveReason(command);
  const multi = isMultiLinePaste(command);
  if (!why && !(multi && enter)) return write();
  useStore.getState().ask({
    title: why ? 'Run a destructive command?' : 'Run several lines?',
    body: why ? `"${command.slice(0, 200)}" ${why}. Run it anyway?` : `This runs ${command.split('\n').length} lines one after another:\n${command.slice(0, 400)}`,
    confirmLabel: 'Run it',
    danger: !!why,
    onConfirm: write,
  });
}

/** SM-14: warns before text that looks like it contains a secret goes to an agent. */
export function sendChecked(text: string, send: () => void | Promise<unknown>) {
  const found = findSecrets(text);
  if (!found.length) return void send();
  useStore.getState().ask({
    title: 'This looks like it contains a secret',
    body: `It seems to include ${found.join(' and ')}. The agent, and its provider, would see it. Send it anyway?`,
    confirmLabel: 'Send anyway',
    danger: true,
    onConfirm: () => void send(),
  });
}

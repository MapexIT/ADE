import type { TelegramStatus } from '@ade/contracts';
import { create } from 'zustand';
import { host } from './bridge.ts';

interface TelegramStore {
  status: TelegramStatus | null;
  refresh(): Promise<void>;
}

/** CO-12: the Telegram notifier's live status, for the top bar indicator and the settings. */
export const useTelegram = create<TelegramStore>((set) => ({
  status: null,
  async refresh() {
    const status = await host.call('telegram.status', {}).catch(() => null);
    if (status) set({ status });
  },
}));

let listening = false;
/** Starts following status changes from the host; safe to call more than once. */
export function followTelegram() {
  void useTelegram.getState().refresh();
  if (listening) return;
  listening = true;
  host.on('telegram.status', (status) => useTelegram.setState({ status }));
}

/** One line for the indicator and the settings. */
export function telegramSummary(s: TelegramStatus | null): string {
  if (!s || !s.tokenStored || !s.passwordSet) return 'Not set up';
  if (!s.enabled) return 'Off';
  if (s.lastError) return `On, but not working: ${s.lastError}`;
  if (!s.active) return 'On, connecting…';
  return s.chats ? `On · ${s.chats} chat${s.chats === 1 ? '' : 's'} signed in` : 'On · no chat signed in yet';
}

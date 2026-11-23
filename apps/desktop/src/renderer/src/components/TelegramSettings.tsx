import { Send } from 'lucide-react';
import { Badge, Button, cx, SectionLabel } from '@ade/ui';
import { useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { followTelegram, telegramSummary, useTelegram } from '../lib/telegram.ts';
import { inputClass } from './Modal.tsx';

type Key = 'telegram' | 'telegram-password';

/**
 * CO-12: the bot token and the sign-in password (both in the OS credential store), the on/off switch, the live
 * status and a test message. Chats sign in from Telegram with /auth and the password; ADE deletes that message.
 */
export function TelegramSettings({ available, stored, onStoredChange }: { available: boolean; stored: string[]; onStoredChange(): Promise<void> }) {
  const status = useTelegram((t) => t.status);
  const toast = useStore((s) => s.toast);
  const [values, setValues] = useState<Record<Key, string>>({ telegram: '', 'telegram-password': '' });

  useEffect(() => followTelegram(), []);

  const save = (key: Key) =>
    void attempt(() => main('main.credentials.set', { key, secret: values[key] })).then(async (ok) => {
      if (!ok) return;
      setValues((v) => ({ ...v, [key]: '' }));
      await onStoredChange();
    });
  const remove = (key: Key) =>
    void attempt(async () => {
      // Without a token or a password the bot cannot work: switch it off first.
      if (status?.enabled) await host.call('telegram.setEnabled', { enabled: false });
      await main('main.credentials.delete', { key });
      return true;
    }).then(() => onStoredChange());

  const ready = stored.includes('telegram') && stored.includes('telegram-password');
  const on = !!status?.enabled;

  const field = (key: Key, label: string, placeholder: string, hint: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`tg-${key}`} className="text-[12px] font-semibold text-ink-muted">
        {label} {stored.includes(key) ? <Badge tone="ok">Saved</Badge> : null}
      </label>
      <div className="flex gap-2">
        <input
          id={`tg-${key}`}
          type="password"
          autoComplete="new-password"
          value={values[key]}
          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          placeholder={stored.includes(key) ? 'Saved. Type to replace it' : placeholder}
          className={`${inputClass} flex-1`}
          disabled={!available}
        />
        <Button disabled={!available || (key === 'telegram-password' ? values[key].length < 8 : !values[key])} onClick={() => save(key)}>
          Save
        </Button>
        {stored.includes(key) ? (
          <Button variant="ghost" onClick={() => remove(key)} aria-label={`Remove ${label.toLowerCase()}`}>
            Remove
          </Button>
        ) : null}
      </div>
      <span className="text-[12px] text-ink-muted">{hint}</span>
    </div>
  );

  return (
    <section className="flex flex-col gap-3" aria-label="Telegram notifications">
      <SectionLabel>Telegram notifications</SectionLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Send className="size-4 text-accent-soft" aria-hidden="true" />
        <span className="font-semibold">Telegram</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Telegram notifications"
          disabled={!ready && !on}
          title={!ready ? 'Save the bot token and a password first' : undefined}
          onClick={() => void attempt(() => host.call('telegram.setEnabled', { enabled: !on })).then((s) => s && useTelegram.setState({ status: s }))}
          className={cx(
            'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-45',
            on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-sunken',
          )}
        >
          <span aria-hidden="true" className={cx('absolute top-0.5 size-4.5 rounded-full bg-ink transition-[left] duration-150 motion-reduce:transition-none', on ? 'left-[22px]' : 'left-0.5')} />
        </button>
        <span className={cx('text-[13px]', on ? 'text-ink' : 'text-ink-muted')} aria-live="polite">
          {telegramSummary(status)}
        </span>
        {status?.bot ? <Badge className="font-mono">@{status.bot}</Badge> : null}
      </div>
      {field('telegram', 'Bot token', 'Token from @BotFather', 'Create a bot with @BotFather in Telegram and paste the token it gives you.')}
      {field('telegram-password', 'Sign-in password', 'At least 8 characters', 'Chats sign in by sending /auth followed by this password to the bot. ADE deletes that message straight away.')}
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-[12px] text-ink-muted">
        <li>Save the token and a password, then switch Telegram on.</li>
        <li>In Telegram, open a private chat with {status?.bot ? `@${status.bot}` : 'your bot'} and send /auth followed by the password.</li>
        <li>That chat gets a message when a session finishes, fails or needs you, for 3 hours. Then send /auth again.</li>
      </ol>
      <p className="m-0 text-[12px] text-ink-muted">
        Sign-ins are kept in memory only, so restarting ADE signs every chat out. Messages include session and workspace names and go through Telegram&apos;s servers.
      </p>
      <div>
        <Button
          size="dense"
          disabled={!on || !status?.chats}
          title={!status?.chats ? 'Sign in a chat with /auth first' : undefined}
          onClick={() => void attempt(() => host.call('telegram.test', {})).then((r) => r && toast(`Test message sent to ${r.sent} chat${r.sent === 1 ? '' : 's'}.`))}
        >
          Send a test message
        </Button>
      </div>
    </section>
  );
}

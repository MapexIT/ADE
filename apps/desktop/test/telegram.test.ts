import { describe, expect, it } from 'vitest';
import type { TelegramStatus } from '@ade/contracts';
import { AUTH_TTL_MS, parseCommand, passwordMatches, TelegramApi, TelegramError, TelegramNotifier, type FetchLike, type TgMessage } from '../src/host/telegram.ts';

const TOKEN = '123:abc-test-token';

/** A stand-in for the Bot API: records calls and answers getUpdates from a queue. */
function fakeApi() {
  const calls: { method: string; params: Record<string, unknown>; url: string }[] = [];
  const updates: unknown[][] = [];
  const failDelete = { on: false };
  const fetch: FetchLike = async (url, init) => {
    const method = url.split('/').at(-1)!;
    const params = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, params, url });
    const ok = (result: unknown) => ({ json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ username: 'ade_test_bot', first_name: 'ADE' });
    if (method === 'getUpdates') {
      const next = updates.shift();
      if (next) return ok(next);
      // Long poll: wait until aborted.
      await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (method === 'deleteMessage' && failDelete.on) return { json: async () => ({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }) };
    return ok(true);
  };
  return { calls, updates, fetch, failDelete, sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => [c.params.chat_id, c.params.text]) };
}

function setup(opts: { password?: string | null; token?: string | null; enabled?: boolean } = {}) {
  const api = fakeApi();
  let now = 1_800_000_000_000;
  let enabled = opts.enabled ?? true;
  const secrets: Record<string, string | null> = { telegram: opts.token === undefined ? TOKEN : opts.token, 'telegram-password': opts.password === undefined ? 'correct horse' : opts.password };
  const statuses: TelegramStatus[] = [];
  const n = new TelegramNotifier({
    fetch: api.fetch,
    base: 'http://tg.invalid',
    now: () => now,
    secret: (k) => secrets[k] ?? null,
    enabled: () => enabled,
    setEnabled: (on) => {
      enabled = on;
    },
    onStatus: (s) => statuses.push(s),
  });
  const msg = (text: string, extra: Partial<TgMessage> = {}): TgMessage => ({ message_id: 7, date: Math.floor(now / 1000), chat: { id: 42, type: 'private' }, text, ...extra });
  return { n, api, msg, statuses, secrets, advance: (ms: number) => (now += ms) };
}

describe('CO-12 Telegram helpers', () => {
  it('parses commands, with a bot suffix or the = slip', () => {
    expect(parseCommand('/auth  hunter2 x')).toEqual({ command: 'auth', arg: 'hunter2 x' });
    expect(parseCommand('/auth@ade_test_bot pw')).toEqual({ command: 'auth', arg: 'pw' });
    expect(parseCommand('=auth pw')).toEqual({ command: 'auth', arg: 'pw' });
    expect(parseCommand('/status')).toEqual({ command: 'status', arg: '' });
    expect(parseCommand('hello')).toBeNull();
  });

  it('compares passwords exactly', () => {
    expect(passwordMatches('a', 'a')).toBe(true);
    expect(passwordMatches('a', 'b')).toBe(false);
    expect(passwordMatches('', 'a')).toBe(false);
  });

  it('never puts the token in an error', async () => {
    const down = new TelegramApi(TOKEN, async () => Promise.reject(new Error(`connect failed http://x/bot${TOKEN}/getMe`)));
    const err = (await down.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).not.toContain(TOKEN);
    const refused = new TelegramApi(TOKEN, async () => ({ json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) }));
    await expect(refused.getMe()).rejects.toMatchObject({ message: 'Telegram: Unauthorized', code: 401 });
  });
});

describe('CO-12 Telegram notifier', () => {
  it('starts only with a token, a password and the switch on, and stops when switched off', async () => {
    const off = setup({ enabled: false });
    off.n.configure();
    expect(off.api.calls).toHaveLength(0);
    expect(off.n.status()).toMatchObject({ tokenStored: true, passwordSet: true, enabled: false, active: false });

    const noPassword = setup({ password: null });
    noPassword.n.configure();
    expect(noPassword.api.calls).toHaveLength(0);

    const { n, api } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);
    expect(n.status().bot).toBe('ade_test_bot');
    expect(api.calls.find((c) => c.method === 'getUpdates')?.params).toMatchObject({ offset: 0, timeout: 25, allowed_updates: ['message'] });
    n.setEnabled(false);
    expect(n.status()).toMatchObject({ enabled: false, active: false });
    n.dispose();
  });

  it('deletes every /auth message, signs in on the right password and sends notifications only to signed-in chats', async () => {
    const { n, api, msg } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);

    expect(await n.notify('Session finished a turn', 'Fix parser')).toBe(0);
    await n.handle(msg('/auth wrong'));
    expect(api.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.params)).toEqual([{ chat_id: 42, message_id: 7 }]);
    expect(api.sent().at(-1)).toEqual([42, 'Wrong password.']);
    expect(n.status().chats).toBe(0);

    await n.handle(msg('/auth correct horse', { message_id: 8 }));
    expect(api.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(2);
    expect(n.status().chats).toBe(1);
    expect(await n.notify('Session finished a turn', 'Fix parser')).toBe(1);
    expect(api.sent().at(-1)).toEqual([42, 'ADE · Session finished a turn\nFix parser']);

    await n.handle(msg('/logout'));
    expect(n.status().chats).toBe(0);
    n.dispose();
  });

  it('signs a chat out after three hours and tells it', async () => {
    const { n, api, msg, advance } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);
    await n.handle(msg('/auth correct horse'));
    advance(AUTH_TTL_MS - 1000);
    expect(await n.notify('t', '')).toBe(1);
    advance(2000);
    expect(await n.notify('t', '')).toBe(0);
    expect(api.sent().some(([, text]) => String(text).startsWith('Your ADE sign-in expired'))).toBe(true);
    n.dispose();
  });

  it('refuses group chats, stale messages and too many wrong passwords, but still deletes them', async () => {
    const { n, api, msg, advance } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);
    await n.handle(msg('/auth correct horse', { chat: { id: -5, type: 'group' } }));
    await n.handle(msg('/auth correct horse', { date: Math.floor(Date.now() / 1000) - 3600 * 24 * 365 * 10 }));
    expect(n.status().chats).toBe(0);
    for (let i = 0; i < 5; i++) await n.handle(msg('/auth nope'));
    await n.handle(msg('/auth correct horse'));
    expect(n.status().chats).toBe(0);
    expect(api.sent().at(-1)).toEqual([42, 'Too many wrong passwords. Try again in 15 minutes.']);
    advance(16 * 60_000);
    await n.handle(msg('/auth correct horse'));
    expect(n.status().chats).toBe(1);
    expect(api.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(9);
    n.dispose();
  });

  it('says so when it cannot delete the password message', async () => {
    const { n, api, msg } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);
    api.failDelete.on = true;
    await n.handle(msg('/auth correct horse'));
    expect(api.sent()[0]).toEqual([42, 'ADE could not delete your /auth message. Delete it yourself.']);
    n.dispose();
  });

  it('a new password or token signs every chat out; sign-ins are never stored', async () => {
    const { n, msg, secrets, statuses } = setup();
    n.configure();
    await expect.poll(() => n.status().active).toBe(true);
    await n.handle(msg('/auth correct horse'));
    expect(n.status().chats).toBe(1);
    secrets['telegram-password'] = 'another one';
    n.configure();
    expect(n.status().chats).toBe(0);
    expect(JSON.stringify(statuses)).not.toContain('correct horse');
    expect(JSON.stringify(statuses)).not.toContain(TOKEN);
    n.dispose();
  });

  it('handles updates from the poll loop and advances the offset', async () => {
    const { n, api } = setup();
    api.updates.push([{ update_id: 10, message: { message_id: 3, date: Math.floor(1_800_000_000_000 / 1000), chat: { id: 42, type: 'private' }, text: '/auth correct horse' } }]);
    n.configure();
    await expect.poll(() => n.status().chats).toBe(1);
    await expect.poll(() => api.calls.filter((c) => c.method === 'getUpdates').at(-1)?.params.offset).toBe(11);
    n.dispose();
  });
});

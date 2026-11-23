import { createHash, timingSafeEqual } from 'node:crypto';
import type { TelegramStatus } from '@ade/contracts';

/**
 * CO-12: notifications through a Telegram bot the user creates. Bot API facts used here, from
 * https://core.telegram.org/bots/api (read 2026-11-23, Bot API 10.5): methods are called as
 * `https://api.telegram.org/bot<token>/<method>` with a JSON POST body; replies are `{ ok, result }` or
 * `{ ok: false, description, error_code, parameters.retry_after }`; `getMe` returns the bot with `username`;
 * `getUpdates` takes `offset`, `timeout` (long polling) and `allowed_updates`, and does not work while a webhook is
 * set; `Update.message.chat` has `id` and `type` ("private" for one-to-one chats); `sendMessage` takes `chat_id`
 * and `text` (1 to 4096 characters); `deleteMessage` takes `chat_id` and `message_id`.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ json(): Promise<unknown> }>;

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

interface TgChat {
  id: number;
  type: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  text?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const MAX_TEXT = 4096;

/** A thin Bot API client. Errors never include the URL, so the token cannot leak into a message or a log. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly base = 'https://api.telegram.org',
  ) {}

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramError('Telegram could not be reached.', null);
    }
    if (body.ok) return body.result as T;
    throw new TelegramError(body.description ? `Telegram: ${body.description}` : 'Telegram refused the request.', body.error_code ?? null, body.parameters?.retry_after ?? null);
  }

  getMe() {
    return this.call<{ username?: string; first_name: string }>('getMe', {});
  }
  getUpdates(offset: number, timeout: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message'] }, signal);
  }
  sendMessage(chatId: number, text: string) {
    return this.call<unknown>('sendMessage', { chat_id: chatId, text: text.slice(0, MAX_TEXT) });
  }
  deleteMessage(chatId: number, messageId: number) {
    return this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }
}

export const AUTH_TTL_MS = 3 * 60 * 60_000;
/** An /auth older than this was sent while ADE was not listening: it is deleted but does not sign in. */
const STALE_AUTH_S = 120;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const POLL_TIMEOUT_S = 25;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** Constant-time password comparison. */
export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** `/auth`, `/auth@my_bot` or `=auth` (a common slip), with what follows. Null for anything else. */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = /^[/=]([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { command: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

export interface TelegramDeps {
  fetch: FetchLike;
  base?: string;
  now?: () => number;
  /** Reads the secrets main handed over. */
  secret(key: 'telegram' | 'telegram-password'): string | null;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  onStatus(status: TelegramStatus): void;
  log?(text: string): void;
}

/**
 * CO-12: listens to the bot by long polling, signs chats in with `/auth <password>` and sends ADE's notifications
 * to signed-in chats. Every `/auth` message is deleted, whether or not the password was right. Sign-ins are kept in
 * memory only (a restart forgets them) and last three hours. Only one-to-one chats can sign in.
 */
export class TelegramNotifier {
  private readonly authed = new Map<number, number>();
  private readonly failures = new Map<number, { count: number; until: number }>();
  private loop: AbortController | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private api: TelegramApi | null = null;
  private key = '';
  private offset = 0;
  private bot: string | null = null;
  private active = false;
  private lastError: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TelegramDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(): TelegramStatus {
    return {
      tokenStored: !!this.deps.secret('telegram'),
      passwordSet: !!this.deps.secret('telegram-password'),
      enabled: this.deps.enabled(),
      active: this.active,
      bot: this.bot,
      chats: this.signedIn().length,
      lastError: this.lastError,
    };
  }

  private changed() {
    this.deps.onStatus(this.status());
  }

  /** Starts or stops listening to match the settings and secrets. A new token or password signs every chat out. */
  configure(): void {
    const token = this.deps.secret('telegram');
    const password = this.deps.secret('telegram-password');
    const key = `${token ?? ''}\u0000${password ?? ''}`;
    const run = !!token && !!password && this.deps.enabled();
    if (key !== this.key) {
      this.authed.clear();
      this.failures.clear();
      this.bot = null;
      this.offset = 0;
      this.stop();
      this.key = key;
    }
    if (!run) {
      this.stop();
      this.authed.clear();
      if (!token || !password) this.lastError = null;
      this.changed();
      return;
    }
    if (!this.loop) this.start(token);
    this.changed();
  }

  setEnabled(on: boolean): TelegramStatus {
    this.deps.setEnabled(on);
    this.configure();
    return this.status();
  }

  private start(token: string) {
    this.api = new TelegramApi(token, this.deps.fetch, this.deps.base);
    const ac = new AbortController();
    this.loop = ac;
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
    void this.poll(ac.signal);
  }

  private stop() {
    this.loop?.abort();
    this.loop = null;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.active = false;
  }

  dispose() {
    this.stop();
    this.authed.clear();
  }

  private async poll(signal: AbortSignal) {
    const api = this.api!;
    let backoff = 2000;
    try {
      const me = await api.getMe();
      if (signal.aborted) return;
      this.bot = me.username ?? me.first_name;
      // Telegram accepted the token: ADE is listening from here on, until a poll fails.
      this.active = true;
      this.lastError = null;
      this.changed();
    } catch (err) {
      if (signal.aborted) return;
      this.lastError = (err as Error).message;
      this.changed();
    }
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(this.offset, POLL_TIMEOUT_S, AbortSignal.any([signal, AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000)]));
        if (signal.aborted) return;
        if (!this.active || this.lastError) {
          this.active = true;
          this.lastError = null;
          this.changed();
        }
        backoff = 2000;
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) await this.handle(u.message);
        }
      } catch (err) {
        if (signal.aborted) return;
        const e = err as TelegramError;
        this.active = false;
        this.lastError = e.code === 401 ? 'Telegram rejected the bot token.' : e.message;
        this.changed();
        const wait = e.retryAfter ? e.retryAfter * 1000 : backoff;
        backoff = Math.min(60_000, backoff * 2);
        await new Promise((r) => setTimeout(r, wait).unref());
      }
    }
  }

  /** Handles one incoming message. Public for tests. */
  async handle(msg: TgMessage): Promise<void> {
    const api = this.api;
    if (!api || !msg.text) return;
    const cmd = parseCommand(msg.text);
    if (!cmd) return;
    const chat = msg.chat.id;
    const reply = (text: string) => api.sendMessage(chat, text).catch(() => undefined);

    if (cmd.command === 'auth') {
      // Delete first, so the password is on screen for as short a time as possible.
      const deleted = await api.deleteMessage(chat, msg.message_id).then(
        () => true,
        () => false,
      );
      if (!deleted) await reply('ADE could not delete your /auth message. Delete it yourself.');
      if (msg.chat.type !== 'private') return void (await reply('Sign in from a private chat with this bot.'));
      if (this.now() / 1000 - msg.date > STALE_AUTH_S) return void (await reply('That /auth was sent while ADE was not listening. Send it again.'));
      const lock = this.failures.get(chat);
      if (lock && lock.until > this.now()) return void (await reply('Too many wrong passwords. Try again in 15 minutes.'));
      const password = this.deps.secret('telegram-password');
      if (!password || !cmd.arg || !passwordMatches(cmd.arg, password)) {
        const count = (lock && lock.until > this.now() ? 0 : (lock?.count ?? 0)) + 1;
        this.failures.set(chat, { count: count >= MAX_FAILURES ? 0 : count, until: count >= MAX_FAILURES ? this.now() + LOCKOUT_MS : 0 });
        this.deps.log?.(`telegram: failed sign-in from chat ${chat}`);
        return void (await reply('Wrong password.'));
      }
      this.failures.delete(chat);
      this.authed.set(chat, this.now() + AUTH_TTL_MS);
      this.changed();
      return void (await reply('Signed in. ADE sends its notifications here for the next 3 hours. Send /logout to stop.'));
    }
    if (cmd.command === 'logout') {
      const was = this.authed.delete(chat);
      if (was) this.changed();
      return void (await reply(was ? 'Signed out. No more notifications here.' : 'This chat is not signed in.'));
    }
    if (cmd.command === 'status') {
      const until = this.authed.get(chat);
      return void (await reply(until && until > this.now() ? `Signed in until ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : 'Not signed in. Send /auth followed by the password set in ADE.'));
    }
    if (cmd.command === 'start' || cmd.command === 'help') {
      return void (await reply('ADE notifications. Send /auth followed by the password set in ADE’s settings to get them here for 3 hours. /status shows your sign-in, /logout ends it.'));
    }
  }

  private signedIn(): number[] {
    const now = this.now();
    return [...this.authed].filter(([, until]) => until > now).map(([chat]) => chat);
  }

  /** Signs out chats whose three hours are up and tells them. */
  async sweep(): Promise<void> {
    const now = this.now();
    const expired = [...this.authed].filter(([, until]) => until <= now).map(([chat]) => chat);
    if (!expired.length) return;
    for (const chat of expired) this.authed.delete(chat);
    this.changed();
    await Promise.all(expired.map((chat) => this.api?.sendMessage(chat, 'Your ADE sign-in expired. Send /auth again to keep getting notifications.').catch(() => undefined)));
  }

  /** Sends a notification to every signed-in chat. Returns how many received it. */
  async notify(title: string, body: string): Promise<number> {
    if (!this.api || !this.loop) return 0;
    await this.sweep();
    const chats = this.signedIn();
    const text = body ? `ADE · ${title}\n${body}` : `ADE · ${title}`;
    const results = await Promise.all(chats.map((chat) => this.api!.sendMessage(chat, text).then(() => 1, () => 0)));
    return results.reduce<number>((a, b) => a + b, 0);
  }
}

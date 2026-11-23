import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

/** A local stand-in for the Telegram Bot API: records calls and serves queued updates to getUpdates. */
function botApi() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queue: unknown[] = [];
  let nextId = 1;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').at(-1) ?? '';
      const params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method, params });
      const reply = (result: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === 'getMe') return reply({ username: 'ade_test_bot', first_name: 'ADE' });
      if (method === 'getUpdates') {
        // A short long-poll keeps the test quick.
        const answer = () => reply(queue.splice(0));
        return queue.length ? answer() : void setTimeout(answer, 300);
      }
      reply(true);
    });
  });
  return {
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text)),
    message: (text: string) => queue.push({ update_id: nextId++, message: { message_id: 100 + nextId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private' }, text } }),
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('CO-12: Telegram notifications need a token and a password, chats sign in with /auth, and the switch turns them off', async () => {
  const bot = botApi();
  const base = await bot.start();
  const repo = makeRepo();
  const dir = userDataDir();
  let { app, page } = await launch(dir, { ADE_TELEGRAM_API: base });
  await page.getByRole('button', { name: 'Done' }).click();

  // Settings: the switch stays disabled until both secrets are saved.
  await page.keyboard.press('Control+,');
  const section = page.getByRole('region', { name: 'Telegram notifications' });
  const toggle = section.getByRole('switch', { name: 'Telegram notifications' });
  await expect(toggle).toBeDisabled();
  await section.getByLabel('Bot token').fill('123:fake-token');
  await section.getByRole('button', { name: 'Save' }).first().click();
  await section.getByLabel('Sign-in password').fill('short');
  await expect(section.getByRole('button', { name: 'Save' }).nth(1)).toBeDisabled();
  await section.getByLabel('Sign-in password').fill('correct horse battery');
  await section.getByRole('button', { name: 'Save' }).nth(1).click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(section.getByText('On · no chat signed in yet')).toBeVisible();
  await expect(section.getByText('@ade_test_bot', { exact: true })).toBeVisible();
  // The top bar shows the state too, and opens the settings.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Telegram notifications: On · no chat signed in yet' }).click();

  // A wrong password, then the right one: both messages are deleted; only the right one signs in.
  bot.message('/auth nope');
  await expect.poll(() => bot.sent()).toContain('Wrong password.');
  bot.message('/auth correct horse battery');
  await expect(section.getByText('On · 1 chat signed in')).toBeVisible();
  expect(bot.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(2);
  await section.getByRole('button', { name: 'Send a test message' }).click();
  await expect.poll(() => bot.sent().some((t) => t.startsWith('ADE · Test notification'))).toBe(true);
  await page.getByRole('button', { name: 'Close' }).click();

  // A finished turn reaches the signed-in chat, with the workspace name.
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say done');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect.poll(() => bot.sent().find((t) => t.startsWith('ADE · Session finished a turn')), { timeout: 30_000 }).toContain('Workspace: demo-repo');

  // Off: the indicator says so and nothing more is sent.
  await page.getByRole('button', { name: /^Telegram notifications: On/ }).click();
  await page.getByRole('region', { name: 'Telegram notifications' }).getByRole('switch').click();
  await expect(page.getByRole('region', { name: 'Telegram notifications' }).getByText('Off', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Telegram notifications: Off' })).toBeVisible();
  await app.close();

  // After a restart the switch is remembered, but nobody is signed in any more.
  ({ app, page } = await launch(dir, { ADE_TELEGRAM_API: base }));
  await expect(page.getByRole('button', { name: 'Telegram notifications: Off' })).toBeVisible();
  await page.getByRole('button', { name: 'Telegram notifications: Off' }).click();
  await page.getByRole('region', { name: 'Telegram notifications' }).getByRole('switch').click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Telegram notifications: On · no chat signed in yet' })).toBeVisible();
  if (process.env.ADE_SHOTS) {
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/tg-topbar.png`, clip: { x: 900, y: 0, width: 1000, height: 80 } });
    await page.getByRole('button', { name: /^Telegram notifications/ }).click();
    await page.getByRole('region', { name: 'Telegram notifications' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/tg-settings.png` });
  }
  await app.close();
  await bot.stop();
});

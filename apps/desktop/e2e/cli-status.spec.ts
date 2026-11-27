import { expect, test } from '@playwright/test';
import { launch, userDataDir } from './helpers.ts';

test('ST-07: the coding CLIs button opens their status, and Settings and Help sit in the top bar', async () => {
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();

  const cli = page.getByRole('button', { name: /^Coding CLIs: \d of 3 ready$/ });
  await expect(cli).toBeVisible();
  // Same height as the other buttons in the row.
  const [a, b] = await Promise.all([cli.boundingBox(), page.getByRole('button', { name: /^Needs you/ }).boundingBox()]);
  expect(Math.round(a!.height)).toBe(Math.round(b!.height));

  await cli.click();
  const pop = page.getByRole('dialog', { name: 'Coding CLIs' });
  await expect(pop).toBeVisible();
  if (process.env.ADE_SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/cli-status.png` });
  }
  for (const id of ['codex', 'claude-code', 'opencode']) await expect(pop.getByTestId(`cli-${id}`)).toBeVisible();
  // A missing CLI offers Install (not pressed here: it would install for real) or says why it cannot.
  for (const row of await pop.locator('[data-testid^="cli-"]').all()) {
    if ((await row.textContent())?.includes('Not installed')) await expect(row.getByRole('button', { name: /^Install with / }).or(row.getByText(/was not found/))).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Help centre' })).toContainText('Help');
  await app.close();
});

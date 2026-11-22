import { expect, test } from '@playwright/test';
import { launch, userDataDir } from './helpers.ts';

test('help centre lists every shipped feature, searches them and jumps to the right screen', async () => {
  const { page, app } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();

  await page.keyboard.press('F1');
  const help = page.getByRole('dialog', { name: 'Help centre' });
  await expect(help).toBeVisible();
  await expect(help.getByText(/features in \d+ areas/)).toBeVisible();

  await help.getByRole('button', { name: /Keyboard shortcuts/ }).click();
  await expect(help.getByText('New session')).toBeVisible();

  await help.getByLabel('Search features').fill('SM-01');
  await expect(help.getByRole('article')).toHaveCount(1);
  await help.getByRole('button', { name: 'Open Terminals' }).click();
  await expect(help).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Terminals' }),
  ).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Help centre' }).click();
  await expect(page.getByRole('dialog', { name: 'Help centre' })).toBeVisible();
  await app.close();
});

import { expect, test } from '@playwright/test';
import { launch, userDataDir } from './helpers.ts';

test('CO-14: an unconnected source explains, step by step, how to connect it', async () => {
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Control+2');

  // A fresh profile has no Shortcut token, so the Shortcut tab shows the guide instead of an empty list.
  const guide = page.getByRole('region', { name: 'Connect Shortcut' });
  await expect(guide).toBeVisible();
  const steps = guide.getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(steps.nth(0)).toContainText('API Tokens');
  await expect(steps.nth(1)).toContainText('Save the token in ADE');

  // "Open settings" leads to the token field the guide talks about.
  await guide.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByLabel('shortcut token', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // Check again re-reads the status and keeps the guide while nothing changed.
  await guide.getByRole('button', { name: 'Check again' }).click();
  await expect(guide.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(guide).toBeVisible();
  await app.close();
});

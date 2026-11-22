import { expect, test } from '@playwright/test';
import { launch, userDataDir } from './helpers.ts';

test('page tabs show a tooltip with name, description and shortcut; Ctrl 1 to 7 follow the tabs', async () => {
  const { page, app } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });

  await nav.getByRole('button', { name: 'Work items' }).hover();
  // Radix also renders a visually hidden role=tooltip copy for screen readers; check the visible one.
  const tip = page.locator('.ade-tip[data-state$="open"]');
  await expect(tip).toContainText('Work items');
  await expect(tip).toContainText('Ctrl 2');
  await expect(tip).toContainText('assigned to you');

  // Keyboard focus shows it too.
  await nav.getByRole('button', { name: 'Review' }).focus();
  await expect(tip).toContainText('Ctrl 7');

  await page.locator('body').click({ position: { x: 600, y: 500 } });
  for (const [key, name] of [
    ['4', 'Skills'],
    ['7', 'Review'],
    ['1', 'Sessions'],
  ] as const) {
    await page.keyboard.press(`Control+${key}`);
    await expect(nav.getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
  }
  await app.close();
});

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

async function togglePanel(page: Page, title: string) {
  await page.getByRole('button', { name: 'Panels' }).click();
  await page.getByRole('menuitemcheckbox', { name: title, exact: true }).click();
}

const tab = (page: Page, title: string) => page.locator('.dv-tab', { hasText: new RegExp(`^${title}$`) });

test('closed panels can be shown again, and a file opens with the session panel closed', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Close the middle and the sessions list, then open a file from the inspector.
  await togglePanel(page, 'Session');
  await togglePanel(page, 'Sessions');
  await expect(tab(page, 'Session')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  await expect(tab(page, 'Editor')).toBeVisible();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();

  // Close everything: the dock offers the panels back instead of an empty screen.
  for (const title of ['Editor', 'Inspector', 'Terminal']) await togglePanel(page, title);
  await expect(page.getByText('All panels are closed.')).toBeVisible();
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await expect(tab(page, 'Inspector')).toBeVisible();
  await togglePanel(page, 'Sessions');
  await expect(tab(page, 'Sessions')).toBeVisible();

  await page.getByRole('button', { name: 'Panels' }).click();
  await page.getByRole('menuitem', { name: 'Reset layout' }).click();
  for (const title of ['Session', 'Sessions', 'Inspector', 'Terminal'])
    await expect(tab(page, title)).toHaveCount(1);
  await app.close();
});

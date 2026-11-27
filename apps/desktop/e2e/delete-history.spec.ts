import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('HI-13: an ended session can be deleted from the Sessions list, one at a time or all at once', async () => {
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, makeRepo());
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  for (const [title, file] of [['First throwaway', 'one'], ['Second throwaway', 'two']] as const) {
    await page.keyboard.press('Control+1');
    await page.keyboard.press('Control+n');
    await page.getByLabel('What should the agent do?').fill(`edit ${file}.txt text`);
    await page.getByLabel('Title (optional)').fill(title);
    await page.getByRole('radio', { name: /Fake agent/ }).check();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page.getByText('Turn 1 · finished')).toBeVisible();
    // The Session tab names the session the list has selected.
    await expect(page.locator('.dv-default-tab-content', { hasText: `Session · ${title}` })).toBeVisible();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: 'Discard session' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard session' }).click();
    await expect(page.getByText('This session has been discarded', { exact: true })).toBeVisible();
  }

  await page.keyboard.press('Control+1');
  const list = page.getByRole('complementary', { name: 'Sessions' });
  await list.getByRole('button', { name: /Done · show 2/ }).click();
  await list.getByRole('button', { name: 'Delete session First throwaway' }).click();
  await expect(list.getByText('First throwaway')).toBeHidden();
  await expect(list.getByText('Second throwaway')).toBeVisible();

  // Delete all asks for a second press.
  await list.getByRole('button', { name: 'Delete all', exact: true }).click();
  await list.getByRole('button', { name: 'Delete all ended sessions' }).click();
  await expect(page.getByText('Deleted 1 session.')).toBeVisible();
  await expect(list.getByText('Second throwaway')).toBeHidden();
  await app.close();
});

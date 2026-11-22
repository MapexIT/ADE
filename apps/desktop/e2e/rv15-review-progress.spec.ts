import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

async function startSession(page: Page, title: string, prompt: string) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(prompt);
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function followUp(page: Page, prompt: string, turn: number) {
  await page.getByLabel('Message Fake agent').fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(`Turn ${turn} · finished`)).toBeVisible();
}

test('RV-15: mark files as reviewed, warn before landing unreviewed files, notice later changes, keep marks after restart', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  let { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await startSession(page, 'Review progress', 'edit one.txt first');
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await followUp(page, 'edit two.txt second', 2);

  await page.keyboard.press('Control+7');
  const files = page.getByRole('complementary', { name: 'Changed files' });
  const row = (path: string) => files.getByRole('button', { name: path }).locator('xpath=../..');
  await expect(files).toContainText('2 files · 0 reviewed');
  const mark = page.getByRole('button', { name: 'Mark as reviewed', exact: true });
  const unmark = page.getByRole('button', { name: 'Mark as not reviewed', exact: true });

  // Marking moves on to the next file and keeps focus, so Enter walks through the files.
  await mark.click();
  await expect(row('one.txt').getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(files).toContainText('1 reviewed');
  await expect(mark).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row('two.txt').getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(files).toContainText('2 reviewed');
  // Every file is reviewed, so the active file stays and the button now unmarks it.
  await expect(unmark).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(files).toContainText('1 reviewed');
  await expect(row('two.txt').getByText('Reviewed', { exact: true })).toBeHidden();

  // Landing warns about the file that is not reviewed, and is not blocked.
  await page.getByRole('button', { name: 'Apply to my checkout' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('is not marked as reviewed: two.txt');
  await expect(dialog.getByRole('button', { name: 'Apply to my checkout' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();

  // A later turn changes a reviewed file.
  await page.keyboard.press('Control+1');
  await followUp(page, 'edit one.txt changed', 3);
  await page.keyboard.press('Control+7');
  await expect(row('one.txt').getByText('Changed since review', { exact: true })).toBeVisible();
  await files.getByRole('button', { name: 'one.txt' }).click();
  const since = page.getByRole('button', { name: 'Since my review' });
  await since.click();
  await expect(since).toHaveAttribute('aria-pressed', 'true');
  await mark.click();
  await expect(row('one.txt').getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(since).toBeHidden();

  // Marks survive a restart.
  await app.close();
  ({ app, page } = await launch(data));
  await expect(page.getByRole('heading', { name: 'Review progress' })).toBeVisible();
  await page.keyboard.press('Control+7');
  const after = page.getByRole('complementary', { name: 'Changed files' });
  await expect(after.getByRole('button', { name: 'one.txt' }).locator('xpath=../..').getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(after).toContainText('2 files · 1 reviewed');
  await app.close();
});

import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M4 gate: failed block, Fix with agent starts a turn with the block, a run adds a history row', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // A session to receive the fix.
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say Ready.');
  await page.getByLabel('Title (optional)').fill('Terminal session');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Ready.', { exact: true })).toBeVisible();

  // A smart terminal in the session worktree; run a command that fails.
  await page.keyboard.press('Control+4');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
  await page.waitForTimeout(2500);
  await page.locator('.xterm').last().click();
  await page.keyboard.type('git definitely-not-a-command');
  await page.keyboard.press('Enter');
  const failed = page.getByRole('region', { name: 'Command block, failed' });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed).toContainText('git definitely-not-a-command');

  await failed.getByRole('button', { name: 'Fix with agent' }).click();
  await page.keyboard.press('Control+1');
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();
  await expect(page.locator('main[aria-label="Session"]').getByText('Command: git definitely-not-a-command')).toBeVisible();

  // Running a configuration adds a history row.
  await page.keyboard.press('Control+5');
  await page.getByLabel('Configuration', { exact: true }).selectOption({ label: 'npm test' });
  await page.getByLabel('Worktree', { exact: true }).selectOption({ label: 'Your checkout' });
  await page.getByRole('button', { name: 'Run the configuration' }).click();
  await expect(page.getByRole('complementary', { name: 'Run history' }).getByText(/Failed · exit 1/)).toBeVisible({ timeout: 30_000 });
  await app.close();
});

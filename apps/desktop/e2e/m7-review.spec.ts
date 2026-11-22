import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T03: batch review comments go as one prompt; a failing check goes to the agent in one click', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('edit notes.txt first line\\nsecond line');
  await page.getByLabel('Title (optional)').fill('Notes');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();

  // RV-09: two comments collected, then sent together.
  await page.keyboard.press('Control+7');
  for (const text of ['Use a heading', 'Fix the typo']) {
    await page.getByRole('button', { name: 'Comment on line' }).click();
    await page.getByLabel(/Comment on line \d+ for the agent/).fill(text);
    await page.getByRole('button', { name: 'Add to review' }).click();
  }
  const review = page.getByRole('region', { name: 'Pending review' });
  await expect(review).toContainText('Review · 2 comments');
  await review.getByRole('button', { name: 'Send review' }).click();
  await expect(page.getByText('Review sent to the agent.')).toBeVisible();
  await expect(review).toBeHidden();

  // RV-10: the detected "npm test" configuration fails in the demo repository.
  const checks = page.getByRole('region', { name: 'Checks' });
  await checks.getByRole('button', { name: 'Choose checks' }).click();
  await checks.getByRole('checkbox', { name: /npm test/ }).check();
  await checks.getByRole('button', { name: 'Run checks' }).click();
  await expect(checks.getByText(/Failed · exit/)).toBeVisible({ timeout: 30_000 });
  await checks.getByRole('button', { name: 'Send failures to the agent' }).click();

  await page.keyboard.press('Control+1');
  await expect(page.getByText('Turn 3 · finished')).toBeVisible({ timeout: 30_000 });
  const timeline = page.locator('main[aria-label="Session"]');
  await expect(timeline.getByText(/Review of your changes \(2 comments\)/)).toBeVisible();
  await expect(timeline.getByText(/This check fails in your worktree/)).toBeVisible();
  await app.close();
});

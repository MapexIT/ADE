import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

const LOOPING = ['read README.md', 'read README.md', 'read README.md', 'read README.md', 'sleep 20000', 'say never'].join('\n');

async function startLooping(page: Page) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(LOOPING);
  await page.getByLabel('Title (optional)').fill('Looping task');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'Looping task' })).toBeVisible();
}

test('WA-10: a looping agent is flagged in the timeline, the inbox and Observe, and can be redirected', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await startLooping(page);

  const card = page.getByRole('region', { name: 'Loop warning' });
  await expect(card).toContainText('Repeated the same step 4 times: Read README.md');
  await expect(card).toContainText('The agent reported no new edit in between.');
  const header = page.getByRole('heading', { name: 'Looping task' }).locator('..');
  await expect(header.getByText('May be looping')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Needs you: 1' })).toBeVisible();
  await page.keyboard.press('Control+i');
  await expect(page.getByRole('option').filter({ hasText: 'May be looping' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+8');
  const looping = page.getByRole('region', { name: 'Agents that may be looping' });
  await expect(looping).toContainText('Looping task');
  await expect(looping).toContainText('Repeated the same step 4 times');
  await looping.getByRole('button', { name: 'Open' }).click();

  await card.getByRole('button', { name: 'Redirect the agent' }).click();
  const box = page.getByRole('textbox', { name: 'Message Fake agent' });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/^You have repeated the same step 4 times/);
  await box.fill('say Back on track.');
  await page.getByRole('button', { name: 'Interrupt and send' }).click();

  await expect(page.getByText('Turn 2 · finished')).toBeVisible();
  await expect(page.getByText('Back on track.', { exact: true })).toBeVisible();
  await expect(card).toContainText('The turn ended.');
  await expect(card.getByRole('button', { name: 'Redirect the agent' })).toHaveCount(0);
  await expect(header.getByText('May be looping')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Needs you: 0' })).toBeVisible();
  await app.close();
});

test('WA-10: "Not a loop" dismisses the warning for the rest of the turn', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await startLooping(page);

  const card = page.getByRole('region', { name: 'Loop warning' });
  await card.getByRole('button', { name: 'Not a loop' }).click();
  await expect(card).toContainText('Dismissed. ADE will not warn again in this turn.');
  const header = page.getByRole('heading', { name: 'Looping task' }).locator('..');
  await expect(header.getByText('May be looping')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Needs you: 0' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Message Fake agent' }).press('Escape');
  await expect(page.getByText('Turn 1 · cancelled')).toBeVisible();
  await expect(card).toContainText('Dismissed. ADE will not warn again in this turn.');
  await app.close();
});

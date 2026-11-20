import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

test('M1-T02: killing the host process restarts it and the UI reconnects', async () => {
  const data = userDataDir();
  const { page, app } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Type a command').fill('Restart the host');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Reconnecting to the host process/)).toBeVisible();
  await expect(page.getByText(/Reconnecting to the host process/)).toBeHidden({ timeout: 20_000 });
  await app.close();
});

test('M3 gate: per-turn diff, undo turn 2, land one file, discard keeps the patch', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await startSession(page, 'Two files', 'edit one.txt first');
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await page.getByLabel('Message Fake agent').fill('edit two.txt second');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();

  // Per-turn diff in the review screen.
  await page.keyboard.press('Control+6');
  const files = page.getByRole('complementary', { name: 'Changed files' });
  await page.getByRole('group', { name: 'Turn' }).getByRole('button', { name: 'Turn 2' }).click();
  await expect(files.getByRole('button', { name: 'two.txt' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'one.txt' })).toBeHidden();

  // Undo turn 2 from the inspector, with confirmation.
  await page.keyboard.press('Control+1');
  const checkpoints = page.getByRole('complementary', { name: 'Inspector' });
  await checkpoints.getByRole('button', { name: 'Undo' }).nth(1).click();
  await page.getByRole('button', { name: 'Undo turn' }).click();
  await expect(page.getByText('Undid turn 2 and every change after it.')).toBeVisible();

  // Land the remaining file into the checkout.
  await page.keyboard.press('Control+6');
  await expect(files.getByRole('button', { name: 'one.txt' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'two.txt' })).toBeHidden();
  await page.getByRole('button', { name: 'Apply to my checkout' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply to my checkout' }).click();
  await expect.poll(() => existsSync(join(repo, 'one.txt')) && readFileSync(join(repo, 'one.txt'), 'utf8')).toBe('first');
  expect(existsSync(join(repo, 'two.txt'))).toBe(false);

  // A second session is discarded; its final patch stays in app data.
  await page.keyboard.press('Control+1');
  await startSession(page, 'Throwaway', 'edit three.txt third');
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await page.keyboard.press('Control+6');
  await page.getByRole('button', { name: 'Discard session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard session' }).click();
  await expect(page.getByText('This session has been discarded', { exact: true })).toBeVisible();
  const patches = readdirSync(join(data, 'patches'));
  expect(patches).toHaveLength(1);
  expect(readFileSync(join(data, 'patches', patches[0]!), 'utf8')).toContain('three.txt');
  await app.close();
});

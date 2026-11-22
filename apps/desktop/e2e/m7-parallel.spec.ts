import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T02: fork from a checkpoint, and run a saved command in a terminal', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('edit one.txt first');
  await page.getByLabel('Title (optional)').fill('Original');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();

  // SR-06: fork from the end of turn 1.
  await page.getByRole('complementary', { name: 'Inspector' }).getByRole('button', { name: 'Fork' }).click();
  await expect(page.getByLabel('Title (optional)')).toHaveValue('Fork of Original');
  await expect(page.getByLabel('Base branch or commit')).toHaveValue(/^[0-9a-f]{40}$/);
  await page.getByLabel('What should the agent do?').fill('edit two.txt second');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'Fork of Original' })).toBeVisible();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  const worktrees = join(data, 'worktrees');
  const wsDir = join(worktrees, readdirSync(worktrees)[0]!);
  const fork = readdirSync(wsDir).find((d) => d.startsWith('fork-of-original'))!;
  expect(existsSync(join(wsDir, fork, 'one.txt'))).toBe(true);
  expect(existsSync(join(wsDir, fork, 'two.txt'))).toBe(true);

  // TM-07: save a command and run it in a smart terminal.
  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Saved commands' }).click();
  await page.getByRole('menuitem', { name: 'Edit saved commands' }).click();
  await page.getByLabel('Command 1 name').fill('Show status');
  await page.getByLabel('Command 1', { exact: true }).fill('git status --short');
  await page.getByRole('dialog', { name: 'Saved commands' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved commands updated.')).toBeVisible();
  await page.getByRole('button', { name: 'Saved commands' }).click();
  await page.getByRole('menuitem', { name: /Show status/ }).click();
  await expect(page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'git status --short' })).toBeVisible({ timeout: 20_000 });
  await app.close();
});

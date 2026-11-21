import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T01: a workspace rule answers a request, a session works in the checkout, Discard restores it', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Settings: the sandbox state is shown either way; turn on run in place and add an allow rule.
  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('region', { name: 'Containment' }).getByText('Host sandbox')).toBeVisible();
  await dialog.getByLabel('Let one session at a time work in my checkout').check();
  const rules = dialog.getByRole('region', { name: 'Workspace rules' });
  await rules.getByRole('button', { name: 'Add rule' }).click();
  await rules.getByLabel('Rule 1 pattern').fill('npm test');
  await rules.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Workspace rules saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('ask npm test\nedit README.md # Changed\nsay done');
  await page.getByLabel('Title (optional)').fill('In place');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByLabel('Work in my checkout').check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'In place' })).toBeVisible();
  await expect(page.getByText('In your checkout', { exact: true })).toBeVisible();
  await expect(page.getByText(/Allow once · by a workspace rule/)).toBeVisible();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await expect.poll(() => readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Changed');

  await page.keyboard.press('Control+6');
  await expect(page.getByRole('button', { name: 'Keep changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Commit to branch' })).toBeHidden();
  await page.getByRole('button', { name: 'Discard session' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard session' }).click();
  await expect(page.getByText('This session has been discarded', { exact: true })).toBeVisible();
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Demo\n');
  expect(existsSync(join(repo, '.git'))).toBe(true);
  await app.close();
});

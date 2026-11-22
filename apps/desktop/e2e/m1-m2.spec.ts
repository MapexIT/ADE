import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M1 gate: open a repository, edit and save a file, restart, workspace and layout restored', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  let { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Open README.md from the inspector's file list and save an edit.
  await page.getByRole('treeitem', { name: 'README.md' }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Edited in ADE');
  await expect(page.getByText('Unsaved')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved README.md.')).toBeVisible();
  await expect.poll(() => readFileSync(join(repo, 'README.md'), 'utf8')).toContain('Edited in ADE');

  await app.close();
  ({ app, page } = await launch(data));
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await expect(page.locator('.dv-tab', { hasText: 'Editor' })).toBeVisible();
  await app.close();
});

test('M2 gate: tool call, approval, message, follow-up, history intact after restart', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  let { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('read README.md\nask npm test\nsay All done.');
  await page.getByLabel('Title (optional)').fill('Gate session');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();

  await expect(page.getByText('README.md').first()).toBeVisible();
  const card = page.getByRole('region', { name: 'Approval request' });
  await expect(card).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs you: 1' })).toBeVisible();
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('All done.', { exact: true })).toBeVisible();

  await page.getByLabel('Message Fake agent').fill('say Follow-up done.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Follow-up done.', { exact: true })).toBeVisible();

  await app.close();
  ({ app, page } = await launch(data));
  await expect(page.getByRole('heading', { name: 'Gate session' })).toBeVisible();
  await expect(page.getByText('All done.', { exact: true })).toBeVisible();
  await expect(page.getByText('Follow-up done.', { exact: true })).toBeVisible();
  await expect(page.getByText('by you')).toBeVisible();
  writeFileSync(join(data, 'gate-passed'), 'ok');
  await app.close();
});

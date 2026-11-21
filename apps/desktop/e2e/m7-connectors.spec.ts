import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T04: a personal MCP server reaches the agent; the board explains what it needs', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('region', { name: 'Work item sync' })).toBeVisible();
  await dialog.getByLabel('Personal MCP servers (YAML)').fill('- name: notes\n  command: ["node", "notes.js"]\n');
  await dialog.getByRole('button', { name: 'Save servers' }).click();
  await expect(page.getByText('Personal MCP servers saved.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('mcp');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('MCP servers: notes.')).toBeVisible();

  await page.getByRole('button', { name: 'Work items', exact: true }).click();
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByText('The board could not be loaded')).toBeVisible();
  await expect(page.getByText('Connect Shortcut in Settings first.')).toBeVisible();
  await app.close();
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

const ECHO = resolve(__dirname, '../test/fixtures/echo-mcp.mjs');

test('CO-13: the MCP servers dialog lists every source, checks a server, switches it off, edits and removes it', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.ade'));
  writeFileSync(join(repo, '.ade', 'workspace.yaml'), 'mcpServers:\n  - name: repo-docs\n    url: https://mcp.example.com/mcp\n    headers:\n      Authorization: Bearer $ADE_E2E_UNSET_TOKEN\n');
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Open it from the command palette.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('MCP servers');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'MCP servers' });
  const list = dialog.getByRole('list', { name: 'MCP servers' });
  const row = (name: string) => list.getByRole('listitem', { name: new RegExp(`^${name}, `) });
  await expect(row('repo-docs')).toContainText('This repository');
  await expect(row('repo-docs')).toContainText('Needs $ADE_E2E_UNSET_TOKEN');
  await expect(row('ade-runner')).toContainText('Built into ADE');
  await expect(row('shortcut')).toContainText('Off');

  // Add a personal server; a bad name is explained first.
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await dialog.getByLabel('Name').fill('echo tools');
  await dialog.getByLabel('Command', { exact: true }).fill(`"${process.execPath}" "${ECHO}"`);
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Use letters, digits, dashes and underscores in the name.');
  await dialog.getByLabel('Name').fill('echo');
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByText('Added echo.')).toBeVisible();
  await expect(row('echo')).toContainText('On · not checked');

  // Check it: it starts, lists its one tool and stops.
  await row('echo').getByRole('button', { name: 'Check' }).click();
  await expect(row('echo')).toContainText('Connected · 1 tool', { timeout: 30_000 });
  await expect(row('echo')).toContainText('Repeats what it is given.');
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/mcp-list.png` });

  // Filters.
  await dialog.getByRole('tab', { name: /^Personal/ }).click();
  await expect(list.getByRole('listitem', { name: /, Personal$/ })).toHaveCount(1);
  await expect(row('ade-runner')).toHaveCount(0);
  await dialog.getByRole('tab', { name: /^All/ }).click();

  // Switch it off, then edit and remove it.
  await row('echo').getByRole('switch', { name: 'Pass echo to new sessions' }).click();
  await expect(row('echo')).toContainText('Off');
  await row('repo-docs').getByRole('switch').click();
  await expect(row('repo-docs')).toContainText('Off');
  await row('echo').getByRole('button', { name: 'Edit echo' }).click();
  await dialog.getByLabel('Name').fill('echo2');
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  await dialog.getByLabel('Environment variables: name 1').fill('ECHO_KEY');
  await dialog.getByLabel('Environment variables: value 1').fill('$ECHO_SECRET_VALUE');
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/mcp-form.png` });
  await dialog.getByRole('button', { name: 'Save server' }).click();
  await expect(row('echo2')).toContainText('Off');
  await row('echo2').getByRole('button', { name: 'Show details of echo2' }).click();
  await expect(row('echo2')).toContainText('ECHO_KEY (values not shown)');
  await row('echo2').getByRole('button', { name: 'Remove echo2' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Removed echo2.')).toBeVisible();
  await expect(row('echo2')).toHaveCount(0);
  await app.close();
});

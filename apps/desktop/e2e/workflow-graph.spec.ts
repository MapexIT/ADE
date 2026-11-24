import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

/** Drags from one step's output handle to another step's input handle on the canvas. */
async function connect(page: Page, from: string, to: string) {
  const source = page.locator(`.react-flow__node[data-id="${from}"] .react-flow__handle-right`);
  const target = page.locator(`.react-flow__node[data-id="${to}"] .react-flow__handle-left`);
  const a = (await source.boundingBox())!;
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  // The canvas re-fits after every new connection; let it settle before measuring the next handles.
  await page.waitForTimeout(400);
}

test('WF-01/16/17: a workflow from scratch with parallel steps, a join and a cycle with a round limit', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await page.keyboard.press('Control+3');

  // From scratch: an empty workflow saves at once and shows an empty canvas.
  await page.getByRole('button', { name: 'New workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByLabel('Name').fill('Fan out');
  await expect(dialog.getByLabel('Start from')).toHaveValue('empty');
  await dialog.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByText('An empty workflow')).toBeVisible();
  await expect(page.getByText('This workflow has no steps yet. Add a first step from the palette.')).toBeVisible();
  expect(readFileSync(join(repo, '.ade', 'workflows', 'fan-out.yaml'), 'utf8')).toContain('name: Fan out');

  const toolbar = page.getByRole('toolbar', { name: 'Add a step' });
  for (const type of ['Agent', 'Command', 'Command', 'Gate']) await toolbar.getByRole('button', { name: type, exact: true }).click();
  await page.waitForTimeout(500);

  // One step to two, two steps to one, and back round.
  await connect(page, 'agent', 'command');
  await connect(page, 'agent', 'command-2');
  await connect(page, 'command', 'gate');
  await connect(page, 'command-2', 'gate');
  await connect(page, 'gate', 'agent');
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/wf-connected.png` });
  await expect(page.locator('.react-flow__node[data-id="gate"]')).toContainText('waits for 2 inputs');
  await expect(page.locator('.react-flow__node[data-id="agent"]')).toContainText('2 next steps');

  // The connection that closes the cycle is marked with its limit; its settings change it.
  // The cycle edge is animated, so its label never counts as "stable"; click it directly.
  await page.getByText('max 1 round', { exact: true }).click({ force: true });
  const settings = page.getByRole('region', { name: 'Connection settings' });
  await expect(settings).toContainText('closes a cycle');
  await expect(settings.getByLabel('Maximum rounds')).toHaveValue('1');
  await settings.getByLabel('Maximum rounds').fill('3');
  await settings.getByLabel('Follow this connection').selectOption('fail');
  await expect(page.getByText('on fail · max 3 rounds', { exact: true })).toBeVisible();
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/workflow-graph.png` });

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  const yaml = readFileSync(join(repo, '.ade', 'workflows', 'fan-out.yaml'), 'utf8');
  expect(yaml).toContain('maxRounds: 3');
  expect(yaml.match(/from: agent/g)).toHaveLength(2);
  expect(yaml.match(/to: gate/g)).toHaveLength(2);
  await app.close();
});

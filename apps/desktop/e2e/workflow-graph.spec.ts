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
  if (process.env.ADE_SHOTS) {
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/wf-connected.png` });
    // A hovered connection point lights up violet.
    await page.locator('.react-flow__node[data-id="command"] .react-flow__handle-right').hover();
    await page.waitForTimeout(300);
    const box = (await page.locator('.react-flow__node[data-id="command"]').boundingBox())!;
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/wf-handle-hover.png`, clip: { x: box.x - 30, y: box.y - 20, width: box.width + 60, height: box.height + 40 } });
    await page.mouse.move(0, 0);
  }
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

test('WF-01: each step type has its own shape, and dragging a step never hides the canvas', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await page.keyboard.press('Control+3');
  await page.getByRole('button', { name: 'New workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByLabel('Name').fill('Shapes');
  await dialog.getByRole('button', { name: 'Create workflow' }).click();

  const types = ['Agent', 'Command', 'Gate', 'Loop', 'Branch', 'Connector', 'Land'];
  const toolbar = page.getByRole('toolbar', { name: 'Add a step' });
  for (const type of types) await toolbar.getByRole('button', { name: type, exact: true }).click();
  for (const type of types) await expect(page.locator(`.ade-step-${type.toLowerCase()}`)).toHaveCount(1);
  await page.waitForTimeout(500);
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/workflow-shapes.png` });

  // Connection points are a 14px dot with a 24px hit area, outside every clipped outline: the pointer just beside
  // the dot still lands on the handle, on every step type. (The canvas is fitted, so measure at the current zoom.)
  for (const type of types) {
    const handle = page.locator(`.ade-step-${type.toLowerCase()} .react-flow__handle-right`);
    const size = await handle.evaluate((node) => {
      const el = node as HTMLElement;
      const zoom = el.getBoundingClientRect().width / el.offsetWidth;
      const r = el.getBoundingClientRect();
      const reach = 11 * zoom;
      const hit = document.elementFromPoint(r.x + r.width / 2 + reach, r.y + r.height / 2);
      return { dot: el.offsetWidth, area: parseFloat(getComputedStyle(el, '::before').width), hit: hit === el };
    });
    expect(size).toEqual({ dot: 14, area: 24, hit: true });
  }

  // Mid-drag, every step stays visible: nodes keep their measured size while the canvas rebuilds them.
  const box = (await page.locator('.react-flow__node[data-id="agent"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 + i * 12, box.y + 12 + i * 6);
    const hidden = await page.$$eval('.react-flow__node', (ns) => ns.filter((n) => getComputedStyle(n).visibility === 'hidden').length);
    expect(hidden).toBe(0);
  }
  await page.mouse.up();
  const moved = (await page.locator('.react-flow__node[data-id="agent"]').boundingBox())!;
  expect(moved.x).toBeGreaterThan(box.x + 40);
  await app.close();
});

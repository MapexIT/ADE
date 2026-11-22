import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

async function openSmartTerminal(page: Page) {
  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
}

test('the terminal and its command blocks are resized with a divider, by mouse and keyboard, and the split is kept', async () => {
  const repo = makeRepo();
  const dir = userDataDir();
  let { app, page } = await launch(dir);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await openSmartTerminal(page);

  const divider = page.getByRole('separator', { name: 'Resize the terminal and its command blocks' }).last();
  await expect(divider).toBeVisible();
  const before = Number(await divider.getAttribute('aria-valuenow'));
  expect(before).toBeGreaterThan(40);
  expect(before).toBeLessThan(75);

  // Drag the divider 200px to the left: the terminal gets narrower, the blocks wider.
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await divider.getAttribute('aria-valuenow'));
  expect(dragged).toBeLessThan(before - 10);

  // Keyboard: Right widens the terminal, End takes it to its widest, Enter restores the default.
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', String(dragged + 2));
  await page.keyboard.press('End');
  const widest = Number(await divider.getAttribute('aria-valuenow'));
  expect(widest).toBeGreaterThan(dragged + 2);
  await page.keyboard.press('Home');
  const narrowest = Number(await divider.getAttribute('aria-valuenow'));
  expect(narrowest).toBeLessThan(dragged);
  await app.close();

  // The split is remembered.
  ({ app, page } = await launch(dir));
  await openSmartTerminal(page);
  await expect(page.getByRole('separator', { name: 'Resize the terminal and its command blocks' }).last()).toHaveAttribute('aria-valuenow', String(narrowest));
  await app.close();
});

import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('generation methods need confirmation away from IO; the prompt board sends selected boxes and is kept across restarts', async () => {
  const repo = makeRepo();
  const dir = userDataDir();
  let { app, page } = await launch(dir);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say ready');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  const session = page.getByRole('main', { name: 'Session' });
  await expect(session.getByText('Turn 1 · finished')).toBeVisible();

  // IO is the default. Leaving it asks first; keeping the current method changes nothing.
  const method = page.getByLabel('Generation method', { exact: true });
  await expect(method).toHaveValue('io');
  await method.selectOption('got');
  const dialog = page.getByRole('dialog', { name: 'Switch generation to Graph of Thought?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('9 extra calls');
  await dialog.getByRole('button', { name: 'Keep current method' }).click();
  await expect(method).toHaveValue('io');

  // Accept CoT Self-Consistency with two paths; the run shows in the timeline and its approach is sent.
  await method.selectOption('cot-sc');
  const sc = page.getByRole('dialog', { name: 'Switch generation to CoT Self-Consistency?' });
  await sc.getByLabel('Reasoning paths').fill('2');
  await expect(sc).toContainText('2 extra calls');
  await sc.getByRole('button', { name: 'Use CoT Self-Consistency' }).click();
  await expect(method).toHaveValue('cot-sc');
  await page.getByLabel('Message Fake agent').fill('say FINAL APPROACH: patch the parser');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const run = page.getByRole('region', { name: 'Reasoning: CoT Self-Consistency' });
  await expect(run.getByText('Sent to the agent')).toBeVisible({ timeout: 30_000 });
  await expect(run.getByText('2/2 agent calls · read-only')).toBeVisible();
  await expect(run.getByText('Chosen approach')).toBeVisible();
  await expect(session.getByText('Turn 2 · finished')).toBeVisible({ timeout: 30_000 });

  // Back to IO needs no confirmation.
  await method.selectOption('io');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(method).toHaveValue('io');

  // The board: two boxes, only the selected one is sent.
  await page.getByRole('radio', { name: 'Board' }).click();
  await page.getByRole('button', { name: 'Add text box' }).click();
  await page.getByLabel('Title of Untitled box').fill('Goal');
  await page.getByLabel('Text of Goal').fill('say from the goal box');
  await page.getByRole('button', { name: 'Add text box' }).click();
  await page.getByLabel('Text of Untitled box').fill('say left out');
  // A box's header is the toggle; click a free part of it (not the move handle, title or delete button).
  const includeUntitled = page.getByRole('button', { name: 'Include Untitled box in the prompt' });
  await expect(includeUntitled).toHaveAttribute('aria-pressed', 'true');
  await includeUntitled.click({ position: { x: 200, y: 8 } });
  await expect(includeUntitled).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('1 of 2 boxes in the prompt')).toBeVisible();
  // The toggle works from the keyboard too.
  await includeUntitled.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('2 of 2 boxes in the prompt')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 of 2 boxes in the prompt')).toBeVisible();
  // Move the goal box with the keyboard.
  await page.getByRole('button', { name: /^Move Goal/ }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(session.getByText('from the goal box', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(session.getByText('left out', { exact: true })).toHaveCount(0);
  const goal = page.getByRole('region', { name: 'Text box: Goal' });
  const top = await goal.evaluate((el) => (el as HTMLElement).style.top);

  // The board belongs to the workspace: a second session starts in Chat but its board has the same boxes.
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say second');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(session.getByRole('heading', { name: 'say second' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Board' }).click();
  await expect(page.getByLabel('Text of Goal')).toHaveValue('say from the goal box');
  await expect(page.getByText('Shared by this workspace')).toBeVisible();
  // Editing it here shows in the first session too.
  await page.getByLabel('Text of Untitled box').fill('say edited in the second session');
  await page.getByRole('button', { name: /^say ready/ }).first().click();
  await expect(page.getByLabel('Text of Untitled box')).toHaveValue('say edited in the second session');
  // Give the debounced save time to land before quitting.
  await page.waitForTimeout(800);
  await app.close();

  // After a restart: board mode, both boxes with their content, selection and position.
  ({ app, page } = await launch(dir));
  await expect(page.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Text of Goal')).toHaveValue('say from the goal box');
  await expect(page.getByRole('button', { name: 'Include Untitled box in the prompt' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Text box: Goal' })).toHaveAttribute('style', new RegExp(`top: ${top}`));
  await expect(page.getByLabel('Generation method', { exact: true })).toHaveValue('io');

  // Rubber-band selection: drag on empty board space; boxes the band touches are selected on release.
  const board = page.getByRole('region', { name: 'Prompt board' });
  await board.scrollIntoViewIfNeeded();
  const pressed = (name: string) => page.getByRole('button', { name: `Include ${name} in the prompt` });
  const goalBox = (await page.getByRole('region', { name: 'Text box: Goal' }).boundingBox())!;
  const otherBox = (await page.getByRole('region', { name: 'Text box: Untitled box' }).boundingBox())!;
  const corner = (await board.boundingBox())!;
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, shot?: string) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await expect(page.getByTestId('prompt-board-band')).toBeVisible();
    if (shot && process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/${shot}.png` });
    await page.mouse.up();
    await expect(page.getByTestId('prompt-board-band')).toHaveCount(0);
  };
  // A plain drag below the second box, up into it, replaces the selection with just that box.
  await drag({ x: otherBox.x + 40, y: otherBox.y + otherBox.height + 12 }, { x: otherBox.x + 60, y: otherBox.y + 40 }, 'board-band');
  await expect(pressed('Untitled box')).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed('Goal')).toHaveAttribute('aria-pressed', 'false');
  // Ctrl+drag from the board's top-left corner into the goal box adds it.
  await page.keyboard.down('Control');
  await drag({ x: corner.x + 4, y: corner.y + 4 }, { x: goalBox.x + 30, y: goalBox.y + 30 });
  await page.keyboard.up('Control');
  await expect(page.getByText('2 of 2 boxes in the prompt')).toBeVisible();
  // A click on empty space, and a band that touches nothing, keep the selection.
  await page.mouse.click(corner.x + 4, corner.y + 4);
  await drag({ x: corner.x + 4, y: corner.y + 4 }, { x: corner.x + 12, y: corner.y + 12 });
  await expect(page.getByText('2 of 2 boxes in the prompt')).toBeVisible();

  if (process.env.ADE_SHOTS) {
    await page.getByRole('region', { name: 'Prompt board' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/board.png` });
    await page.getByLabel('Generation method', { exact: true }).selectOption('foa');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/dialog.png` });
    await page.getByRole('button', { name: 'Keep current method' }).click();
    // The reasoning run belongs to the first session; the restart may reopen the second.
    await page.getByRole('button', { name: /^say ready/ }).first().click();
    await page.getByRole('radio', { name: 'Chat' }).click();
    await page.getByText('Chosen approach').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/reasoning.png` });
  }
  await app.close();
});

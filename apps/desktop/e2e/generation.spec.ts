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

  // Accept CoT self-consistency with two paths; the run shows in the timeline and its approach is sent.
  await method.selectOption('cot-sc');
  const sc = page.getByRole('dialog', { name: 'Switch generation to CoT self-consistency?' });
  await sc.getByLabel('Reasoning paths').fill('2');
  await expect(sc).toContainText('2 extra calls');
  await sc.getByRole('button', { name: 'Use CoT self-consistency' }).click();
  await expect(method).toHaveValue('cot-sc');
  await page.getByLabel('Message Fake agent').fill('say FINAL APPROACH: patch the parser');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const run = page.getByRole('region', { name: 'Reasoning: CoT self-consistency' });
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
  await page.getByLabel('Use Untitled box in the prompt').uncheck();
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
  await expect(page.getByLabel('Use Untitled box in the prompt')).not.toBeChecked();
  await expect(page.getByRole('region', { name: 'Text box: Goal' })).toHaveAttribute('style', new RegExp(`top: ${top}`));
  await expect(page.getByLabel('Generation method', { exact: true })).toHaveValue('io');
  if (process.env.ADE_SHOTS) {
    await page.getByRole('region', { name: 'Prompt board' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/board.png` });
    await page.getByLabel('Generation method', { exact: true }).selectOption('foa');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/dialog.png` });
    await page.getByRole('button', { name: 'Keep current method' }).click();
    await page.getByRole('radio', { name: 'Chat' }).click();
    await page.getByText('Chosen approach').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/reasoning.png` });
  }
  await app.close();
});

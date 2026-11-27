import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

async function startSession(page: Page, title: string, prompt: string) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(prompt);
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** Clicks the line of the diff's new side that shows `text`, then presses T. */
async function traceLine(page: Page, text: string) {
  const line = page.locator('.editor.modified .view-line').filter({ hasText: text }).first();
  await expect(line).toBeVisible();
  await line.click();
  await page.keyboard.press('t');
}

test('RV-17: trace a line to its turn, prompt and approval; unreported files and the Prompts view', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await startSession(page, 'Trace task', 'edit app.txt alpha');
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  // Turn 2: an approval, then an edit that adds beta, a command, and a file written without a reported edit.
  await page.getByLabel('Message Fake agent').fill('ask npm test\nedit app.txt alpha\\nbeta\nrun git --version\ntouch gen.txt generated\\n');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('region', { name: 'Approval request' }).getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();

  await page.keyboard.press('Control+7');
  const files = page.getByRole('complementary', { name: 'Changed files' });
  await files.getByRole('button', { name: 'app.txt' }).click();
  await traceLine(page, 'beta');
  const card = page.getByRole('complementary', { name: 'Trace' });
  await expect(card).toBeFocused();
  await expect(card).toContainText('app.txt · Line 2');
  await expect(card.getByText('Turn 2', { exact: true }).first()).toBeVisible();
  await expect(card.getByRole('region', { name: 'Prompt' })).toContainText('ask npm test');
  await expect(card.getByRole('region', { name: 'Tool call' })).toContainText('Edit app.txt');
  await expect(card.getByRole('region', { name: 'Approvals' })).toContainText('Run npm test: Allow once, decided by you');
  // The gutter shows each line's turn next to its number.
  await expect(page.locator('.editor.modified .line-numbers').filter({ hasText: 'T2' }).first()).toBeVisible();
  await expect(page.locator('.editor.modified .line-numbers').filter({ hasText: 'T1' }).first()).toBeVisible();

  if (process.env.ADE_TRACE_SHOT) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.ADE_TRACE_SHOT });
  }

  // The first line was written in turn 1.
  await traceLine(page, 'alpha');
  await expect(card).toContainText('app.txt · Line 1');
  await expect(card.getByText('Turn 1', { exact: true }).first()).toBeVisible();
  await expect(card.getByRole('region', { name: 'Prompt' })).toContainText('edit app.txt alpha');

  // A file written by a command: not reported as an edit, with the turn's commands.
  await files.getByRole('button', { name: 'gen.txt' }).click();
  await expect(card).toBeHidden();
  await traceLine(page, 'generated');
  await expect(card.getByText('Not reported as an edit').first()).toBeVisible();
  await expect(card.getByRole('region', { name: 'Commands in this turn' })).toContainText('git --version');
  await card.getByRole('button', { name: 'Comment to agent' }).click();
  await expect(page.getByLabel('Comment on line 1 for the agent')).toHaveValue(/written in turn 2, when I asked/);
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Prompts: one group per turn plus the not-reported group, totals equal to the Files view.
  await files.getByRole('button', { name: 'Prompts' }).click();
  await expect(files.getByRole('region', { name: 'Turn 1' })).toBeVisible();
  await expect(files.getByRole('region', { name: 'Turn 2' })).toBeVisible();
  const unreported = files.getByRole('region', { name: 'Not reported as an edit' });
  await expect(unreported).toContainText('gen.txt:1');
  await expect(files.getByText('+3 -0 across 3 groups')).toBeVisible();

  // Open in timeline jumps to the tool call that wrote the line.
  await files.getByRole('region', { name: 'Turn 2' }).getByRole('button', { name: /app\.txt:2/ }).click();
  await page.locator('.editor.modified .view-line').filter({ hasText: 'beta' }).first().click();
  await page.getByRole('button', { name: 'Trace line' }).click();
  await card.getByRole('button', { name: 'Open in timeline' }).click();
  await expect(page.locator('[data-marked]')).toContainText('app.txt');
  await app.close();
});

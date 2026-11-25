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

test('RV-16: unproven claims are flagged, proven or marked as checked, and named when landing', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  let { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await startSession(page, 'Receipt task', 'edit src/a.txt hello\nsay All tests pass and the build succeeds.');

  const receipts = page.getByRole('region', { name: 'Turn receipt' });
  const first = receipts.filter({ hasText: 'Says the build succeeds.' });
  await expect(first).toContainText('Says the tests pass.');
  await expect(first).toContainText('ADE saw no test command in this turn.');
  await expect(first).toContainText('1 file changed, no commands. 2 things to check.');
  await expect(first.getByText('Not seen', { exact: true })).toHaveCount(2);
  const header = page.getByRole('heading', { name: 'Receipt task' }).locator('..');
  await expect(header.getByText('2 to check')).toBeVisible();
  if (process.env.ADE_SHOTS) {
    // A taller window, so the whole card fits below the session header.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1200));
    await page.waitForTimeout(400);
    await first.screenshot({ path: `${process.env.ADE_SHOTS}/turn-receipt.png` });
  }

  // The land confirmation names the open items; landing stays possible.
  await page.keyboard.press('Control+7');
  await expect(page.getByRole('region', { name: 'Receipts to check' })).toContainText('Says the build succeeds. ADE saw no build command in this turn.');
  await page.getByRole('button', { name: 'Apply to my checkout' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText("The agent's receipts still have 2 things to check");
  await expect(dialog.getByRole('button', { name: 'Apply to my checkout' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
  await page.keyboard.press('Control+1');

  // "Ask for proof" only fills the message box.
  await first.getByRole('button', { name: 'Ask for proof' }).click();
  const box = page.getByRole('textbox', { name: 'Message Fake agent' });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/^Before I review this/);
  await expect(page.getByText('Turn 2', { exact: false })).toHaveCount(0);
  await box.fill('ask npm test\nsay All tests pass.');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('region', { name: 'Approval request' }).getByRole('button', { name: 'Allow once' }).click();

  const second = receipts.filter({ hasText: 'Supported' });
  await expect(second).toContainText('Run npm test (completed) passed after the last change.');
  await expect(first).toContainText('Passed in a later turn.');
  await expect(first.getByText('Passed later', { exact: true })).toBeVisible();
  await expect(header.getByText('1 to check')).toBeVisible();

  await first.getByRole('button', { name: 'Mark as checked' }).click();
  await expect(first).toContainText('Marked as checked by you.');
  await expect(first.getByRole('button', { name: 'Ask for proof' })).toHaveCount(0);
  await expect(header.getByText(/to check$/)).toHaveCount(0);
  await app.close();

  // Everything is rebuilt from the stored events after a restart.
  ({ app, page } = await launch(data));
  await expect(page.getByRole('heading', { name: 'Receipt task' })).toBeVisible();
  const after = page.getByRole('region', { name: 'Turn receipt' });
  await expect(after).toHaveCount(2);
  await expect(after.filter({ hasText: 'Says the build succeeds.' })).toContainText('Marked as checked by you.');
  await expect(after.filter({ hasText: 'Supported' })).toContainText('Run npm test (completed) passed after the last change.');
  await expect(page.getByRole('heading', { name: 'Receipt task' }).locator('..').getByText(/to check$/)).toHaveCount(0);
  await app.close();
});

test('RV-16: an edit Git does not see and switched-off tests are flagged', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await startSession(page, 'Receipt findings', "ghost src/b.txt hello\nedit src/math.test.js it.skip('adds', () => {})\nsay Done.");

  const card = page.getByRole('region', { name: 'Turn receipt' });
  await expect(card).toContainText('Reported an edit that Git does not see: src/b.txt');
  await expect(card).toContainText('Tests switched off or narrowed: src/math.test.js (1 marker added)');
  await expect(card).toContainText('2 things to check.');
  await app.close();
});

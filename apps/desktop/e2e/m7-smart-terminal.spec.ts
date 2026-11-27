import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T05: suggested and drafted commands run from pending blocks; guard rails, history and inline views', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // SM-09: the agent proposes a command in a shell block.
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say Try this:\\n```bash\\ngit status --short\\n```');
  await page.getByLabel('Title (optional)').fill('Suggest');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();

  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
  await page.waitForTimeout(2500);
  const suggestions = page.getByRole('region', { name: 'Suggested commands' });
  await expect(suggestions).toContainText('git status --short');
  await suggestions.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'git status --short' })).toBeVisible({ timeout: 20_000 });
  // Copy output reaches the system clipboard (through the main process; the renderer has no clipboard permission).
  const block = page.getByRole('region', { name: /Command block, succeeded/ }).filter({ hasText: 'git status --short' });
  // Record what reaches Electron's clipboard (CI machines may have no clipboard to read back).
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { copied: string[] };
    g.copied = [];
    clipboard.writeText = async (text: string) => {
      g.copied.push(text);
    };
  });
  await block.getByRole('button', { name: 'Copy output' }).click();
  await expect(page.getByText('Copied.')).toBeVisible();
  const copied = await app.evaluate(() => (globalThis as unknown as { copied: string[] }).copied);
  expect(copied).toHaveLength(1);
  expect(copied[0]?.startsWith('$ git status --short')).toBe(true);
  expect(copied[0]?.trimEnd().endsWith('[exit 0]')).toBe(true);

  // SM-10: a drafted command arrives as a suggestion; SM-12 shows its JSON output inline.
  const ask = page.getByRole('form', { name: 'Ask for a command' });
  await ask.getByLabel('Describe the command you need').fill('say node -e "console.log(JSON.stringify({ok:true,n:2}))"');
  await ask.getByLabel('Agent that drafts the command').selectOption({ label: 'Fake agent' });
  await ask.getByRole('button', { name: 'Draft' }).click();
  await expect(suggestions).toContainText('JSON.stringify');
  await suggestions.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('main').getByLabel('JSON')).toBeVisible({ timeout: 20_000 });

  // SM-14: a destructive suggestion asks first.
  await page.keyboard.press('Control+1');
  await page.getByLabel('Message Fake agent').fill('say ```sh\\ngit reset --hard HEAD\\n```');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();
  await page.keyboard.press('Control+5');
  await suggestions.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('dialog', { name: 'Run a destructive command?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep it' }).click();

  // SM-11: the commands are in the history.
  await page.getByRole('button', { name: 'Command history' }).click();
  await page.getByLabel('Search commands').fill('git status');
  await expect(page.getByRole('dialog', { name: 'Command history' }).getByText('git status --short')).toBeVisible();
  await app.close();
});

import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

// One line of JavaScript the fake agent writes into the worktree: the first run prints two tsc-style problems, every
// later run prints one of them on another line plus a new one. It exits with 1 either way. Plain `node`, no shell
// syntax, so the same spec runs with PowerShell on Windows and bash on Linux.
const SCRIPT = [
  'import fs from "node:fs";',
  'const again = fs.existsSync(".second");',
  'fs.writeFileSync(".second", "1");',
  'const lines = again',
  '? ["src/b.ts(9,5): error TS2304: Cannot find name foo.", "src/c.ts(3,1): error TS1005: Semicolon expected."]',
  ': ["src/a.ts(1,1): error TS2322: Type mismatch.", "src/b.ts(2,5): error TS2304: Cannot find name foo."];',
  'for (const l of lines) console.log(l);',
  'process.exit(1);',
].join(' ');

test('SM-18: problems in a block are compared with the previous run, open at their line and go to the agent', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(`edit problems.mjs ${SCRIPT}\nedit src/b.ts export const b = 1;\nsay Ready.`);
  await page.getByLabel('Title (optional)').fill('Problems');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();

  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
  await page.waitForTimeout(2500);

  // First run: two problems, no comparison yet; the file the session changed says so.
  await page.locator('.xterm').last().click();
  await page.keyboard.type('node problems.mjs');
  await page.keyboard.press('Enter');
  const blocks = page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'node problems.mjs' });
  const first = blocks.first();
  const firstProblems = first.getByRole('region', { name: 'Problems' });
  await expect(firstProblems).toBeVisible({ timeout: 20_000 });
  await expect(firstProblems.getByRole('status')).toHaveText('2 problems.');
  await expect(firstProblems.getByRole('list', { name: 'Current problems' }).getByRole('listitem')).toHaveCount(2);
  await expect(firstProblems.getByText('New', { exact: true })).toHaveCount(0);
  const b1 = firstProblems.getByRole('list', { name: 'Current problems' }).getByRole('listitem').filter({ hasText: 'src/b.ts' });
  await expect(b1).toContainText('src/b.ts:2:5');
  await expect(b1).toContainText('In a file this session changed');
  await expect(firstProblems.getByRole('list', { name: 'Current problems' }).getByRole('listitem').filter({ hasText: 'src/a.ts' })).not.toContainText('In a file this session changed');

  // Re-run: one new, one fixed, one still there although its line moved.
  await first.getByRole('button', { name: 'Re-run' }).click();
  await expect(blocks).toHaveCount(2, { timeout: 20_000 });
  const second = blocks.nth(1);
  const problems = second.getByRole('region', { name: 'Problems' });
  await expect(problems).toBeVisible({ timeout: 20_000 });
  const summary = problems.getByRole('status');
  await expect(summary).toContainText('1 new');
  await expect(summary).toContainText('1 fixed');
  await expect(summary).toContainText('1 still there since');
  await expect(problems.getByRole('list', { name: 'Current problems' }).getByRole('listitem').filter({ hasText: 'src/c.ts' })).toContainText('New');
  const b2 = problems.getByRole('list', { name: 'Current problems' }).getByRole('listitem').filter({ hasText: 'src/b.ts' });
  await expect(b2).toContainText('src/b.ts:9:5');
  await expect(b2).toContainText('Still there');
  await problems.getByText('Fixed (1)').click();
  await expect(problems.getByRole('list', { name: 'Fixed problems' })).toContainText('src/a.ts');

  // The status bar keeps "last exit" and adds the problems segment.
  const status = page.getByLabel('Status bar').last();
  await expect(status).toContainText('last exit 1');
  await expect(status).toContainText('problems 2 · 1 new');
  if (process.env.ADE_SHOTS) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000));
    await page.waitForTimeout(400);
    await second.scrollIntoViewIfNeeded();
    await second.screenshot({ path: `${process.env.ADE_SHOTS}/sm18-block.png` });
    await page.screenshot({ path: `${process.env.ADE_SHOTS}/sm18-terminal.png` });
  }

  // New only.
  const newOnly = problems.getByRole('button', { name: 'New only' });
  await newOnly.click();
  await expect(newOnly).toHaveAttribute('aria-pressed', 'true');
  await expect(problems.getByRole('list', { name: 'Current problems' }).getByRole('listitem')).toHaveCount(1);
  await newOnly.click();
  await expect(problems.getByRole('list', { name: 'Current problems' }).getByRole('listitem')).toHaveCount(2);

  // Every existing block action is still there.
  for (const name of ['Fix with agent', 'Send to agent', 'Re-run', 'Copy output']) await expect(second.getByRole('button', { name, exact: true })).toBeVisible();

  // A row opens the editor on that file.
  await b2.getByRole('button').click();
  await expect(page.getByTitle(/src[\\/]b\.ts$/).first()).toBeVisible();

  // Fix new problems with agent: a turn with only the new problems attached.
  await page.keyboard.press('Control+5');
  await problems.getByRole('button', { name: 'Fix new problems with agent' }).click();
  await expect(page.getByText('Sent to the agent.')).toBeVisible();
  await page.keyboard.press('Control+1');
  // The Session tab is named after the selected session ("Session · Problems").
  await page.getByRole('tab', { name: /^Session · / }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();
  await expect(page.getByText('New problems: node problems.mjs').first()).toBeVisible();
  await app.close();
});

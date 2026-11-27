import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

// One-line scripts the fake agent writes into a worktree. Plain `node`, no shell syntax, so the same spec runs with
// PowerShell on Windows and bash on Linux.
const NOISY = [
  'import fs from "node:fs";',
  'const again = fs.existsSync(".noisy");',
  'fs.writeFileSync(".noisy", "1");',
  'for (let i = 1; i <= 200; i++) {',
  'if (i === 50 || i === 120 || i === 180) console.log("line " + i + " error: something broke");',
  'else if (i === 100) console.log(again ? "line 100 says something new" : "line 100 plain text");',
  'else console.log("line " + i + " ok in " + (again ? 7 : 3) + " ms"); }',
].join(' ');
const WATCH = 'setTimeout(() => console.log("ready on 3000"), 1000); setTimeout(() => process.exit(1), 5000);';
const PASS = 'console.log("all checks passed"); process.exit(0);';
const FAIL = 'console.log("src/x.ts(3,7): error TS2304: Cannot find name foo."); process.exit(1);';

async function startSession(page: Page, title: string, script: string) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(`${script}\nsay Ready.`);
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
}

async function openApp() {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  return { app, page };
}

async function newSmartTerminal(page: Page) {
  await page.keyboard.press('Control+5');
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  await expect(page.locator('.xterm').last()).toBeVisible();
  // Give the shell time to load its profile and report integration.
  await page.waitForTimeout(2500);
}

async function run(page: Page, command: string) {
  await page.locator('.xterm').last().click();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('SM-20: a block is filtered by text, with context, follows a re-run, shows what changed and goes to the agent', async () => {
  const { app, page } = await openApp();
  await startSession(page, 'Noisy', `edit noisy.mjs ${NOISY}`);
  await newSmartTerminal(page);
  await run(page, 'node noisy.mjs');
  const blocks = page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'node noisy.mjs' });
  await expect(blocks.first()).toHaveAttribute('aria-label', 'Command block, succeeded', { timeout: 20_000 });

  // Ctrl+Shift+L from the terminal filters the latest finished block; the shell never sees the key.
  await page.locator('.xterm').last().click();
  await page.keyboard.press('Control+Shift+L');
  const filter = blocks.first().getByRole('region', { name: 'Filter' });
  await expect(filter.getByLabel('Filter lines')).toBeFocused();
  await page.keyboard.type('error');
  await expect(filter.getByRole('status')).toHaveText(/^3 of \d+ lines$/);
  const shown = filter.getByRole('list', { name: 'Shown lines' }).getByRole('listitem');
  await expect(shown).toHaveCount(3);
  // PowerShell under ConPTY puts the prompt line and some blank screen rows in the output too, so the total varies.
  await expect(shown.first()).toContainText('line 50 error: something broke');

  // A regular expression runs in a worker; an invalid one says so.
  await filter.getByRole('button', { name: 'Regular expression' }).click();
  await filter.getByLabel('Filter lines').fill('line (50|120) err');
  await expect(filter.getByRole('status')).toHaveText(/^2 of \d+ lines$/);
  await filter.getByLabel('Filter lines').fill('line (50');
  await expect(filter.getByRole('status')).toHaveText('This pattern is not a valid regular expression.');
  await filter.getByRole('button', { name: 'Regular expression' }).click();
  await filter.getByLabel('Filter lines').fill('error');
  await expect(shown).toHaveCount(3);

  await filter.getByLabel('Lines of context').fill('1');
  await expect(shown).toHaveCount(9);

  // Re-run: the new block opens already filtered.
  await blocks.first().getByRole('button', { name: 'Re-run' }).click();
  await expect(blocks).toHaveCount(2, { timeout: 20_000 });
  await expect(blocks.nth(1)).toHaveAttribute('aria-label', 'Command block, succeeded', { timeout: 20_000 });
  const second = blocks.nth(1).getByRole('region', { name: 'Filter' });
  // On Windows ConPTY may repaint a line of the previous screen into the next block, so only the shape is checked.
  await expect(second.getByRole('status')).toHaveText(/^\d+ of \d+ lines$/);
  await expect(second.getByLabel('Filter lines')).toHaveValue('error');
  await expect(blocks.first().getByRole('region', { name: 'Filter' })).toHaveCount(0);

  // Changed since last run: only line 100 differs (the timings are numbers, so they do not count).
  await second.getByRole('button', { name: 'Changed since last run' }).click();
  await second.getByLabel('Lines of context').fill('0');
  const changed = second.getByRole('list', { name: 'Shown lines' }).getByRole('listitem');
  await expect(changed.filter({ hasText: 'line 100 says something new' })).toHaveCount(1);
  await expect(changed.filter({ hasText: /line \d+ ok in/ })).toHaveCount(0);

  await second.getByRole('button', { name: 'Send shown lines to agent' }).click();
  await expect(page.getByText('Attached to the next prompt.')).toBeVisible();

  // Every existing block action is still there.
  for (const name of ['Send to agent', 'Re-run', 'Copy output', 'Filter']) await expect(blocks.nth(1).getByRole('button', { name, exact: true })).toBeVisible();

  // Clear filter restores the output.
  await second.getByRole('button', { name: 'Clear filter' }).click();
  await expect(blocks.nth(1).getByRole('region', { name: 'Filter' })).toHaveCount(0);
  await expect(blocks.nth(1)).toContainText('line 199 ok in 7 ms');

  await page.keyboard.press('Control+1');
  // The session panel shows the composer with the attachment.
  await expect(page.getByLabel('Attachments')).toContainText('Filtered output: node noisy.mjs');
  await app.close();
});

test('SM-19: a watched command reports what it printed and that it failed, in the list, the inbox and the ring', async () => {
  const { app, page } = await openApp();
  await startSession(page, 'Watcher', `edit watch.mjs ${WATCH}`);
  await newSmartTerminal(page);

  // Ctrl+Shift+M with nothing running arms the next command.
  await page.locator('.xterm').last().click();
  await page.keyboard.press('Control+Shift+M');
  const pop = page.getByLabel('Watch this command');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('Tell me when the next command');
  await pop.getByRole('radio', { name: 'Fails' }).check();
  await pop.getByRole('checkbox', { name: 'Prints' }).check();
  await pop.getByLabel('Text to watch for').fill('READY');
  await pop.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Watching', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await run(page, 'node watch.mjs');
  const list = page.getByRole('complementary', { name: 'Terminals' });
  // A second terminal takes the screen; the first keeps running out of sight.
  await page.getByRole('button', { name: 'New terminal' }).first().click();
  await page.getByRole('menuitem', { name: /^Smart · / }).first().click();
  const flagged = list.locator('button[data-attention]');
  await expect(flagged).toContainText('Printed: ready on 3000', { timeout: 15_000 });
  await expect(flagged).toContainText('Failed · exit 1', { timeout: 15_000 });
  await expect(flagged).toHaveClass(/attention-ring/);

  await page.keyboard.press('Control+i');
  const entry = page.getByRole('option').filter({ hasText: 'node watch.mjs failed in Watcher' });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Failed · exit 1');
  await entry.getByRole('button').first().click();
  // Selecting the terminal clears the ring; the watch has ended with the command.
  await expect(list.locator('button[data-attention]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await app.close();
});

test('SM-21: a block runs in another worktree and the outcomes are compared', async () => {
  const { app, page } = await openApp();
  await startSession(page, 'Second try', `edit check.mjs ${FAIL}`);
  await startSession(page, 'First try', `edit check.mjs ${PASS}`);
  await newSmartTerminal(page);
  await run(page, 'node check.mjs');
  const origin = page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'node check.mjs' }).first();
  await expect(origin).toHaveAttribute('aria-label', 'Command block, succeeded', { timeout: 20_000 });

  await page.locator('.xterm').last().click();
  await page.keyboard.press('Control+Shift+E');
  const dialog = page.getByRole('dialog', { name: 'Run in other worktrees' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Second try/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Your checkout/ })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /First try/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Run in 1 worktree' }).click();

  const table = origin.getByRole('region', { name: 'Comparison' });
  await expect(table).toBeVisible();
  const rows = table.getByRole('row');
  await expect(rows.nth(1)).toContainText('First try (ran here)');
  await expect(rows.nth(1)).toContainText('Passed');
  await expect(rows.nth(2)).toContainText('Failed · exit 1', { timeout: 30_000 });
  await expect(rows.nth(2).getByRole('cell').nth(2)).toHaveText('1', { timeout: 15_000 });
  await expect(table.getByRole('status')).toHaveText('1 of 2 passed. Second try failed with exit 1.');

  // The comparison's terminal is an ordinary smart terminal of the other session.
  await rows.nth(2).getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByRole('main').getByText('Compare · node check.mjs', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Command block/ }).filter({ hasText: 'node check.mjs' }).first()).toContainText('Cannot find name foo');
  await app.close();
});

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

async function startSession(page: Page, title: string, prompt: string) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(prompt);
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible({ timeout: 30_000 });
}

test('PL-06: fit matrix, a check that passes alone and fails together, and landing in order', async () => {
  const repo = makeRepo();
  // The check fails only when both a.txt and b.txt exist: each session passes alone, A and B together fail.
  writeFileSync(join(repo, 'check.js'), "const f = require('fs');\nprocess.exit(f.existsSync('a.txt') && f.existsSync('b.txt') ? 1 : 0);\n");
  // The check runs through npm, so Node's own npm.cmd must resolve on Windows (it once ended with no exit code).
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node check.js' } }, null, 2));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'check'], { cwd: repo });

  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // A run configuration "both" (Run page), chosen as the check in Review after session A.
  await page.keyboard.press('Control+6');
  await page.getByLabel('Name', { exact: true }).fill('both');
  await page.getByLabel('Command').fill('npm test');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.keyboard.press('Control+1');
  await startSession(page, 'Session A', 'edit a.txt one');
  await page.keyboard.press('Control+7');
  const checks = page.getByRole('region', { name: 'Checks' });
  await checks.getByRole('button', { name: 'Choose checks' }).click();
  await checks.getByRole('checkbox', { name: /^both/ }).check();
  await checks.getByRole('checkbox', { name: 'Run after every turn' }).check();
  await checks.getByRole('button', { name: 'Run checks' }).click();
  await expect(checks.getByText('Passed', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press('Control+1');
  for (const [title, prompt] of [
    ['Session B', 'edit b.txt two'],
    ['Session C', 'edit a.txt other'],
  ] as const) {
    await startSession(page, title, prompt);
    await expect(page.getByText('Checks: all 1 passed.')).toBeVisible({ timeout: 30_000 });
  }

  // Ctrl 0 opens Integrate. A and C changed the same line of a.txt.
  await page.keyboard.press('Control+0');
  const integrate = page.getByRole('main', { name: 'Integrate' });
  await expect(integrate.getByRole('button', { name: 'Session A and Session C: Conflicts, 1 file' })).toBeVisible({ timeout: 30_000 });
  await expect(integrate.getByRole('button', { name: 'Session A and Session B: Fits' })).toBeVisible();
  await integrate.getByRole('button', { name: 'Session A and Session C: Conflicts, 1 file' }).click();
  await expect(integrate.getByRole('complementary', { name: 'Details' }).getByRole('list', { name: 'Conflicted files' })).toContainText('a.txt');
  if (process.env.ADE_INTEGRATE_SHOT) await page.screenshot({ path: join(process.env.ADE_INTEGRATE_SHOT, 'integrate-matrix.png') });

  // Order A then B (C left out), with the checks on the result.
  await integrate.getByRole('checkbox', { name: 'Include Session C' }).uncheck();
  await integrate.getByRole('checkbox', { name: 'Run the checks on the result' }).check();
  await integrate.getByRole('button', { name: 'Try in this order' }).click();
  const combined = integrate.getByRole('region', { name: 'Combined checks' });
  await expect(combined.getByText('Passed alone, fails together')).toBeVisible({ timeout: 60_000 });
  await expect(integrate.getByRole('button', { name: 'Step 2, Session B: Fits' })).toBeVisible();
  if (process.env.ADE_INTEGRATE_SHOT) await page.screenshot({ path: join(process.env.ADE_INTEGRATE_SHOT, 'integrate-trial.png') });

  // Leave B out too and try again: A alone passes; Land in order asks once and lands A.
  await integrate.getByRole('checkbox', { name: 'Include Session B' }).uncheck();
  await integrate.getByRole('button', { name: 'Try again in this order' }).click();
  await expect(combined.getByText('Passes', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(existsSync(join(repo, 'a.txt'))).toBe(false);
  await integrate.getByRole('button', { name: 'Land in order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Land 1 session?' });
  await expect(dialog).toContainText('Not reviewed: a.txt');
  await dialog.getByRole('button', { name: 'Land in order' }).click();
  await expect.poll(() => existsSync(join(repo, 'a.txt')) && readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one');
  await expect(integrate.getByText('Landed: Session A.')).toBeVisible();
  expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  await app.close();
});

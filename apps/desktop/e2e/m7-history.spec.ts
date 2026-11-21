import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T06: search sessions, see instruction files, export the audit log redacted', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('say The quokka migration is done.');
  await page.getByLabel('Title (optional)').fill('Quokka');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();

  // HI-06
  await page.getByRole('button', { name: 'Search sessions' }).click();
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('quokka migration');
  const dialog = page.getByRole('dialog', { name: 'Search sessions' });
  await expect(dialog.getByText('The quokka migration is done.').first()).toBeVisible();
  await dialog.getByRole('button', { name: /Quokka/ }).click();
  await expect(dialog).toBeHidden();

  // ED-04: the demo repository has no instruction files.
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('region', { name: 'Instruction files' }).getByText('No agent reads project instructions: there is no CLAUDE.md or AGENTS.md.')).toBeVisible();

  // HI-07
  const out = join(mkdtempSync(join(tmpdir(), 'ade-audit-')), 'audit.json');
  await app.evaluate(({ dialog: d }, p) => {
    d.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof d.showSaveDialog;
  }, out);
  await settings.getByRole('button', { name: 'Export audit log' }).click();
  await expect.poll(() => existsSync(out)).toBe(true);
  const json = readFileSync(out, 'utf8');
  expect(JSON.parse(json).format).toBe('ade-audit-1');
  expect(json).toContain('session.created');
  expect(json).not.toContain('demo-repo\\\\');
  await app.close();
});

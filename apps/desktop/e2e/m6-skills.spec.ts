import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M6-T05: build a skill in a form, then try it in a session', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'New skill' }).click();
  const form = page.getByRole('form', { name: 'Skill builder' });
  await form.getByLabel('Name').fill('Bad Name');
  await expect(form.getByText('Use lower-case letters, digits and single dashes.')).toBeVisible();
  await form.getByLabel('Name').fill('house-style');
  await form.getByLabel('Description').fill('Use when writing code in this repository.');
  await form.getByLabel('Instructions').fill('Use two spaces.');
  await expect(page.getByRole('region', { name: 'SKILL.md preview' })).toContainText('name: house-style');
  await form.getByRole('button', { name: 'Save skill' }).click();

  await expect(page.getByRole('complementary', { name: 'Skill library' }).getByRole('button', { name: /house-style/ })).toBeVisible();
  expect(readFileSync(join(repo, '.ade', 'skills', 'house-style', 'SKILL.md'), 'utf8')).toContain('Use two spaces.');

  await page.getByRole('button', { name: 'Try in a session' }).click();
  await expect(page.getByText('Skills loaded for this session only: house-style')).toBeVisible();
  await page.getByLabel('What should the agent do?').fill('say Using the style.');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByText(/Loaded skills for this session: house-style/).first()).toBeVisible();

  const worktrees = join(data, 'worktrees');
  const wsDir = readdirSync(worktrees)[0]!;
  const sessionDir = readdirSync(join(worktrees, wsDir))[0]!;
  expect(existsSync(join(worktrees, wsDir, sessionDir, '.agents', 'skills', 'house-style', 'SKILL.md'))).toBe(true);
  await app.close();
});

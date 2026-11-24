import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('HI-12: the Git page is the branch graph; moving through it shows each commit, its files and diffs', async () => {
  const repo = makeRepo();
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  const commit = (file: string, text: string, message: string) => {
    writeFileSync(join(repo, file), text);
    run('add', '-A');
    run('commit', '-q', '-m', message);
  };
  run('checkout', '-q', '-b', 'feature/login');
  commit('login.ts', 'export const login = true;\n', 'Add the login form\n\nIt checks the password length.');
  run('checkout', '-q', 'main');
  commit('README.md', '# Demo\n\nMore words.\n', 'Expand the readme');
  run('merge', '-q', '--no-ff', '-m', 'Merge feature/login', 'feature/login');

  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Ctrl 9 opens Git. The newest commit (HEAD) is selected and shown beside the graph.
  await page.keyboard.press('Control+9');
  const git = page.getByRole('main', { name: 'Git' });
  const graph = git.getByRole('listbox', { name: 'Commit graph' });
  const details = git.getByRole('region', { name: 'Commit details' });
  const diffPane = git.getByRole('region', { name: 'File diff' });
  await expect(graph.getByRole('option', { name: /^Merge feature\/login/ })).toHaveAttribute('aria-selected', 'true');
  await expect(details.getByRole('heading', { name: 'Merge feature/login' })).toBeVisible();
  await expect(details).toContainText('Merge of');
  await expect(details.getByRole('list', { name: 'Changed files' })).toContainText('login.ts');
  await expect(git.getByRole('list', { name: 'Branches' })).toContainText('feature/login');

  // Arrow keys move through the graph; the details follow, with the message body and the diff.
  // (The two branch commits are parallel, so Git may list either first.)
  await graph.focus();
  const selected = graph.locator('[aria-selected="true"]');
  for (const _ of [1, 2]) {
    await page.keyboard.press('ArrowDown');
    const subject = (await selected.getAttribute('aria-label'))!.replace(/, [0-9a-f]{7}$/, '');
    await expect(details.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  }
  await graph.getByRole('option', { name: /^Add the login form/ }).click();
  await expect(details.getByRole('heading', { name: 'Add the login form' })).toBeVisible();
  await expect(details).toContainText('It checks the password length.');
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/git-page.png` });
  await expect(diffPane.getByRole('region', { name: 'Diff of login.ts' })).toContainText('export const login');

  // A parent link moves the selection; End goes to the first commit.
  await details.getByRole('button', { name: /^Go to parent/ }).click();
  await expect(details.getByRole('heading', { name: 'init' })).toBeVisible();
  await expect(details).toContainText('Root commit');
  await graph.focus();
  await page.keyboard.press('Home');
  await expect(details.getByRole('heading', { name: 'Merge feature/login' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(details.getByRole('heading', { name: 'init' })).toBeVisible();

  // The Inspector keeps its own Branches tab.
  await page.keyboard.press('Control+1');
  await page.getByRole('tab', { name: 'Branches' }).click();
  await expect(page.getByRole('listbox', { name: 'Commit graph' })).toContainText('Expand the readme');
  await app.close();
});

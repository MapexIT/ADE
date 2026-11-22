import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('the file tree: compact folders, keyboard, filter, open and reveal, and the session changes marked', async () => {
  const repo = makeRepo();
  for (const f of ['src/main.ts', 'src/lib/util.ts', 'packages/ui/src/button.tsx']) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), `// ${f}\n`);
  }
  // Committed, so the session's worktree has them and an edit shows as a modification.
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'sources'], { cwd: repo });
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  const tree = page.getByRole('tree', { name: 'Files' });
  const item = (name: string | RegExp) => tree.getByRole('treeitem', { name, exact: typeof name === 'string' });
  // A chain of single folders is one row; folders come first and start closed.
  await expect(item('packages/ui/src')).toBeVisible();
  await expect(item('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(item('main.ts')).toHaveCount(0);

  // Keyboard (WAI-ARIA tree): Right opens a folder, Down moves into it, Enter opens a file.
  await item('src').click();
  await expect(item('src')).toHaveAttribute('aria-expanded', 'true');
  await item('src').click();
  await expect(item('lib')).toHaveCount(0);
  await tree.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(item('src')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(item('util.ts')).toBeVisible();
  // Type-ahead jumps to "main.ts".
  await page.keyboard.type('ma');
  await page.keyboard.press('Enter');
  await expect(item('main.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();

  // The filter matches characters in order and opens the folders it finds them in; Enter opens the first file.
  await page.getByLabel('Filter files').fill('btn');
  await expect(item('button.tsx')).toBeVisible();
  await expect(item('main.ts')).toHaveCount(0);
  await page.getByLabel('Filter files').press('Enter');
  await expect(item('button.tsx')).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Filter files').press('Escape');
  await expect(page.getByLabel('Filter files')).toHaveValue('');
  // The editor's file stays revealed after the filter is cleared; Collapse all closes everything.
  await expect(item('button.tsx')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(item('button.tsx')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal open file' }).click();
  await expect(item('button.tsx')).toBeVisible();

  // A session's changes are marked on the file and counted on its folders; "Changed only" shows just them.
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('edit src/lib/util.ts changed\nedit docs/new.md hello\nsay done');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  // The editor tab covers the timeline here; the inspector's checkpoint says the turn ended.
  await expect(page.getByText('Turn 1 · snapshot saved')).toBeVisible();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Changed only' }).click();
  await expect(item('util.ts, modified')).toBeVisible();
  await expect(item('new.md, added')).toBeVisible();
  await expect(item('src/lib, 1 changed inside')).toBeVisible();
  await expect(item('main.ts')).toHaveCount(0);
  await expect(page.getByText('2 changed')).toBeVisible();
  await app.close();
});

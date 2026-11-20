import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ade-e2e-'));
  const repo = join(root, 'demo-repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.invalid');
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(1)"' } }, null, 2));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

export async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [resolve(__dirname, '../out/main/index.js')],
    env: { ...process.env, ADE_USER_DATA_DIR: userData, ADE_ENABLE_FAKE_AGENT: '1', ADE_FAKE_CHUNK_DELAY_MS: '0' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

export async function stubDirectoryPicker(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
}

export const userDataDir = () => mkdtempSync(join(tmpdir(), 'ade-e2e-data-'));

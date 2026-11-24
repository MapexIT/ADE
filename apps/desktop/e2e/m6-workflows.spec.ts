import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

/**
 * The real agents must never run in tests, so every step uses the fake agent with a different model. Mixing
 * Claude Code, Codex and OpenCode through agent overrides is covered by the host integration test.
 */
const STORY = `
name: Story to pull request
nodes:
  - { id: plan, type: agent, agent: fake, model: fake-small, profile: read-only, prompt: "say The plan for {{workItem.title}}." }
  - { id: approve-plan, type: gate, question: "Is the plan right?" }
  - { id: build, type: agent, agent: fake, model: fake-large, profile: auto-edit, prompt: "edit feature.txt built" }
  - { id: tests, type: command, run: [node, -e, "process.exit(require('fs').existsSync('feature.txt') ? 0 : 1)"] }
  - { id: critique, type: agent, agent: fake, profile: read-only, prompt: "say Reviewed." }
  - { id: review, type: gate, question: "Review the change before the pull request" }
  - { id: open-pr, type: land, mode: pull-request }
edges:
  - { from: plan, to: approve-plan }
  - { from: approve-plan, to: build, when: pass }
  - { from: build, to: tests }
  - { from: tests, to: critique, when: pass }
  - { from: critique, to: review }
  - { from: review, to: open-pr, when: pass }
`;

test('M6 gate: the story workflow runs end to end and stops at both gates', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.ade', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.ade', 'workflows', 'story.yaml'), STORY);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'workflow'], { cwd: repo });

  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const list = page.getByRole('complementary', { name: 'Workflows' });
  await list
    .getByRole('button', { name: /Story to pull request/ })
    .first()
    .click();
  await expect(page.locator('span', { hasText: '.ade/workflows/story.yaml' })).toBeVisible();

  await page.getByRole('button', { name: 'Run workflow' }).click();
  await page.getByLabel('Work item title').fill('Dark mode');
  await page.getByRole('button', { name: 'Start run' }).click();

  // Gate 1, also listed in Needs you.
  const details = page.getByRole('complementary', { name: 'Run details' });
  const decision = details.getByRole('region', { name: /^Decision/ });
  await expect(decision.getByText('Is the plan right?')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Needs you/ }).click();
  await expect(page.getByRole('option', { name: /Is the plan right\?.*Workflow gate/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await decision.getByRole('button', { name: 'Approve and continue' }).click();

  // Gate 2 after build, tests and review.
  await expect(decision.getByText('Review the change before the pull request')).toBeVisible({
    timeout: 30_000,
  });
  await decision.getByRole('button', { name: 'Approve and continue' }).click();
  await expect(details.getByText('Succeeded', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  const log = execFileSync('git', ['log', '--all', '--format=%s'], { cwd: repo }).toString();
  expect(log).toContain('Dark mode');
  await app.close();
});

test('M6-T03: copy a template, add a step, save it to the repository', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Workflows' })
    .getByRole('button', { name: /Cross-review/ })
    .click();
  await page.getByRole('button', { name: 'Copy to repository to edit' }).click();
  await expect(page.getByText('Saved .ade/workflows/cross-review.yaml')).toBeVisible();

  await page.getByRole('toolbar', { name: 'Add a step' }).getByRole('button', { name: 'Command' }).click();
  const settings = page.getByRole('complementary', { name: 'Step settings' });
  await expect(settings.getByText('Command step')).toBeVisible();
  // An unconnected step is a problem, shown before saving.
  await expect(page.getByText(/1 problem/)).toBeVisible();
  await settings.getByLabel('Title').fill('Lint');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  await app.close();
});

test('M6-T04: the new session dialog starts a workflow instead of one agent (WF-02)', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.ade', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo, '.ade', 'workflows', 'quick.yaml'),
    'name: Quick check\nnodes:\n  - { id: look, type: agent, agent: fake, profile: read-only, prompt: "say Looked at {{workItem.title}}." }\n  - { id: ok, type: gate, question: "Happy with it?" }\nedges:\n  - { from: look, to: ok }\n',
  );
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByRole('tab', { name: 'A workflow' }).click();
  await page.getByRole('radio', { name: /Quick check/ }).check();
  await page.getByLabel(/Title \(fills/).fill('The login page');
  await page.getByLabel(/What is the work/).fill('Check it.');
  await page.getByRole('button', { name: 'Start run' }).click();

  const decision = page
    .getByRole('complementary', { name: 'Run details' })
    .getByRole('region', { name: /^Decision/ });
  await expect(decision.getByText('Happy with it?')).toBeVisible({ timeout: 30_000 });
  await decision.getByRole('button', { name: 'Open latest session' }).click();
  await expect(page.getByText('Looked at The login page.').first()).toBeVisible();
  await app.close();
});

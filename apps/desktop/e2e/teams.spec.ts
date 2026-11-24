import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('GN-01 + WA-08: a session starts with a generation method; its reasoning agents and the session show as live teams', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  // Start a session with Graph of Thought. Every reasoning call (and the turn) runs the script, so each takes about 2 s.
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill('sleep 2000\nsay FINAL APPROACH: patch it');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByLabel('Generation method', { exact: true }).selectOption('got');
  const confirm = page.getByRole('dialog', { name: 'Switch generation to Graph of Thought?' });
  await confirm.getByLabel('Thoughts').fill('2');
  await confirm.getByRole('button', { name: 'Use Graph of Thought' }).click();
  await expect(page.getByLabel('Generation method', { exact: true })).toHaveValue('got');
  await page.getByRole('button', { name: 'Start session' }).click();

  // The top bar pulse appears and leads to Observe, where the reasoning run is a team started by the session.
  const pulse = page.getByRole('button', { name: /agents? working in \d+ teams?/ });
  await expect(pulse).toBeVisible({ timeout: 30_000 });
  await pulse.click();
  const teams = page.getByRole('list', { name: 'Agent teams' });
  const reasoning = teams.getByRole('listitem', { name: 'Team: Graph of Thought' });
  await expect(reasoning).toBeVisible({ timeout: 30_000 });
  await expect(reasoning).toContainText('Started by sleep 2000');
  await expect(reasoning.getByRole('img', { name: /^Graph of Thought: \d+ agents?, \d+% busy$/ })).toBeVisible();
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/teams.png` });

  // The session is in "Your sessions"; while its reasoning agents work, its header shows the activity wave.
  const yours = teams.getByRole('listitem', { name: 'Team: Your sessions' });
  await expect(yours).toBeVisible({ timeout: 40_000 });
  await expect(yours.getByRole('img', { name: /^Your sessions: 1 agent, \d+% busy$/ })).toBeVisible();
  await page.keyboard.press('Control+1');
  if (process.env.ADE_SHOTS) await page.screenshot({ path: `${process.env.ADE_SHOTS}/wave.png` });
  await expect(page.locator('.ade-wave')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Reasoning: Graph of Thought' }).getByText('Sent to the agent')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Turn 1 · finished')).toBeVisible({ timeout: 30_000 });
  // Done: no live agents, so the pulse and the wave go away.
  await expect(pulse).toHaveCount(0);
  await expect(page.locator('.ade-wave')).toHaveCount(0);
  await app.close();
});

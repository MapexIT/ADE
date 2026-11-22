import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('M7-T05: scratchpad snippet; an environment set with a masked secret; two runs compared', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await page.keyboard.press('Control+5');

  // CR-07: the sample JavaScript snippet runs in a temporary folder.
  await page.getByRole('tab', { name: 'Scratchpad' }).click();
  await page.getByRole('button', { name: 'Run snippet' }).click();
  const runs = page.getByRole('complementary', { name: 'Run history' });
  await expect(runs.getByText(/snippet\.mjs/)).toBeVisible({ timeout: 20_000 });
  await expect(runs.getByText('Passed').first()).toBeVisible();

  // CR-11: a plain variable and a secret one.
  await page.getByRole('button', { name: 'Environment sets' }).click();
  const envDialog = page.getByRole('dialog', { name: 'Environment sets' });
  await envDialog.getByRole('button', { name: 'Add environment set' }).click();
  for (const [name, value, secret] of [
    ['GREETING', 'hello', false],
    ['TOKEN', 's3cret-value', true],
  ] as const) {
    await envDialog.getByRole('button', { name: 'Add variable' }).click();
    const names = envDialog.getByLabel('Variable name');
    await names.last().fill(name);
    if (secret) await envDialog.getByRole('checkbox', { name: 'Secret' }).last().check();
    await envDialog.getByLabel(`Value of ${name}`).fill(value);
  }
  await envDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Environment sets saved.')).toBeVisible();
  // Dialogs animate out (120 ms); wait until it has gone before using the form behind it.
  await expect(envDialog).toBeHidden();

  await page.getByLabel('Name', { exact: true }).fill('Echo env');
  await page.getByLabel('Command').fill('node -e console.log(process.env.GREETING,process.env.TOKEN)');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await page.getByLabel('Configuration', { exact: true }).selectOption({ label: 'Echo env (yours)' });
  await page.getByLabel('Environment', { exact: true }).selectOption({ label: 'Local' });
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Run the configuration' }).click();
    await expect(page.getByRole('complementary', { name: 'Run history' }).getByText('node -e console.log(process.env.GREETING,process.env.TOKEN)')).toHaveCount(i + 1, { timeout: 20_000 });
  }

  // CR-09: compare the two runs; the secret is masked in what was stored.
  const history = page.getByRole('complementary', { name: 'Run history' });
  await history.getByRole('checkbox', { name: 'Compare' }).nth(0).check();
  await history.getByRole('checkbox', { name: 'Compare' }).nth(1).check();
  const compare = page.getByRole('dialog', { name: 'Compare runs' });
  await expect(compare).toBeVisible();
  await app.close();
  // What ADE stored has the secret masked (the diff editor draws its lines outside the accessibility tree).
  const db = new DatabaseSync(join(data, 'ade.db'), { readOnly: true });
  const outputs = (db.prepare("SELECT output FROM runs WHERE command_json LIKE '%GREETING%'").all() as { output: string }[]).map((r) => r.output);
  db.close();
  expect(outputs).toHaveLength(2);
  for (const o of outputs) {
    expect(o).toMatch(/hello\s+••••••/);
    expect(o).not.toContain('s3cret-value');
  }
});

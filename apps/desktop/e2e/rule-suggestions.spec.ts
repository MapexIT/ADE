import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

const shot = async (page: Page, name: string) => {
  if (!process.env.ADE_SHOTS) return;
  await page.waitForTimeout(400); // let dialog motion settle
  await page.screenshot({ path: `${process.env.ADE_SHOTS}/${name}.png` });
};

test('AP-09: a repeated approval becomes a rehearsed rule that answers the next request and still asks about a chain', async () => {
  const repo = makeRepo();
  const data = userDataDir();
  const { app, page } = await launch(data);
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(['ask npm test', 'ask npm test', 'ask npm test', 'say Done.'].join('\n'));
  await page.getByLabel('Title (optional)').fill('Rules task');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'Rules task' })).toBeVisible();

  // Three approvals by hand. No suggestion before the third.
  const pending = page.getByRole('region', { name: 'Approval request' });
  const hint = page.getByRole('note', { name: 'Rule suggestion' });
  for (let i = 0; i < 3; i++) {
    await pending.getByRole('button', { name: 'Allow once' }).click();
    await expect(page.getByText(/Allow once · by you/)).toHaveCount(i + 1);
    if (i < 2) await expect(hint).toHaveCount(0);
  }
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText('You have allowed npm test 3 times in this repository.');
  // It sits under the last decided card, never on a pending one.
  await expect(page.getByText(/Allow once · by you/).last().locator('..').getByRole('note', { name: 'Rule suggestion' })).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  await shot(page, 'rule-hint');

  await hint.getByRole('button', { name: 'Review rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rule from your decisions' });
  const patternBox = dialog.getByLabel('Pattern');
  const rehearsal = dialog.getByRole('region', { name: 'Rehearsal' });
  await expect(patternBox).toHaveValue('npm test');
  await expect(dialog.getByText('Runs project code')).toBeVisible();
  await expect(dialog.getByText('A rule matches the words of a request. It is not a sandbox.')).toBeVisible();
  await expect(dialog.getByText('Runs code from the repository, which an agent can change.')).toBeVisible();
  await expect(rehearsal).toContainText('Would have answered 3 of your last 3 requests, each the way you decided.');
  await shot(page, 'rule-dialog');

  await dialog.getByRole('radio', { name: 'This command with any arguments' }).check();
  await expect(patternBox).toHaveValue('npm test *');
  await expect(rehearsal).toContainText('Would have answered 3 of your last 3 requests, each the way you decided.');
  await dialog.getByRole('radio', { name: 'Only this exact command' }).check();
  await expect(patternBox).toHaveValue('npm test');
  await expect(rehearsal).toContainText('Would have answered 3 of your last 3 requests, each the way you decided.');

  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Workspace rule added.')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(hint).toHaveCount(0);

  // The rule answers the next request; the chain is still asked about.
  const box = page.getByRole('textbox', { name: 'Message Fake agent' });
  await box.fill(['ask npm test', 'ask npm test && rm -rf build', 'say Done.'].join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/Allow once · by a workspace rule/)).toBeVisible();
  await expect(pending).toContainText('npm test && rm -rf build');
  await pending.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();

  // Settings: usage, no suggestions left, and a live rehearsal while typing a new rule.
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const rules = settings.getByRole('region', { name: 'Workspace rules' });
  await expect(rules.getByLabel('Rule 1 pattern')).toHaveValue('npm test');
  await expect(rules.getByRole('group', { name: 'Rule 1', exact: true })).toContainText('Answered 1 request');
  await expect(rules.getByRole('region', { name: 'Suggested rules' })).toContainText('No suggestions yet.');
  await rules.getByRole('button', { name: 'Add rule' }).click();
  await rules.getByLabel('Rule 2 pattern').fill('npm *');
  const second = rules.getByRole('group', { name: 'Rule 2', exact: true });
  await expect(second).toContainText('Would have answered 3 of your last 4 requests');
  await expect(second).toContainText('1 more matched, but had extra steps or shell syntax, so ADE would still ask.');
  await rules.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'rule-settings');
  await settings.getByRole('button', { name: 'Close' }).first().click();
  await expect(settings).toBeHidden();
  await app.close();

  // After a restart the rule and its usage are still there (the unsaved draft is not).
  const again = await launch(data);
  await expect(again.page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');
  await again.page.keyboard.press('Control+,');
  const rules2 = again.page.getByRole('dialog', { name: 'Settings' }).getByRole('region', { name: 'Workspace rules' });
  await expect(rules2.getByLabel('Rule 1 pattern')).toHaveValue('npm test');
  await expect(rules2.getByLabel('Rule 2 pattern')).toHaveCount(0);
  await expect(rules2.getByRole('group', { name: 'Rule 1', exact: true })).toContainText('Answered 1 request');
  await again.app.close();
});

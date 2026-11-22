import { expect, test } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

test('WA-07: Observe follows an agent live, through tools and an approval, to its result', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  await page.keyboard.press('Control+n');
  await page
    .getByLabel('What should the agent do?')
    .fill(
      [
        'plan Read;Edit;Test',
        'think Looking around',
        'read README.md',
        'edit notes.txt hello',
        'ask npm test',
        'usage',
        'say All done.',
      ].join('\n'),
    );
  await page.getByLabel('Title (optional)').fill('Observed task');
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'Observed task' })).toBeVisible();

  await page.keyboard.press('Control+8');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('button', { name: 'Observe' })).toHaveAttribute('aria-current', 'page');

  // The agent stops at the approval: the card and the overview say so.
  const card = page.getByRole('button', { name: /^Observed task, Fake agent/ });
  await expect(card).toHaveAccessibleName(/Waiting for you/);
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview).toContainText('Waiting for you');
  const detail = page.getByRole('region', { name: 'Agent detail' });
  await expect(detail.getByRole('region', { name: 'Now' }).or(detail.getByLabel('Now'))).toContainText(
    'Waiting for you',
  );

  const feed = detail.getByRole('list', { name: 'Activity feed' });
  await expect(feed).toContainText('Asks: ');
  await expect(feed).toContainText('Plan: 0 of 3 done');
  await expect(detail.getByText('notes.txt', { exact: true })).toBeVisible();
  // The Now panel's timer runs while it waits; let a second pass so the wait shows in the timeline.
  await expect(detail.getByLabel('Now')).toContainText('for 0:01');

  // Answer from the session, then come back: the result card shows what happened.
  await page.keyboard.press('Control+1');
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  await page.keyboard.press('Control+8');
  const result = detail.getByLabel('Result');
  await expect(result).toContainText('Turn finished');
  await expect(result).toContainText('All done.');
  await expect(feed).toContainText('Answered by');
  await expect(detail.getByRole('list', { name: 'Time per phase' })).toContainText('Waiting for you');
  await app.close();
});

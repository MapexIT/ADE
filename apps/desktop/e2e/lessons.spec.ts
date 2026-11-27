import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, stubDirectoryPicker, userDataDir } from './helpers.ts';

const shot = async (page: Page, name: string) => {
  if (!process.env.ADE_SHOTS) return;
  await page.waitForTimeout(400); // let dialog motion settle
  await page.screenshot({ path: `${process.env.ADE_SHOTS}/${name}.png` });
};

async function startSession(page: Page, title: string, prompt: string) {
  await page.keyboard.press('Control+n');
  await page.getByLabel('What should the agent do?').fill(prompt);
  await page.getByLabel('Title (optional)').fill(title);
  await page.getByRole('radio', { name: /Fake agent/ }).check();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** The agent asks to run npm install; the user rejects it with a note, which is sent on as the next turn. */
async function rejectWithNote(page: Page, title: string, note: string) {
  await startSession(page, title, ['ask npm install', 'say Done.'].join('\n'));
  const pending = page.getByRole('region', { name: 'Approval request' });
  await pending.getByRole('button', { name: 'Reject with a note' }).click();
  await pending.getByLabel(/Tell the agent what to do instead/).fill(note);
  await pending.getByRole('button', { name: 'Reject and send the note' }).click();
  await expect(page.getByText('Turn 2 · finished')).toBeVisible();
}

test('ED-05: a correction said in two sessions becomes a lesson every new session gets, and ADE notes when it is not followed', async () => {
  const repo = makeRepo();
  const { app, page } = await launch(userDataDir());
  await page.getByRole('button', { name: 'Done' }).click();
  await stubDirectoryPicker(app, repo);
  await page.keyboard.press('Control+o');
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('demo-repo');

  const hint = page.getByRole('note', { name: 'Lesson suggestion' });
  await rejectWithNote(page, 'Lesson one', 'Use pnpm, not npm');
  await expect(page.getByText('Note: Use pnpm, not npm')).toBeVisible();
  // One occasion suggests nothing.
  await page.waitForTimeout(600);
  await expect(hint).toHaveCount(0);

  await rejectWithNote(page, 'Lesson two', 'Use pnpm, not npm');
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText('Lesson suggested.');
  await expect(hint).toContainText('You have said this twice, in 2 sessions with Fake agent.');
  // It sits under the decided card that carries the note, not in the attention tint.
  await expect(page.getByText('Note: Use pnpm, not npm').locator('..').getByRole('note', { name: 'Lesson suggestion' })).toBeVisible();
  await hint.scrollIntoViewIfNeeded();
  await shot(page, 'lesson-hint');

  await hint.getByRole('button', { name: 'Review lesson' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review lesson' });
  await expect(dialog.getByLabel('Lesson', { exact: true })).toHaveValue('Use pnpm, not npm');
  const occasions = dialog.getByRole('region', { name: 'When you said it' });
  await expect(occasions.getByRole('listitem')).toHaveCount(2);
  await expect(occasions).toContainText('Lesson one');
  await expect(occasions).toContainText('Lesson two');
  await expect(occasions).toContainText('Reject note');
  await expect(dialog.getByRole('radio', { name: /With the first prompt/ })).toBeChecked();
  await dialog.getByLabel('Watch for a command (optional)').fill('npm *');
  await expect(dialog).toContainText('Matches 2 of the last 2 commands agents ran or asked to run here.');
  await shot(page, 'lesson-dialog');
  await dialog.getByRole('button', { name: 'Add lesson' }).click();
  await expect(page.getByText(/Lesson added\./)).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(hint).toHaveCount(0);

  // The next session gets it after the user's own words, and ADE notices when the agent runs npm anyway.
  await page.keyboard.press('Control+n');
  const chip = page.getByRole('button', { name: '1 lesson will be sent' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByRole('checkbox', { name: 'Use pnpm, not npm' })).toBeChecked();
  await shot(page, 'lesson-new-session');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await startSession(page, 'Lesson three', ['run npm --version', 'say Done.'].join('\n'));
  await expect(page.getByText('Turn 1 · finished')).toBeVisible();
  const first = page.getByText(/Standing notes from the user:/).first();
  await expect(first).toBeVisible();
  await expect(first.locator('..')).toContainText('run npm --version');
  await expect(first.locator('..')).toContainText('- Use pnpm, not npm');
  await expect(page.getByText('Warning: Lesson not followed: Use pnpm, not npm')).toHaveCount(1);
  await first.scrollIntoViewIfNeeded();
  await shot(page, 'lesson-not-followed');

  // Settings lists it with its counters.
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const lessons = settings.getByRole('region', { name: 'Lessons' });
  const one = lessons.getByRole('group', { name: 'Lesson 1', exact: true });
  await expect(one).toContainText('Use pnpm, not npm');
  await expect(one).toContainText('With the first prompt');
  await expect(one).toContainText('said twice');
  await expect(one).toContainText('sent once');
  await expect(one).toContainText('Not followed once');
  await expect(lessons.getByRole('checkbox', { name: /Use pnpm, not npm/ })).toBeChecked();
  await lessons.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'lesson-settings');
  await settings.getByRole('button', { name: 'Close' }).first().click();
  await app.close();
});

import { expect, test, type Page } from '@playwright/test';

const authEmail = process.env.E2E_EMAIL || '';
const authPassword = process.env.E2E_PASSWORD || '';

const ensureSignedIn = async (page: Page) => {
  await page.goto('/');

  const createButton = page.getByRole('button', { name: 'Create New event' });
  if (await createButton.isVisible()) {
    return;
  }

  test.skip(!authEmail || !authPassword, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated regression tests.');

  await page.getByPlaceholder('Email address').fill(authEmail);
  await page.getByPlaceholder('Password').fill(authPassword);
  await page.getByRole('button', { name: 'Sign in' }).first().click();

  await expect(createButton).toBeVisible();
};

const createBasicWorkEvent = async (page: Page, labelSuffix: string) => {
  await page.getByRole('button', { name: 'Create New event' }).click();
  await expect(page.getByText('Create Event')).toBeVisible();

  const selects = page.locator('select');
  await selects.first().selectOption({ label: 'Work' });
  await page.getByRole('button', { name: 'Select event type' }).click();

  await page.locator('select').first().selectOption({ label: 'Meeting' });
  await page.getByRole('button', { name: 'Select subtype' }).click();

  await page.getByPlaceholder('Enter a person, people, group, place or description').fill(`Regression User ${labelSuffix}`);
  await page.getByRole('button', { name: 'SAVE' }).click();

  await expect(page.getByRole('button', { name: 'Create New event' })).toBeVisible();
};

test.describe('Release Regression Smoke', () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test('create screen uses create-event wording and address toggle wording', async ({ page }) => {
    await page.getByRole('button', { name: 'Create New event' }).click();

    await expect(page.getByText('Create Event')).toBeVisible();
    await expect(page.getByText('Set event location address')).toBeVisible();
  });

  test('modify flow shows Modify Event title', async ({ page }) => {
    await createBasicWorkEvent(page, String(Date.now()));

    await page.getByRole('button', { name: 'List' }).first().click();
    await page.getByRole('button', { name: 'Modify' }).first().click();

    await expect(page.getByText('Modify Event')).toBeVisible();
  });

  test('default mode reminders remain present after switching to custom mode', async ({ page }) => {
    await page.getByRole('button', { name: 'Create New event' }).click();

    const selects = page.locator('select');
    await selects.first().selectOption({ label: 'Work' });
    await page.getByRole('button', { name: 'Select event type' }).click();
    await page.locator('select').first().selectOption({ label: 'Meeting' });
    await page.getByRole('button', { name: 'Select subtype' }).click();
    await page.getByPlaceholder('Enter a person, people, group, place or description').fill('Regression Reminder Mode');

    await page.getByRole('button', { name: 'Default' }).click();
    await expect(page.getByText('Reminder list for this event')).toBeVisible();

    const before = await page.getByRole('button', { name: 'Delete reminder' }).count();
    test.skip(before === 0, 'No generated default reminders available for this date/time; skipping carry-over assertion.');

    await page.getByRole('button', { name: 'Custom' }).click();

    const after = await page.getByText('Remove').count();
    expect(after).toBeGreaterThan(0);
  });
});

import { expect, test } from '@playwright/test';
import {
  createRoadmap,
  createSignedInUser,
  expectNoA11yViolations,
  field,
  useCspGuard,
} from './helpers.ts';

useCspGuard();

test('FR-1.1: user creates two roadmaps and switches between them from the picker', async ({ page }) => {
  await createSignedInUser(page, 'picker');
  await expect(page.getByText("You don't have a roadmap yet.")).toBeVisible();

  const alphaId = await createRoadmap(page, 'Alpha plan');
  const betaId = await createRoadmap(page, 'Beta plan');
  expect(alphaId).not.toBe(betaId);

  // The roadmap list names both, each with the role badge.
  await page.goto('/');
  const rows = page.getByRole('list', { name: 'Your roadmaps' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Alpha plan' })).toContainText('Owner');
  await expect(rows.filter({ hasText: 'Beta plan' })).toContainText('Owner');

  // Choosing a roadmap opens it; the header picker switches to the other one.
  await page.getByRole('link', { name: 'Beta plan' }).click();
  await expect(page).toHaveURL(`/r/${betaId}/members`);
  const picker = field(page, 'Roadmap');
  await expect(picker).toHaveValue(betaId);
  await picker.selectOption({ label: 'Alpha plan' });
  await expect(page).toHaveURL(`/r/${alphaId}/members`);
  await expect(picker).toHaveValue(alphaId);

  // A person with no access to a roadmap id sees a plain message, not someone else's data.
  await page.goto('/r/not-a-roadmap/members');
  await expect(page.getByRole('alert')).toHaveText("This roadmap doesn't exist, or you don't have access to it.");
});

test('Signed-in screens pass axe at 375px and 1280px, with no horizontal scroll on mobile', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await createSignedInUser(page, 'axe');
  const id = await createRoadmap(page, 'Axe plan');

  const screens: [string, string][] = [
    ['/', 'Roadmaps'],
    [`/r/${id}/members`, 'Members'],
    [`/r/${id}/audit`, 'Audit log'],
    ['/settings/security', 'Security'],
  ];
  for (const [route, heading] of screens) {
    await test.step(route, async () => {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoA11yViolations(page);
      if (mobile) {
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(width, `horizontal scroll on ${route}`).toBeLessThanOrEqual(375);
      }
    });
  }

  await test.step('open dialogs', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New roadmap' }).click();
    await expect(page.getByRole('dialog', { name: 'New roadmap' })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');

    await page.goto(`/r/${id}/members`);
    await page.getByRole('button', { name: 'Delete roadmap' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete roadmap' })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

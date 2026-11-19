import { expect, test } from '@playwright/test';
import {
  createRoadmap,
  createSignedInUser,
  expectNoA11yViolations,
  field,
  inviteAndJoin,
  sendInvite,
  uniqueEmail,
  useCspGuard,
} from './helpers.ts';

useCspGuard();

test('Admin sees invite and role change events in the audit log and can filter by action', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'chair');
  const id = await createRoadmap(page, 'Ledger plan');
  const admin = await inviteAndJoin(page, browser, testInfo, 'Ledger plan', 'steward', 'Admin');
  const member = await inviteAndJoin(page, browser, testInfo, 'Ledger plan', 'clerk', 'Contributor');

  const a = admin.page;
  await a.goto(`/r/${id}/members`);
  await a.getByLabel('Role for clerk user').selectOption({ label: 'Admin' });
  await expect(a.getByLabel('Role for clerk user')).toHaveValue('admin');
  const invitee = uniqueEmail('visitor');
  await sendInvite(a, invitee, 'Contributor');

  await a.getByRole('link', { name: 'Audit log' }).click();
  await expect(a).toHaveURL(`/r/${id}/audit`);
  await expect(a.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  const log = a.getByRole('list', { name: 'Events' });
  await expect(log.getByRole('listitem').filter({ hasText: "steward user changed clerk user's role from Contributor to Admin." })).toHaveCount(1);
  await expect(log.getByRole('listitem').filter({ hasText: `steward user invited ${invitee} as Contributor.` })).toHaveCount(1);
  await expect(log.getByRole('listitem').filter({ hasText: 'chair user created the roadmap "Ledger plan".' })).toHaveCount(1);
  await expect(log.locator('time').first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expectNoA11yViolations(a);

  await field(a, 'Action').selectOption({ label: 'Role changed' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText("changed clerk user's role from Contributor to Admin.");
  await expect(log).not.toContainText('invited');

  // A range that starts tomorrow holds nothing.
  await field(a, 'Action').selectOption({ label: 'All actions' });
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await field(a, 'From').fill(tomorrow);
  await expect(a.getByText('No events in this range.')).toBeVisible();
  await expect(log).toHaveCount(0);

  await admin.context.close();
  await member.context.close();
});

test('Audit log pages with Load more', async ({ page }) => {
  await createSignedInUser(page, 'pager');
  const id = await createRoadmap(page, 'Long plan');
  await sendInvite(page, uniqueEmail('one'), 'Contributor');
  await sendInvite(page, uniqueEmail('two'), 'Contributor');

  // Ask the real API for two events at a time so a short log still has a second page.
  await page.route('**/api/roadmaps/*/audit*', (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '2');
    return route.continue({ url: url.toString() });
  });
  await page.goto(`/r/${id}/audit`);
  const items = page.getByRole('list', { name: 'Events' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(items).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

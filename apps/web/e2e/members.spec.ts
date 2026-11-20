import { expect, test, type Page } from '@playwright/test';
import {
  createRoadmap,
  createSignedInUser,
  field,
  inviteAndJoin,
  inviteLinkFor,
  openMembers,
  joinViaInvite,
  sendInvite,
  uniqueEmail,
  expectNoA11yViolations,
  useCspGuard,
} from './helpers.ts';

useCspGuard();

const memberRow = (page: Page, name: string) => page.getByTestId('member-row').filter({ hasText: name });

test('Owner invites a contributor by email; contributor accepts, enrolls, sees roadmap', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'host');
  const id = await createRoadmap(page, 'Launch plan');
  const guest = uniqueEmail('newcomer');

  await sendInvite(page, guest, 'Contributor');
  const pending = page.getByRole('list', { name: 'Pending invites' }).getByRole('listitem');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText(guest);
  await expect(pending).toContainText('Contributor');
  await expect(pending.getByRole('button', { name: `Revoke invite for ${guest}` })).toBeVisible();

  const joined = await joinViaInvite(browser, testInfo, await inviteLinkFor(guest, 'Launch plan'), 'Nina Newcomer', guest);
  const guestPage = joined.page;
  await expect(guestPage.getByRole('list', { name: 'Your roadmaps' }).getByRole('listitem')).toContainText('Launch plan');
  await expect(guestPage.getByRole('list', { name: 'Your roadmaps' }).getByRole('listitem')).toContainText('Contributor');
  await guestPage.getByRole('link', { name: 'Launch plan' }).click();
  await expect(guestPage).toHaveURL(`/r/${id}/projects`);
  await guestPage.getByRole('link', { name: 'Members', exact: true }).click();
  await expect(memberRow(guestPage, 'Nina Newcomer')).toBeVisible();

  // The owner now sees the new member, and the invite is no longer pending.
  await page.reload();
  await expect(memberRow(page, 'Nina Newcomer')).toContainText(guest);
  await expect(page.getByRole('list', { name: 'Pending invites' })).toHaveCount(0);

  // Inviting someone who already joined is explained.
  await field(page, 'Email').fill(guest);
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByRole('alert')).toHaveText(`${guest} is already a member.`);
  await joined.context.close();
});

test('Contributor sees no invite form, no role selects, no audit tab', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'boss');
  const id = await createRoadmap(page, 'Quiet plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Quiet plan', 'worker', 'Contributor');
  const p = guest.page;
  await p.goto(`/r/${id}/members`);
  await expect(p.getByRole('heading', { name: 'Members', level: 1 })).toBeVisible();
  await expect(memberRow(p, 'boss user')).toContainText('Owner');
  await expect(memberRow(p, 'worker user')).toContainText('Contributor');

  await expect(p.getByRole('button', { name: 'Send invite' })).toHaveCount(0);
  await expect(p.getByLabel(/^Role/)).toHaveCount(0);
  await expect(p.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  await expect(p.getByRole('heading', { name: 'Danger zone' })).toHaveCount(0);
  await expect(p.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Typing the address still shows a plain message, not the log.
  await p.goto(`/r/${id}/audit`);
  await expect(p.getByRole('alert')).toHaveText('Only Owners and Admins can see the audit log.');
  await guest.context.close();
});

test('Permissions: contributor calling PATCH members via fetch gets 403', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'chief');
  const id = await createRoadmap(page, 'Locked plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Locked plan', 'junior', 'Contributor');

  const csrf = ((await (await guest.page.request.get('/api/me')).json()) as { csrfToken: string }).csrfToken;
  const members = (await (await guest.page.request.get(`/api/roadmaps/${id}/members`)).json()) as {
    members: { userId: string; role: string }[];
  };
  const owner = members.members.find((m) => m.role === 'owner')!;
  const res = await guest.page.request.patch(`/api/roadmaps/${id}/members/${owner.userId}`, {
    headers: { 'x-csrf-token': csrf },
    data: { role: 'contributor' },
  });
  expect(res.status()).toBe(403);
  await guest.context.close();
});

test('Owner transfers ownership; former owner loses Danger zone', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'founder');
  const id = await createRoadmap(page, 'Handover plan');
  await openMembers(page);
  await expect(page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
  const heir = await inviteAndJoin(page, browser, testInfo, 'Handover plan', 'heir', 'Admin');

  await page.reload();
  await page.getByRole('button', { name: 'Transfer ownership' }).click();
  const dialog = page.getByRole('dialog', { name: 'Transfer ownership' });
  await dialog.getByLabel('New owner').selectOption({ label: 'heir user' });
  await dialog.getByRole('button', { name: 'Transfer ownership' }).click();

  await expect(page.getByRole('heading', { name: 'Danger zone' })).toHaveCount(0);
  await expect(memberRow(page, 'founder user')).toContainText('Admin');
  await expect(memberRow(page, 'heir user')).toContainText('Owner');

  await heir.page.goto(`/r/${id}/members`);
  await expect(heir.page.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
  await heir.context.close();
});

test('Owner deletes roadmap after typing its name', async ({ page }) => {
  await createSignedInUser(page, 'cleaner');
  await createRoadmap(page, 'Doomed plan');
  await openMembers(page);
  await page.getByRole('button', { name: 'Delete roadmap' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete roadmap' });
  await expect(dialog.getByText("Type Doomed plan to delete it. This can't be undone.")).toBeVisible();

  await dialog.getByLabel('Roadmap name').fill('Wrong name');
  await dialog.getByRole('button', { name: 'Delete roadmap' }).click();
  await expect(dialog.getByText("The name doesn't match.")).toBeVisible();

  await dialog.getByLabel('Roadmap name').fill('Doomed plan');
  await dialog.getByRole('button', { name: 'Delete roadmap' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText("You don't have a roadmap yet.")).toBeVisible();
});

test('Owner changes a role and removes a member; the confirm dialog returns focus to its button', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'manager');
  await createRoadmap(page, 'Crew plan');
  const crew = await inviteAndJoin(page, browser, testInfo, 'Crew plan', 'crew', 'Contributor');

  await page.reload();
  const select = page.getByLabel('Role for crew user');
  await select.selectOption({ label: 'Admin' });
  await expect(memberRow(page, 'crew user').getByLabel('Role for crew user')).toHaveValue('admin');
  await page.reload();
  await expect(page.getByLabel('Role for crew user')).toHaveValue('admin');

  const remove = page.getByRole('button', { name: 'Remove crew user' });
  await expect(remove).toHaveClass(/btn-danger/);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove member' });
  await expect(dialog.getByText('Remove crew user from Crew plan? They lose access right away.')).toBeVisible();
  // Focus stays inside the dialog while it is open.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();

  await remove.click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(memberRow(page, 'crew user')).toHaveCount(0);
  await crew.context.close();
});

test('Owner revokes a pending invite after confirming', async ({ page }) => {
  await createSignedInUser(page, 'revoker');
  await createRoadmap(page, 'Revoke plan');
  const guest = uniqueEmail('late');
  await sendInvite(page, guest, 'Admin');

  const revoke = page.getByRole('button', { name: `Revoke invite for ${guest}` });
  await expect(revoke).toHaveClass(/btn-danger/);
  await revoke.click();
  const dialog = page.getByRole('dialog', { name: 'Revoke invite' });
  await expect(dialog.getByText(`Revoke the invite for ${guest}? The link stops working.`)).toBeVisible();
  await expectNoA11yViolations(page);

  // Cancel leaves the invite in place and returns focus to the button.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(revoke).toBeFocused();
  await expect(page.getByRole('list', { name: 'Pending invites' })).toBeVisible();

  await revoke.click();
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Pending invites' })).toHaveCount(0);
});

test('A signed-in member opens a second invite after a page load and joins without signing in again', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'twice');
  await createRoadmap(page, 'First plan');
  const guest = uniqueEmail('returning');
  await sendInvite(page, guest, 'Contributor');
  const joined = await joinViaInvite(browser, testInfo, await inviteLinkFor(guest, 'First plan'), 'Rita Returning', guest);

  const secondId = await createRoadmap(page, 'Second plan');
  await sendInvite(page, guest, 'Contributor');
  const secondInvite = await inviteLinkFor(guest, 'Second plan');

  // A full page load: the session cookie is live, but no CSRF token is in memory yet.
  await joined.page.goto(secondInvite);
  await expect(joined.page.getByRole('heading', { name: 'Join Second plan' })).toBeVisible();
  await joined.page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(joined.page).toHaveURL(`/r/${secondId}/projects`);
  await expect(joined.page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await joined.context.close();
});

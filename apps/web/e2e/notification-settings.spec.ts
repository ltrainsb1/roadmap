import type { Page } from '@playwright/test';
import { apiAs, expectNoA11yViolations, field, readMails, seedProject, useCspGuard, waitForTwoWorkerPasses } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const userIdOf = async (call: ApiCall, roadmapId: string, email: string) =>
  (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${roadmapId}/members`)).members.find((m) => m.email === email)!
    .userId;

const ROWS = ['Assigned to you', 'Mentions', 'Dates changed on your items', 'Due soon'];
/** A row's radio group, named by the row, in either layout. */
const row = (page: Page, name: string) => page.getByRole('radiogroup', { name });

async function openSettings(page: Page) {
  await page.goto('/notifications');
  await page.getByRole('link', { name: 'Change which emails you get' }).click();
  await expect(page).toHaveURL('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Email notifications', level: 1 })).toBeVisible();
  await expect(row(page, 'Assigned to you')).toBeVisible();
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
}

test('FR-5.2: a person turns "Assigned to you" off, is assigned, sees it in the list and gets no email', async ({ browser, call, owner, roadmap }) => {
  const id = roadmap.id;
  const member = await joinByApi(browser, call, id, 'contributor', 'quiet');
  const m = member.page;

  await openSettings(m);
  // The defaults until the person changes them.
  await expect(row(m, 'Assigned to you').getByRole('radio', { name: 'Instantly' })).toBeChecked();
  await expect(row(m, 'Dates changed on your items').getByRole('radio', { name: 'Daily digest' })).toBeChecked();
  // The choices of a row are one group: the arrow keys move between them.
  await row(m, 'Mentions').getByRole('radio', { name: 'Instantly' }).focus();
  await m.keyboard.press('ArrowDown');
  await expect(row(m, 'Mentions').getByRole('radio', { name: 'Daily digest' })).toBeFocused();
  await expect(row(m, 'Mentions').getByRole('radio', { name: 'Daily digest' })).toBeChecked();
  await m.keyboard.press('ArrowUp');
  await expect(row(m, 'Mentions').getByRole('radio', { name: 'Instantly' })).toBeChecked();

  await row(m, 'Assigned to you').getByRole('radio', { name: 'Off' }).check();
  await save(m);
  const prefs = await (await apiAs(m))<{ prefs: Record<string, string> }>('GET', '/api/me/notification-prefs');
  expect(prefs.prefs.assigned).toBe('off');

  const mailsBefore = (await readMails(member.user.email)).length;
  const itemId = await seedProject(call, id, 'Quiet launch');
  await call('PUT', `/api/roadmaps/${id}/projects/${itemId}/assignees`, { userIds: [await userIdOf(call, id, member.user.email)] });

  // The list shows it whatever the email setting.
  await m.goto('/notifications');
  const rows = m.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(rows.locator('.notification-sentence')).toHaveText([`${owner.name} assigned you to Quiet launch.`]);

  // Two whole worker passes after the row was there: an instant email would have gone by now.
  await waitForTwoWorkerPasses();
  expect(await readMails(member.user.email)).toHaveLength(mailsBefore);

  await member.context.close();
});

test('FR-5.2: the settings page passes axe; at 375 px each row stacks with no sideways scroll', async ({ page, owner }) => {
  void owner;
  const noSidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  await page.setViewportSize({ width: 1280, height: 800 });
  await openSettings(page);
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Notification', 'Instantly', 'Daily digest', 'Off']);
  await expect(table.getByRole('rowheader').locator('.pref-name')).toHaveText(ROWS);
  await expect(page.getByText(/^The daily digest arrives at 8 am in your time zone \(.+\), on days with something in it\.$/)).toBeVisible();
  await expectNoA11yViolations(page);

  // Unsaved: leaving through a header link asks first.
  await row(page, 'Due soon').getByRole('radio', { name: 'Off' }).check();
  await page.getByRole('link', { name: 'Security' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved changes?' });
  await expect(dialog).toBeVisible();
  await expectNoA11yViolations(page);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL('/settings/notifications');
  await save(page);
  await expectNoA11yViolations(page);

  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByRole('table')).toHaveCount(0);
  for (const name of ROWS) {
    const group = row(page, name);
    await expect(group).toBeVisible();
    expect(await group.evaluate((el) => el.tagName)).toBe('FIELDSET');
    // Stacked: each choice sits below the one before it, at the same left edge.
    const boxes = await Promise.all(['Instantly', 'Daily digest', 'Off'].map(async (label) => (await group.getByText(label, { exact: true }).boundingBox())!));
    expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes[2]!.y).toBeGreaterThan(boxes[1]!.y);
    expect(boxes[1]!.x).toBe(boxes[0]!.x);
  }
  await expect(row(page, 'Due soon').getByRole('radio', { name: 'Off' })).toBeChecked();
  await expectNoA11yViolations(page);
  expect(await noSidewaysScroll()).toBe(true);

  // Once saved, leaving does not ask.
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
});

// Blocked: the API records `user.notification_prefs` with no roadmapId, and the only audit log screen lists one
// roadmap's events (GET /api/roadmaps/:roadmapId/audit filters on roadmapId), so the event never shows there. The
// sentence and the filter label are in place and unit-tested; this runs once the plan says where the event belongs.
test.fixme('FR-5.2: the audit log shows "changed their email notification settings."', async ({ page, owner, roadmap }) => {
  await openSettings(page);
  await row(page, 'Mentions').getByRole('radio', { name: 'Off' }).check();
  await save(page);

  await page.goto(`/r/${roadmap.id}/audit`);
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await field(page, 'Action').selectOption({ label: 'Notification settings changed' });
  const log = page.getByRole('list', { name: 'Events' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText(`${owner.name} changed their email notification settings.`);
});

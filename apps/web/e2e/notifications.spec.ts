import { apiAs, expectNoA11yViolations, readLastMail, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const userIdOf = async (call: ApiCall, roadmapId: string, email: string) =>
  (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${roadmapId}/members`)).members.find((m) => m.email === email)!
    .userId;

test('FR-5.1: an Admin assigns a Contributor, who sees the bell count go up, opens the list and the item, and receives the email', async ({
  browser,
  call,
  roadmap,
}) => {
  const id = roadmap.id;
  const admin = await joinByApi(browser, call, id, 'admin', 'lead');
  const member = await joinByApi(browser, call, id, 'contributor', 'maker');
  const itemId = await seedProject(call, id, 'Launch site');
  const m = member.page;

  await m.goto('/');
  await expect(m.getByRole('heading', { name: 'Roadmaps', level: 1 })).toBeVisible();
  await expect(m.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  const asAdmin = await apiAs(admin.page);
  await asAdmin('PUT', `/api/roadmaps/${id}/projects/${itemId}/assignees`, { userIds: [await userIdOf(call, id, member.user.email)] });

  // The count is polled every minute and when the window is shown again; a reload asks at once.
  await m.reload();
  const bell = m.getByRole('link', { name: 'Notifications, 1 unread' });
  await expect(bell).toBeVisible();
  await expect(bell.locator('.bell-badge')).toHaveText('1');
  // The header with a count passes axe at this project's width too, the word and the badge both inside the link's name.
  await expectNoA11yViolations(m);
  await bell.click();
  await expect(m).toHaveURL('/notifications');
  await expect(m.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();

  const rows = m.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.notification-sentence')).toHaveText('lead user assigned you to Launch site.');
  await expect(rows.locator('.notification-meta')).toContainText(`${roadmap.name} · `);
  await expect(rows.getByText('Unread', { exact: true })).toHaveCount(1);

  await rows.getByRole('link').click();
  await expect(m).toHaveURL(`/r/${id}/projects/${itemId}`);
  // Opening the row marked it read, so the bell has no count any more.
  await expect(m.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();
  await m.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(rows.getByText('Unread', { exact: true })).toHaveCount(0);
  await expect(m.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);

  // The worker sends the instant email.
  await expect.poll(async () => (await readLastMail(member.user.email)).subject, { timeout: 15_000 }).toBe('lead user assigned you to Launch site');

  await admin.context.close();
  await member.context.close();
});

test('FR-5.1: a mention in a note shows in the list with its excerpt', async ({ browser, call, owner, roadmap }) => {
  const id = roadmap.id;
  const member = await joinByApi(browser, call, id, 'contributor', 'writer');
  const itemId = await seedProject(call, id, 'Pricing page');
  const body = '@writer user can you check the copy?\nThanks.';
  await call('POST', `/api/roadmaps/${id}/projects/${itemId}/notes`, {
    body,
    parentId: null,
    mentionIds: [await userIdOf(call, id, member.user.email)],
  });

  const m = member.page;
  await m.goto('/notifications');
  const rows = m.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.notification-sentence')).toHaveText(`${owner.name} mentioned you on Pricing page.`);
  await expect(rows.locator('.notification-excerpt')).toHaveText('“@writer user can you check the copy? Thanks.”');
  await expect(m.getByRole('link', { name: 'Notifications, 1 unread' })).toBeVisible();

  await member.context.close();
});

test('FR-5.3: the list and the empty state pass axe; at 375 px there is no sideways scroll', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const member = await joinByApi(browser, call, id, 'contributor', 'reviewer');
  const m = member.page;
  await m.setViewportSize({ width: 375, height: 667 });
  const noSidewaysScroll = () => m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  await m.goto('/notifications');
  await expect(m.getByText('No notifications yet.')).toBeVisible();
  await expect(m.getByRole('link', { name: 'Change which emails you get' })).toHaveAttribute('href', '/settings/notifications');
  await expectNoA11yViolations(m);
  expect(await noSidewaysScroll()).toBe(true);

  const userId = await userIdOf(call, id, member.user.email);
  for (const title of ['Checkout', 'A-very-long-item-title-with-no-spaces-at-all-that-would-push-a-row-sideways']) {
    const itemId = await seedProject(call, id, title);
    await call('PUT', `/api/roadmaps/${id}/projects/${itemId}/assignees`, { userIds: [userId] });
  }
  await m.reload();
  const rows = m.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  // Below 600 px the bell shows only its icon and badge; the word stays in its name.
  const bell = m.getByRole('link', { name: 'Notifications, 2 unread' });
  await expect(bell.locator('.bell-label')).toBeHidden();
  await expect(bell.locator('.bell-badge')).toHaveText('2');
  await expectNoA11yViolations(m);
  expect(await noSidewaysScroll()).toBe(true);

  await m.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(m.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  await expect(m.getByRole('heading', { name: 'Notifications', level: 1 })).toBeFocused();
  await expect(rows.getByText('Unread', { exact: true })).toHaveCount(0);
  await expect(m.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();
  await expectNoA11yViolations(m);

  await member.context.close();
});

import type { Locator, Page } from '@playwright/test';
import { expectNoA11yViolations, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const board = (page: Page) => page.getByRole('region', { name: 'Board', exact: true });
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true });
const card = (page: Page, title: string) =>
  board(page).getByRole('listitem').filter({ has: page.getByRole('link', { name: title, exact: true }) });
const titlesIn = (locator: Locator) => locator.getByRole('listitem').getByRole('link').allInnerTexts();
const level = (page: Page) => page.getByLabel('Level', { exact: true });
const panelOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
};
const handle = (page: Page, title: string) => page.getByRole('button', { name: `Move ${title}`, exact: true });
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const READ_ONLY = 'Only people assigned to this item, Owners and Admins can change it.';
const CONFLICT = 'Someone else changed this at the same time. Reload and try again.';

/** Presses the mouse on `title`'s handle and moves it a little, which picks the card up. */
async function pickUp(page: Page, title: string) {
  const from = centre(await box(handle(page, title)));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 3 });
  await expect(page.getByText(`Picked up ${title}.`, { exact: true })).toBeAttached();
}

/** Moves the picked-up card to the middle of `target` in steps, as a hand would, without letting go. */
async function moveOver(page: Page, target: Locator) {
  const to = centre(await box(target));
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

/**
 * Drags `title`'s card by its handle with the mouse onto the column `target`, whose status is `status`, and lets go
 * once dnd-kit has said the card is over it.
 */
async function drag(page: Page, title: string, target: Locator, status: string) {
  await pickUp(page, title);
  await moveOver(page, target);
  await expect(page.getByText(`${title} is over ${status}.`, { exact: true })).toBeAttached();
  await page.mouse.up();
}

/** The id of a member, by email. */
async function memberId(call: ApiCall, roadmapId: string, email: string) {
  const { members } = await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${roadmapId}/members`);
  return members.find((m) => m.email === email)!.userId;
}

/**
 * "Launch site" (in progress, assigned to the owner, 3 Mar to 28 Apr 2027, P1) holding "Design" (done) and "Build"
 * (not started); and "Hire" (not started).
 */
async function seeded(call: ApiCall, roadmapId: string) {
  const base = `/api/roadmaps/${roadmapId}/projects`;
  const me = (await call<{ user: { id: string } }>('GET', '/api/me')).user.id;
  const launch = await seedProject(call, roadmapId, 'Launch site');
  const hire = await seedProject(call, roadmapId, 'Hire');
  const design = await seedProject(call, roadmapId, 'Design', launch);
  const build = await seedProject(call, roadmapId, 'Build', launch);
  await call('PATCH', `${base}/${launch}`, { version: 1, status: 'in_progress', startDate: '2027-03-03', endDate: '2027-04-28' });
  await call('PUT', `${base}/${launch}/assignees`, { userIds: [me] });
  await call('PUT', `${base}/${launch}/priority-label`, { label: 'P1' });
  await call('PATCH', `${base}/${design}`, { version: 1, status: 'done' });
  return { base, launch, hire, design, build };
}

async function openBoard(page: Page, roadmapId: string, query = '') {
  await page.goto(`/r/${roadmapId}/board${query}`);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

test('FR-1.7: the Board has a column per status with its cards and counts', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(column(page, 'Not started, 1 item')).toContainText('Hire');
  await expect(column(page, 'In progress, 1 item')).toContainText('Launch site');
  for (const name of ['Blocked, 0 items', 'Done, 0 items', 'Cancelled, 0 items']) {
    await expect(column(page, name)).toContainText('No items');
  }
  // Each column is reached by its heading, in status order.
  await expect(board(page).getByRole('heading', { level: 2 })).toHaveText([
    'Not started, 1 item',
    'In progress, 1 item',
    'Blocked, 0 items',
    'Done, 0 items',
    'Cancelled, 0 items',
  ]);
  // Sub-projects are not on the Projects level.
  await expect(card(page, 'Design')).toHaveCount(0);
});

test('FR-1.7: a card shows assignees, dates and the priority label', async ({ page, call, owner, roadmap }) => {
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  const launch = card(page, 'Launch site');
  await expect(launch).toContainText(owner.name);
  await expect(launch).toContainText('3 Mar to 28 Apr 2027');
  await expect(launch).toContainText('P1');
  await expect(card(page, 'Hire')).toContainText('Unassigned');
  await expect(card(page, 'Hire')).toContainText('No dates');
  // A top-level card names no parent.
  await expect(card(page, 'Hire')).not.toContainText('In ');
});

test('FR-1.7: a card that starts before its blocker ends shows the warning icon', async ({ page, call, roadmap }) => {
  const blocker = await seedProject(call, roadmap.id, 'Foundations');
  const item = await seedProject(call, roadmap.id, 'Walls');
  const base = `/api/roadmaps/${roadmap.id}/projects`;
  await call('PATCH', `${base}/${blocker}`, { version: 1, startDate: '2027-01-01', endDate: '2027-06-01' });
  await call('PATCH', `${base}/${item}`, { version: 1, startDate: '2027-05-01', endDate: '2027-07-01', blockedBy: [blocker] });
  await openBoard(page, roadmap.id);
  const warning = card(page, 'Walls').getByRole('img', { name: 'Has warnings' });
  await expect(warning).toBeVisible();
  await expect(card(page, 'Walls').locator('.warning')).toHaveAttribute('title', 'Starts before Foundations ends.');
  await expect(card(page, 'Foundations').getByRole('img', { name: 'Has warnings' })).toHaveCount(0);
});

test("FR-1.7: Level shows another level, names each card's parent, and is kept in the address", async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await level(page).selectOption({ label: 'Sub-projects' });
  await expect(page).toHaveURL(/[?&]level=2(&|$)/);
  await expect(column(page, 'Done, 1 item')).toContainText('Design');
  await expect(card(page, 'Design')).toContainText('In Launch site');
  await expect(column(page, 'Not started, 1 item')).toContainText('Build');
  await expect(card(page, 'Hire')).toHaveCount(0);

  await page.reload();
  await expect(level(page)).toHaveValue('2');
  await expect(column(page, 'Done, 1 item')).toContainText('Design');

  // Switching view and back keeps the level.
  await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'List', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/projects?level=2`);
  await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Board', exact: true }).click();
  await expect(level(page)).toHaveValue('2');

  await level(page).selectOption({ label: 'Tasks' });
  await expect(page.getByText('No tasks yet.', { exact: true })).toBeVisible();
  await expect(board(page)).toHaveCount(0);
});

test("FR-1.7: cards are in the List's order", async ({ page, call, roadmap }) => {
  const { base, launch, hire } = await seeded(call, roadmap.id);
  const brief = await seedProject(call, roadmap.id, 'Write brief');
  // Against the order they were made in.
  await call('PUT', `${base}/order`, { parentId: null, orderedIds: [launch, brief, hire] });
  await openBoard(page, roadmap.id);
  await expect.poll(() => titlesIn(column(page, 'Not started, 2 items'))).toEqual(['Write brief', 'Hire']);

  await call('PUT', `${base}/order`, { parentId: null, orderedIds: [hire, launch, brief] });
  await page.reload();
  await expect.poll(() => titlesIn(column(page, 'Not started, 2 items'))).toEqual(['Hire', 'Write brief']);
});

test('FR-1.7: the status menu on a card moves it to that column', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Not started', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Blocked', exact: true }).click();
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect(column(page, 'Not started, 0 items')).toContainText('No items');
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Blocked', exact: true })).toBeVisible();
  // The card was rebuilt in its new column; focus is on its status menu again, not lost to the page.
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Blocked', exact: true })).toBeFocused();
});

test('FR-1.7: a refused move from the status menu puts the card back with focus still on its status menu', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { base, hire } = await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Hire')).toBeVisible();
  // Someone else blocks it; this page still has the old copy.
  await call('PATCH', `${base}/${hire}`, { version: 1, status: 'blocked' });
  await card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Not started', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(CONFLICT);
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect(column(page, 'Done, 0 items')).toContainText('No items');
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Blocked', exact: true })).toBeFocused();
});

test('FR-1.7: choosing a card opens the panel, and the Actions menu archives and deletes', async ({ page, call, roadmap }) => {
  // The panel sits beside the board only from 900 px.
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await card(page, 'Hire').getByRole('link', { name: 'Hire', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/board/${hire}`);
  await expect(panelOf(page, 'Hire')).toBeVisible();
  await expect(board(page)).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Actions for Hire', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived Hire.' })).toHaveText('Archived Hire.');
  await expect(card(page, 'Hire')).toHaveCount(0);
  await expect(page).toHaveURL(`/r/${roadmap.id}/board`);

  await page.getByRole('button', { name: 'Actions for Launch site', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Launch site?' });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(page, 'Launch site')).toHaveCount(0);
});

test('FR-1.7: filters apply and archived cards appear only with Show archived', async ({ page, call, roadmap }) => {
  const { base, hire } = await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id, '?status=done&level=2');
  await expect(column(page, 'Done, 1 item')).toContainText('Design');
  await expect.poll(() => titlesIn(board(page))).toEqual(['Design']);

  await call('POST', `${base}/${hire}/archive`);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Launch site')).toBeVisible();
  await expect(card(page, 'Hire')).toHaveCount(0);

  await openBoard(page, roadmap.id, '?archived=1');
  const archived = card(page, 'Hire');
  await expect(archived.getByText('Archived', { exact: true })).toBeVisible();
  await expect(archived.getByRole('button', { name: /^Status of Hire/ })).toHaveCount(0);
  await expect(archived.locator('.pill')).toBeVisible();
  await expect(archived.locator('.pill')).toHaveText('Not started');
});

test('FR-1.7: Review focus 4: a Contributor who is not assigned sees status as text and no Archive or Delete', async ({ browser, call, roadmap }) => {
  await seeded(call, roadmap.id);
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'viewer');
  const page = guest.page;
  await openBoard(page, roadmap.id);
  const pill = card(page, 'Hire').locator('.pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('Not started');
  await expect(card(page, 'Hire').getByRole('button', { name: /^Status of Hire/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for Hire', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await guest.context.close();
});

test('FR-1.9: at 375 px the columns scroll sideways inside the board and the page does not', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Hire')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const sizes = await board(page).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);

  // The first column fills most of the width and the next one shows at the edge.
  const first = await box(column(page, 'Not started, 1 item'));
  const second = await box(column(page, 'In progress, 1 item'));
  expect(first.width).toBeCloseTo(280, 0);
  expect(second.x).toBeGreaterThan(first.x + first.width);
  expect(second.x).toBeLessThan(375);
  expect(second.x + second.width).toBeGreaterThan(375);

  // The status stays on the card as text at this width.
  await expect(card(page, 'Hire').locator('.pill')).toBeVisible();
});

test('FR-1.7: a card menu opens right by its button and inside the window', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  const viewport = page.viewportSize()!;
  for (const name of ['Actions for Hire', 'Status of Hire: Not started']) {
    const button = card(page, 'Hire').getByRole('button', { name, exact: true });
    await button.click();
    const menu = page.getByRole('menu', { name, exact: true });
    await expect(menu).toBeVisible();
    const b = await box(button);
    const m = await box(menu);
    // 4 px under the button, or 4 px over it.
    const under = Math.abs(m.y - (b.y + b.height + 4)) < 1;
    const over = Math.abs(m.y + m.height - (b.y - 4)) < 1;
    expect(under || over).toBe(true);
    // Overlapping the button's column, and wholly inside the window.
    expect(m.x).toBeLessThan(b.x + b.width);
    expect(m.x + m.width).toBeGreaterThan(b.x);
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.y).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(viewport.width);
    expect(m.y + m.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  }
});

test('FR-1.7: the Board passes axe at 1280 px', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Hire')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('FR-1.9: the Board passes axe at 375 px', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Hire')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('FR-1.7: dragging a card to another column changes its status, and it is still there after a reload', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await drag(page, 'Hire', column(page, 'Done, 0 items'), 'Done');
  await expect(column(page, 'Done, 1 item')).toContainText('Hire');
  await expect(column(page, 'Not started, 0 items')).toContainText('No items');
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Done', exact: true })).toBeVisible();
  await expect(card(page, 'Hire')).not.toHaveClass(/dragging/);
  await page.reload();
  await expect(column(page, 'Done, 1 item')).toContainText('Hire');
});

test('FR-1.7: dropping a card on its own column or outside the board changes nothing', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  let saves = 0;
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /\/api\/roadmaps\/[^/]+\/projects\/[^/]+$/.test(new URL(r.url()).pathname)) saves += 1;
  });

  // Over its own column nothing is said, so the column's outline shows the card is over it.
  await pickUp(page, 'Hire');
  await moveOver(page, column(page, 'Not started, 1 item'));
  await expect(column(page, 'Not started, 1 item')).toHaveClass(/\bover\b/);
  await page.mouse.up();
  await expect(page.getByText('Move cancelled.', { exact: true })).toBeAttached();
  await expect(column(page, 'Not started, 1 item')).toContainText('Hire');

  await pickUp(page, 'Hire');
  await expect(page.getByText('Move cancelled.', { exact: true })).toHaveCount(0);
  await moveOver(page, page.getByRole('heading', { name: 'Projects', level: 1 }));
  await expect(board(page).locator('.board-column.over')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByText('Move cancelled.', { exact: true })).toBeAttached();
  await expect(column(page, 'Not started, 1 item')).toContainText('Hire');
  await expect(card(page, 'Hire')).not.toHaveClass(/dragging/);

  // A save would have gone out as the card was dropped.
  expect(saves).toBe(0);
  await page.reload();
  await expect(column(page, 'Not started, 1 item')).toContainText('Hire');
  // The status menu's save is counted, so the count above is not zero for want of seeing requests.
  await card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Not started', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Blocked', exact: true }).click();
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect.poll(() => saves).toBe(1);
});

test('FR-1.7: Review focus 3: a move that conflicts puts the card back and says why', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { base, hire } = await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(card(page, 'Hire')).toBeVisible();
  // Someone else blocks it; this page still has the old copy.
  await call('PATCH', `${base}/${hire}`, { version: 1, status: 'blocked' });
  await drag(page, 'Hire', column(page, 'Done, 0 items'), 'Done');
  await expect(page.getByRole('alert')).toHaveText(CONFLICT);
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect(column(page, 'Done, 0 items')).toContainText('No items');
  await expect(card(page, 'Hire')).not.toHaveClass(/dragging/);
});

test('FR-1.7: Review focus 4: a Contributor whose assignment was just removed gets the read-only message and the card goes back', async ({ browser, call, roadmap }) => {
  const { base, hire } = await seeded(call, roadmap.id);
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'mover');
  await call('PUT', `${base}/${hire}/assignees`, { userIds: [await memberId(call, roadmap.id, guest.user.email)] });
  const page = guest.page;
  await page.setViewportSize({ width: 1280, height: 800 });
  await openBoard(page, roadmap.id);
  await expect(handle(page, 'Hire')).toBeVisible();

  // The owner unassigns them; their page has not refetched.
  await call('PUT', `${base}/${hire}/assignees`, { userIds: [] });
  await drag(page, 'Hire', column(page, 'Done, 0 items'), 'Done');
  await expect(page.getByRole('alert')).toHaveText(READ_ONLY);
  await expect(column(page, 'Not started, 1 item')).toContainText('Hire');
  await expect(column(page, 'Done, 0 items')).toContainText('No items');
  await expect(card(page, 'Hire')).not.toHaveClass(/dragging/);
  // The refetched list says they may no longer move it.
  await expect(handle(page, 'Hire')).toHaveCount(0);
  await guest.context.close();
});

test("FR-1.7: Review focus 5: moving the card of the open item updates the panel's Status, and Save then works", async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  await page.goto(`/r/${roadmap.id}/board/${hire}`);
  const panel = panelOf(page, 'Hire');
  await panel.getByLabel('Title', { exact: true }).fill('Hire two people');

  await drag(page, 'Hire', column(page, 'In progress, 1 item'), 'In progress');
  await expect(column(page, 'In progress, 2 items')).toContainText('Hire');
  await expect(panel.getByLabel('Status', { exact: true })).toHaveValue('in_progress');
  await expect(panel.getByLabel('Status', { exact: true }).locator('option:checked')).toHaveText('In progress');
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('Hire two people');

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Hire two people').getByRole('status')).toHaveText('Saved.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(column(page, 'In progress, 2 items')).toContainText('Hire two people');
});

test('FR-1.7: cards that may not be moved have no handle', async ({ page, browser, call, roadmap }) => {
  const { base, hire } = await seeded(call, roadmap.id);
  await call('POST', `${base}/${hire}/archive`);
  await openBoard(page, roadmap.id, '?archived=1');
  await expect(card(page, 'Hire').getByText('Archived', { exact: true })).toBeVisible();
  await expect(handle(page, 'Hire')).toHaveCount(0);
  await expect(handle(page, 'Launch site')).toBeVisible();

  // A Contributor assigned to nothing may move nothing.
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'onlooker');
  await openBoard(guest.page, roadmap.id);
  await expect(card(guest.page, 'Launch site')).toBeVisible();
  await expect(guest.page.getByRole('button', { name: /^Move / })).toHaveCount(0);
  await guest.context.close();
});

test('FR-1.9: a card can be moved by touch at 375 px', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  // At 375 px the section tabs take two lines, which can push the card below the fold; touches land only on screen.
  await handle(page, 'Hire').scrollIntoViewIfNeeded();
  const from = centre(await box(handle(page, 'Hire')));
  const next = await box(column(page, 'In progress, 1 item'));
  const frame = await box(board(page));
  // A point in the part of the next column that shows at the board's edge, short of the tenth of the board's width
  // at its edge where holding a card scrolls the board.
  const to = { x: next.x + 8, y: from.y };
  expect(to.x).toBeLessThan(frame.x + frame.width * 0.9);

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1 })) });
  // A long press picks the card up; dnd-kit says so once it has.
  await touch('touchStart', [from]);
  await expect(page.getByText('Picked up Hire.', { exact: true })).toBeAttached();
  for (let i = 1; i <= 10; i += 1) {
    await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / 10, y: from.y }]);
  }
  await expect(page.getByText('Hire is over In progress.', { exact: true })).toBeAttached();
  await touch('touchEnd', []);
  await expect(page.getByText('Moved Hire to In progress.', { exact: true })).toBeAttached();
  await expect(column(page, 'In progress, 2 items')).toContainText('Hire');
  await expect(column(page, 'Not started, 0 items')).toContainText('No items');
  const { items } = await call<{ items: { title: string; status: string }[] }>('GET', `/api/roadmaps/${roadmap.id}/projects`);
  expect(items.find((i) => i.title === 'Hire')?.status).toBe('in_progress');
});

test('FR-1.7: screen readers are told what happened', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await expect(handle(page, 'Hire')).toHaveAccessibleDescription('Drag this card to another column, or use its status menu.');
  await pickUp(page, 'Hire');
  await moveOver(page, column(page, 'Done, 0 items'));
  await expect(page.getByText('Hire is over Done.', { exact: true })).toBeAttached();
  await page.mouse.up();
  await expect(page.getByText('Moved Hire to Done.', { exact: true })).toBeAttached();
  await expect(column(page, 'Done, 1 item')).toContainText('Hire');
});

test('FR-1.7: the drag handle is not a tab stop: Tab goes from the title to the status menu', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  // Still named for pointer and touch users.
  await expect(handle(page, 'Hire')).toBeVisible();
  await card(page, 'Hire').getByRole('link', { name: 'Hire', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Not started', exact: true })).toBeFocused();
});

test('FR-1.7: the Board passes axe with a card picked up', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id);
  await pickUp(page, 'Hire');
  await moveOver(page, column(page, 'Done, 0 items'));
  await expect(page.getByText('Hire is over Done.', { exact: true })).toBeAttached();
  await expectNoA11yViolations(page);
  await page.mouse.up();
  await expect(column(page, 'Done, 1 item')).toContainText('Hire');
});

test('FR-1.7: filters that match nothing at this level show the no-match message on the Board', async ({ page, call, roadmap }) => {
  // Only "Design", a sub-project, is done.
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id, '?status=done');
  await expect(page.getByText('No projects match these filters.', { exact: true })).toBeVisible();
  await expect(board(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/board`);
  await expect(card(page, 'Hire')).toBeVisible();
  await expect(card(page, 'Launch site')).toBeVisible();
  await expect(page.getByText('No projects match these filters.', { exact: true })).toHaveCount(0);
});

test("FR-1.7: beside the open panel at 1280 px a card's title has the card's width to itself", async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  await page.goto(`/r/${roadmap.id}/board/${hire}`);
  await expect(panelOf(page, 'Hire')).toBeVisible();
  const title = await box(card(page, 'Launch site').getByRole('link', { name: 'Launch site', exact: true }));
  expect(title.width).toBeGreaterThanOrEqual(100);
  // The handle, the status menu and the Actions menu share a row below the title.
  const below = await box(handle(page, 'Launch site'));
  expect(below.y).toBeGreaterThanOrEqual(title.y + title.height);
  const actionsBox = await box(page.getByRole('button', { name: 'Actions for Launch site', exact: true }));
  expect(Math.abs(actionsBox.y - below.y)).toBeLessThan(8);
});

test('FR-1.8: "Assigned to me" on the Board shows only my cards', async ({ page, call, roadmap }) => {
  // Only "Launch site" is assigned to the owner.
  await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id, '?assignee=me');
  await expect(card(page, 'Launch site')).toBeVisible();
  await expect.poll(() => titlesIn(board(page))).toEqual(['Launch site']);
});

test("FR-1.7: cards under different parents follow the List's order", async ({ page, call, roadmap }) => {
  const first = await seedProject(call, roadmap.id, 'First');
  const second = await seedProject(call, roadmap.id, 'Second');
  // Made in the other order: the second project's children first.
  await seedProject(call, roadmap.id, 'Second A', second);
  await seedProject(call, roadmap.id, 'Second B', second);
  await seedProject(call, roadmap.id, 'First A', first);
  await openBoard(page, roadmap.id, '?level=2');
  await expect.poll(() => titlesIn(column(page, 'Not started, 3 items'))).toEqual(['First A', 'Second A', 'Second B']);
});

test('FR-1.7: the level is kept when a filter changes and when a card is opened and closed', async ({ page, call, roadmap }) => {
  const { design } = await seeded(call, roadmap.id);
  await openBoard(page, roadmap.id, '?level=2');
  await page.getByLabel('Search projects', { exact: true }).fill('Des');
  await expect(page).toHaveURL(`/r/${roadmap.id}/board?q=Des&level=2`);
  await expect(level(page)).toHaveValue('2');
  await expect.poll(() => titlesIn(board(page))).toEqual(['Design']);

  await card(page, 'Design').getByRole('link', { name: 'Design', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/board/${design}?q=Des&level=2`);
  await panelOf(page, 'Design').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/board?q=Des&level=2`);
  await expect(level(page)).toHaveValue('2');
  await expect.poll(() => titlesIn(board(page))).toEqual(['Design']);
});

test('FR-1.7: a card moved twice in quick succession ends in the second column with no error', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  // The first save reaches the server, but its answer is held until the second move has been made.
  let arrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => (arrived = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let patches = 0;
  await page.route(`**/api/roadmaps/${roadmap.id}/projects/${hire}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches += 1;
    if (patches > 1) return route.fallback();
    const response = await route.fetch();
    arrived();
    await released;
    await route.fulfill({ response });
  });
  await openBoard(page, roadmap.id);

  await drag(page, 'Hire', column(page, 'Done, 0 items'), 'Done');
  await firstArrived;
  await expect(column(page, 'Done, 1 item')).toContainText('Hire');
  await drag(page, 'Hire', column(page, 'Blocked, 0 items'), 'Blocked');
  await expect(page.getByText('Moved Hire to Blocked.', { exact: true })).toBeAttached();
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  // The second save waits for the first, so only the first has gone out.
  expect(patches).toBe(1);

  release();
  await expect.poll(() => patches).toBe(2);
  await expect(card(page, 'Hire').getByRole('button', { name: 'Status of Hire: Blocked', exact: true })).toBeVisible();
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect(column(page, 'Done, 0 items')).toContainText('No items');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.unroute(`**/api/roadmaps/${roadmap.id}/projects/${hire}`);
  await page.reload();
  await expect(column(page, 'Blocked, 1 item')).toContainText('Hire');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

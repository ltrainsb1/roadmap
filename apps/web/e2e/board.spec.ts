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

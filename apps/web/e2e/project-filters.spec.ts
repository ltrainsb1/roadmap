import type { Page } from '@playwright/test';
import type { TestUser } from './helpers.ts';
import { expectNoA11yViolations, field, projectRow, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const filtersButton = (page: Page, name = 'Filters') => page.getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Filters', exact: true });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search projects' });
const titles = (page: Page) => page.locator('.item-title').allInnerTexts();

async function openFilters(page: Page) {
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(panel(page)).toBeVisible();
}

/**
 * An Owner with: Season (no dates) holding Opening (in progress, assigned to the Owner, tag "stage", P1,
 * 3 to 10 Mar 2027, description mentioning a venue) and Closing (done, 1 to 30 Sep 2027); Standalone (tag
 * "design", not started); and Retired, which is archived.
 */
async function seeded(page: Page, { call, owner: user, roadmap }: { call: ApiCall; owner: TestUser; roadmap: { id: string } }) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = roadmap.id;
  const me = (await call<{ user: { id: string } }>('GET', '/api/me')).user.id;
  const base = `/api/roadmaps/${id}/projects`;
  const season = await seedProject(call, id, 'Season');
  const opening = await seedProject(call, id, 'Opening', season);
  const closing = await seedProject(call, id, 'Closing', season);
  const standalone = await seedProject(call, id, 'Standalone');
  const retired = await seedProject(call, id, 'Retired');
  await call('PATCH', `${base}/${opening}`, {
    version: 1,
    status: 'in_progress',
    tags: ['stage'],
    startDate: '2027-03-03',
    endDate: '2027-03-10',
    description: 'Needs the Venue contract',
  });
  await call('PUT', `${base}/${opening}/assignees`, { userIds: [me] });
  await call('PUT', `${base}/${opening}/priority-label`, { label: 'P1' });
  await call('PATCH', `${base}/${closing}`, { version: 1, status: 'done', startDate: '2027-09-01', endDate: '2027-09-30' });
  await call('PATCH', `${base}/${standalone}`, { version: 1, tags: ['design'] });
  await call('POST', `${base}/${retired}/archive`);
  await page.goto(`/r/${id}/projects`);
  await expect(projectRow(page, 'Standalone')).toBeVisible();
  return { id, call, user, ids: { season, opening, closing, standalone, retired } };
}

test('FR-1.8: filtering by status shows matching items and their ancestors, and the button reads "Filters (1)"', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await expect(filtersButton(page)).toHaveAttribute('aria-expanded', 'false');
  await filtersButton(page).click();
  await expect(filtersButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).getByRole('heading', { name: 'Filters', level: 2 })).toBeVisible();
  await panel(page).getByLabel('In progress', { exact: true }).check();

  await expect(filtersButton(page, 'Filters (1)')).toBeVisible();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await expect(projectRow(page, 'Opening')).not.toContainText('Shown for context');
  await expect(projectRow(page, 'Season')).toContainText('Shown for context');
  await expect(projectRow(page, 'Season')).toHaveClass(/context/);
  await expect(page).toHaveURL(/\?status=in_progress$/);

  // A greyed ancestor cannot take a new child from its menu: the list is not a place to add under context.
  await page.getByRole('button', { name: 'Actions for Season' }).click();
  await expect(page.getByRole('menuitem', { name: 'Add sub-project' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // "Done" closes the panel and puts focus back on the button.
  await panel(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(filtersButton(page, 'Filters (1)')).toBeFocused();
  await expect(filtersButton(page, 'Filters (1)')).toHaveAttribute('aria-expanded', 'false');
});

test('FR-1.8: filtering by "Assigned to me", by tag, by priority label and by a date range each narrow the list', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await openFilters(page);
  const clear = panel(page).getByRole('button', { name: 'Clear filters', exact: true });

  await panel(page).getByLabel('Assigned to me', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await expect(page).toHaveURL(/assignee=/);
  await clear.click();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening', 'Closing', 'Standalone']);

  await panel(page).getByLabel('design', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Standalone']);
  await clear.click();

  await panel(page).getByLabel('P1', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await clear.click();
  await panel(page).getByLabel('None', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing', 'Standalone']);
  await clear.click();

  await field(page, 'From').fill('2027-09-01');
  await field(page, 'To').fill('2027-09-30');
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing']);
  // The date range is one filter, however many of its ends are set.
  await expect(filtersButton(page, 'Filters (1)')).toBeVisible();
  await expect(page).toHaveURL(/from=2027-09-01&to=2027-09-30/);
});

test('FR-1.8: search matches a title, a description and a tag, ignoring case', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await search(page).fill('STANDAL');
  await expect.poll(() => titles(page)).toEqual(['Standalone']);
  await search(page).fill('vEnUe');
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await search(page).fill('Stage');
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await expect(page).toHaveURL(/\?q=Stage$/);
  // A search is not a field filter, so the button does not count it.
  await expect(filtersButton(page)).toBeVisible();
});

test('filters combine, and "Clear filters" restores the full list', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await openFilters(page);
  await panel(page).getByLabel('In progress', { exact: true }).check();
  await panel(page).getByLabel('Done', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening', 'Closing']);
  await search(page).fill('closing');
  await expect(filtersButton(page, 'Filters (1)')).toBeVisible();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing']);
  await panel(page).getByLabel('P1', { exact: true }).check();
  await expect(page.getByText('No projects match these filters.')).toBeVisible();

  await panel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening', 'Closing', 'Standalone']);
  await expect(search(page)).toHaveValue('');
  await expect(filtersButton(page)).toBeVisible();
  await expect(page).toHaveURL(/\/projects$/);
});

test('no match shows "No projects match these filters." with a working "Clear filters" button', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await search(page).fill('zzz-nothing');
  await expect(page.getByText('No projects match these filters.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText('No projects yet.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByText('No projects match these filters.')).toHaveCount(0);
  await expect(projectRow(page, 'Standalone')).toBeVisible();
  await expect(search(page)).toHaveValue('');
  // The button went with the message; focus goes to the search field, not the page body.
  await expect(search(page)).toBeFocused();
});

test('an item added while filters are on that does not match them is announced, not shown', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await openFilters(page);
  await panel(page).getByLabel('In progress', { exact: true }).check();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
  await panel(page).getByRole('button', { name: 'Done', exact: true }).click();

  await page.getByRole('button', { name: 'Actions for Opening' }).click();
  await page.getByRole('menuitem', { name: 'Add task' }).click();
  const input = page.getByRole('textbox', { name: 'Title of the new task' });
  await input.fill('Hidden task');
  await input.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Added Hidden task.' })).toHaveText(
    "Added Hidden task. It doesn't match the filters, so it isn't shown.",
  );
  await expect(projectRow(page, 'Hidden task')).toHaveCount(0);
  await input.press('Escape');
  await expect.poll(() => titles(page)).toEqual(['Season', 'Opening']);
});

test('the filtered address can be opened in a new tab and shows the same list', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await openFilters(page);
  await panel(page).getByLabel('Done', { exact: true }).check();
  await search(page).fill('clos');
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing']);

  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect.poll(() => titles(other)).toEqual(['Season', 'Closing']);
  await expect(search(other)).toHaveValue('clos');
  await expect(filtersButton(other, 'Filters (1)')).toBeVisible();
  await other.close();

  // Filtering does not add history entries, and opening an item and closing it keeps the filters.
  await page.getByRole('link', { name: 'Closing', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/?]+\?.*status=done/);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Closing');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\?.*status=done/);
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing']);
});

test('typing in the search box keeps every keystroke, the focus and the caret', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await search(page).click();
  await search(page).pressSequentially('clos');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('x');
  await expect(search(page)).toHaveValue('cloxs');
  await expect(search(page)).toBeFocused();
  await expect(page).toHaveURL(/\?q=cloxs$/);
  // The caret stayed where it was typed: the next character goes after the "x".
  await page.keyboard.type('y');
  await expect(search(page)).toHaveValue('cloxys');
  await expect(page).toHaveURL(/\?q=cloxys$/);
});

test('FR-1.8: "Assigned to me" is kept as "me" in the address and means the reader of a shared link', async ({ page, browser, call, owner, roadmap }) => {
  const { id, ids } = await seeded(page, { call, owner, roadmap });
  await openFilters(page);
  await panel(page).getByLabel('Assigned to me', { exact: true }).check();
  await expect(page).toHaveURL(/\?assignee=me$/);

  const helper = await joinByApi(browser, call, id, 'admin', 'reader');
  const members = await call<{ members: { userId: string; name: string }[] }>('GET', `/api/roadmaps/${id}/members`);
  const readerId = members.members.find((m) => m.name === helper.user.name)!.userId;
  await call('PUT', `/api/roadmaps/${id}/projects/${ids.closing}/assignees`, { userIds: [readerId] });

  const theirs = helper.page;
  await theirs.goto(`/r/${id}/projects?assignee=me`);
  await expect.poll(() => titles(theirs)).toEqual(['Season', 'Closing']);
  await expect(filtersButton(theirs, 'Filters (1)')).toBeVisible();
  await theirs.getByRole('button', { name: /^Filters/ }).click();
  await expect(theirs.getByRole('region', { name: 'Filters', exact: true }).getByLabel('Assigned to me', { exact: true })).toBeChecked();
  // An edit made on the filtered address keeps "me".
  await theirs.getByRole('region', { name: 'Filters', exact: true }).getByLabel('Done', { exact: true }).check();
  await expect(theirs).toHaveURL(/assignee=me/);
  await helper.context.close();
});

test('FR-1.8: "Show archived" reveals archived items marked "Archived", with Unarchive in their menu', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await expect(projectRow(page, 'Retired')).toHaveCount(0);
  await openFilters(page);
  await panel(page).getByLabel('Show archived', { exact: true }).check();
  const row = projectRow(page, 'Retired');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Archived');
  // Archived rows have no reorder controls and a plain status.
  await expect(page.getByRole('button', { name: 'Reorder Retired' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /^Status of/ })).toHaveCount(0);
  // Showing archived is not a field filter.
  await expect(filtersButton(page)).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Retired' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Unarchive' }).click();
  await expect(page.getByText('Unarchived Retired.')).toBeVisible();
  await expect(row).not.toContainText('Archived');
  await expect(page.getByRole('button', { name: 'Actions for Retired' })).toBeVisible();
});

test('FR-1.8: reordering is unavailable while a filter, a search or "Show archived" is on', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await expect(page.getByText('Clear filters to reorder.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reorder Standalone' })).toBeVisible();

  for (const turnOn of [
    async () => search(page).fill('s'),
    async () => {
      await search(page).fill('');
      await openFilters(page);
      await panel(page).getByLabel('Not started', { exact: true }).check();
    },
    async () => {
      await panel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
      await panel(page).getByLabel('Show archived', { exact: true }).check();
    },
  ]) {
    await turnOn();
    await expect(page.getByText('Clear filters to reorder.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Actions for Standalone' }).click();
    await expect(page.getByRole('menuitem', { name: 'Open' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }

  await panel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByText('Clear filters to reorder.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reorder Standalone' })).toBeVisible();
});

test('FR-1.8: a filter that names a tag nobody has any more is kept in the address and can be unticked', async ({ page, call, owner, roadmap }) => {
  const { id } = await seeded(page, { call, owner, roadmap });
  await page.goto(`/r/${id}/projects?tag=gone&tag=design`);
  await expect(filtersButton(page, 'Filters (1)')).toBeVisible();
  await expect.poll(() => titles(page)).toEqual(['Standalone']);
  await openFilters(page);
  await expect(panel(page).getByLabel('gone', { exact: true })).toBeChecked();
  await panel(page).getByLabel('design', { exact: true }).uncheck();
  await expect(page.getByText('No projects match these filters.')).toBeVisible();
  // Once unticked, a value nobody has any more leaves the list, so the click is not followed by a state check.
  await panel(page).getByLabel('gone', { exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(panel(page).getByLabel('gone', { exact: true })).toHaveCount(0);
});

test('the audit log shows a sentence for adding, changing, reordering and deleting an item', async ({ page, call, owner: user, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = roadmap.id;
  const base = `/api/roadmaps/${id}/projects`;
  const season = await seedProject(call, id, 'Season');
  const opening = await seedProject(call, id, 'Opening', season);
  const closing = await seedProject(call, id, 'Closing', season);
  await call('PATCH', `${base}/${opening}`, { version: 1, status: 'done' });
  await call('PUT', `${base}/order`, { parentId: season, orderedIds: [closing, opening] });
  await call('PUT', `${base}/${opening}/priority-label`, { label: 'P2' });
  await call('PUT', `${base}/${opening}/priority-label`, { label: null });
  await call('POST', `${base}/${closing}/archive`);
  await call('POST', `${base}/${closing}/unarchive`);
  await call('DELETE', `${base}/${closing}`);

  await page.goto(`/r/${id}/audit`);
  const log = page.getByRole('list', { name: 'Events' });
  const who = user.name;
  for (const sentence of [
    `${who} added Season.`,
    `${who} added Opening.`,
    `${who} changed Opening.`,
    `${who} reordered the items under Season.`,
    `${who} set the priority label of Opening to P2.`,
    `${who} removed the priority label of Opening.`,
    `${who} archived Closing.`,
    `${who} unarchived Closing.`,
    `${who} deleted Closing.`,
  ]) {
    await expect(log.getByRole('listitem').filter({ hasText: sentence })).toHaveCount(1);
  }
  await expect(log).not.toContainText('made a change');

  await field(page, 'Action').selectOption({ label: 'Item deleted' });
  await expect(log.getByRole('listitem')).toHaveCount(1);
  await expect(log).toContainText(`${who} deleted Closing.`);
  await expect(page.getByLabel('Action').locator('option')).toContainText([
    'All actions',
    'Item added',
    'Item changed',
    'Item deleted',
    'Item archived',
    'Item unarchived',
    'Assignees changed',
    'Items reordered',
    'Priority label changed',
  ]);
});

test('at 375 px the filters panel fits, the page does not scroll sideways, and axe passes with the panel open', async ({ page, call, owner, roadmap }) => {
  await seeded(page, { call, owner, roadmap });
  await page.setViewportSize({ width: 375, height: 667 });
  await openFilters(page);
  await panel(page).getByLabel('Show archived', { exact: true }).check();
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectNoA11yViolations(page);
});

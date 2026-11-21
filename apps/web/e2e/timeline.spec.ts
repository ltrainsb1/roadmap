import type { Locator, Page } from '@playwright/test';
import { expectNoA11yViolations, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

// The fixture accounts are in UTC, so this is 15 Mar 2027 for them.
const NOW = new Date('2027-03-15T12:00:00Z');

const timeline = (page: Page) => page.getByRole('table', { name: 'Timeline', exact: true });
const row = (page: Page, title: string) =>
  timeline(page).getByRole('row').filter({ has: page.getByRole('link', { name: title, exact: true }) });
const views = (page: Page) => page.getByRole('navigation', { name: 'View', exact: true });
const panelOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const frame = (page: Page) => page.getByRole('region', { name: 'Schedule, scrolls sideways', exact: true });
const zoom = (page: Page) => page.getByLabel('Zoom', { exact: true });
const nameHeader = (page: Page) => timeline(page).getByRole('columnheader', { name: 'Name', exact: true });
const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
};
/** The element lies inside the window and nothing covers its centre. */
async function expectFullyShown(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const item = await box(locator);
  const viewport = page.viewportSize()!;
  expect(item.x).toBeGreaterThanOrEqual(0);
  expect(item.y).toBeGreaterThanOrEqual(0);
  expect(item.x + item.width).toBeLessThanOrEqual(viewport.width);
  expect(item.y + item.height).toBeLessThanOrEqual(viewport.height);
  const onTop = await locator.evaluate(
    (el, { x, y }) => {
      const top = document.elementFromPoint(x, y);
      return top === el || el.contains(top);
    },
    { x: item.x + item.width / 2, y: item.y + item.height / 2 },
  );
  expect(onTop).toBe(true);
}
/** Whether the today line is inside the part of the frame the name column leaves free. */
async function todayInView(page: Page) {
  const shown = await box(frame(page));
  const names = await box(nameHeader(page));
  const line = await box(row(page, 'Launch site').locator('.today-line'));
  return line.x >= names.x + names.width && line.x + line.width <= shown.x + shown.width;
}
const barWidth = async (page: Page, title: string) => (await box(row(page, title).locator('.bar'))).width;

/**
 * "Launch site" (3 Mar to 28 Apr 2027, milestone "Beta" on 1 Apr 2027) with child "Design" (start 10 Mar 2027
 * only), and "Hire" with no dates.
 */
async function seeded(call: ApiCall, roadmapId: string) {
  const base = `/api/roadmaps/${roadmapId}/projects`;
  const launch = await seedProject(call, roadmapId, 'Launch site');
  const design = await seedProject(call, roadmapId, 'Design', launch);
  const hire = await seedProject(call, roadmapId, 'Hire');
  await call('PATCH', `${base}/${launch}`, {
    version: 1,
    startDate: '2027-03-03',
    endDate: '2027-04-28',
    milestones: [{ name: 'Beta', date: '2027-04-01' }],
  });
  await call('PATCH', `${base}/${design}`, { version: 1, startDate: '2027-03-10' });
  return { launch, design, hire };
}

async function openTimeline(page: Page, roadmapId: string, query = '') {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/r/${roadmapId}/timeline${query}`);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

test('FR-1.7: the switcher opens the Timeline, keeps the filters, and marks the Projects tab', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await page.clock.setFixedTime(NOW);
  await page.goto(`/r/${roadmap.id}/projects?q=la`);
  await expect(views(page).getByRole('link', { name: 'List', exact: true })).toHaveAttribute('aria-current', 'page');

  await views(page).getByRole('link', { name: 'Timeline', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline?q=la`);
  await expect(views(page).getByRole('link', { name: 'Timeline', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(views(page).getByRole('link', { name: 'List', exact: true })).not.toHaveAttribute('aria-current');
  const tabs = page.getByRole('navigation', { name: 'Roadmap sections' });
  await expect(tabs.getByRole('link', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(row(page, 'Launch site')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('la');
});

test('FR-1.7: each item is a row with its dates as text, and milestones are named', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await expect(timeline(page).getByRole('columnheader', { name: 'Name', exact: true })).toBeVisible();
  await expect(timeline(page).getByRole('columnheader', { name: 'Schedule', exact: true })).toBeAttached();
  await expect(row(page, 'Launch site')).toContainText('3 Mar to 28 Apr 2027');
  await expect(row(page, 'Launch site')).toContainText('Milestone: Beta, 1 Apr 2027');
  await expect(row(page, 'Design')).toContainText('From 10 Mar 2027');
  await expect(row(page, 'Hire')).toContainText('No dates');
  await expectNoA11yViolations(page);
});

test('FR-1.7: bars sit where the dates say', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  const bar = await row(page, 'Launch site').locator('.bar').boundingBox();
  const today = await row(page, 'Launch site').locator('.today-line').boundingBox();
  expect(bar).not.toBeNull();
  expect(today).not.toBeNull();
  // 3 Mar to 28 Apr is 57 days at 6 px; 15 Mar is 12 days after 3 Mar.
  expect(bar!.width).toBeCloseTo(342, 0);
  expect(today!.x - bar!.x).toBeCloseTo(72, 0);
  await expect(row(page, 'Hire').locator('.bar')).toHaveCount(0);
});

test('FR-1.7: rows collapse and expand, and the List shows the same state', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Design')).toBeVisible();
  await page.getByRole('button', { name: 'Collapse Launch site', exact: true }).click();
  await expect(row(page, 'Design')).toHaveCount(0);

  await views(page).getByRole('link', { name: 'List', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/projects`);
  const list = page.getByRole('table', { name: 'Projects', exact: true });
  await expect(list.getByRole('link', { name: 'Launch site', exact: true })).toBeVisible();
  await expect(list.getByRole('link', { name: 'Design', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand Launch site', exact: true }).click();
  await expect(list.getByRole('link', { name: 'Design', exact: true })).toBeVisible();

  await views(page).getByRole('link', { name: 'Timeline', exact: true }).click();
  await expect(row(page, 'Design')).toBeVisible();
});

test('FR-1.7: choosing a row opens the panel beside the Timeline, and saving new dates moves the bar', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await timeline(page).getByRole('link', { name: 'Hire', exact: true }).click();
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline/${hire}`);
  const panel = panelOf(page, 'Hire');
  await expect(panel).toBeVisible();
  await expect(timeline(page)).toBeVisible();
  await expectNoA11yViolations(page);

  await panel.getByLabel('Start date', { exact: true }).fill('2027-03-01');
  await panel.getByLabel('End date', { exact: true }).fill('2027-03-05');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
  await expect(row(page, 'Hire')).toContainText('1 Mar to 5 Mar 2027');
  // 5 days at 6 px.
  await expect(row(page, 'Hire').locator('.bar')).toHaveCount(1);
  expect((await row(page, 'Hire').locator('.bar').boundingBox())!.width).toBeCloseTo(30, 0);
});

test('FR-1.7: the status pill and the Actions menu work on a row', async ({ page, call, roadmap }) => {
  // Below 600 px the row has neither: both are in the panel and the List.
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await row(page, 'Hire').getByRole('button', { name: 'Status of Hire: Not started', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
  await expect(row(page, 'Hire').getByRole('button', { name: 'Status of Hire: Done', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Hire', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived Hire.' })).toHaveText('Archived Hire.');
  await expect(row(page, 'Hire')).toHaveCount(0);
});

test('FR-1.7: Review focus 5: switching view with unsaved panel text asks first', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { hire } = await seeded(call, roadmap.id);
  await page.clock.setFixedTime(NOW);
  await page.goto(`/r/${roadmap.id}/timeline/${hire}`);
  const panel = panelOf(page, 'Hire');
  await panel.getByLabel('Title', { exact: true }).fill('Hire a lead');
  await views(page).getByRole('link', { name: 'List', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved changes to Hire?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline/${hire}`);
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('Hire a lead');
});

test('FR-1.7: filters apply: a search shows the match and its greyed ancestor', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id, '?q=design');
  await expect(row(page, 'Design')).toBeVisible();
  await expect(row(page, 'Design')).not.toContainText('Shown for context');
  await expect(row(page, 'Launch site')).toContainText('Shown for context');
  await expect(row(page, 'Hire')).toHaveCount(0);
});

test('FR-1.7: empty states', async ({ page, call, roadmap }) => {
  await openTimeline(page, roadmap.id);
  await expect(page.getByText('No projects yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);

  await seedProject(call, roadmap.id, 'Hire');
  await page.reload();
  await expect(page.getByText('No items have dates yet. Open an item to add its dates.', { exact: true })).toBeVisible();
  await expect(row(page, 'Hire')).toContainText('No dates');
});

test('FR-1.7: a Contributor who is not assigned sees plain status text and no Archive or Delete', async ({ browser, call, roadmap }) => {
  await seeded(call, roadmap.id);
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'viewer');
  const page = guest.page;
  // Below 600 px the row has neither the status nor the Actions menu.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Hire')).toContainText('Not started');
  await expect(row(page, 'Hire').getByRole('button', { name: /^Status of Hire/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for Hire', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await guest.context.close();
});

test('FR-1.7: a row menu opened on the last row is fully visible and not clipped by the timeline frame', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  // Enough rows to run past the bottom of the window, so the last row sits at the bottom of the frame and the page.
  for (let i = 1; i <= 12; i++) await seedProject(call, roadmap.id, `Row ${i}`);
  await openTimeline(page, roadmap.id);
  await page.getByRole('button', { name: 'Actions for Row 12', exact: true }).click();
  const remove = page.getByRole('menuitem', { name: 'Delete', exact: true });
  await expectFullyShown(page, remove);
  // The frame did not scroll down to make room for the list, so the dates header is still in view.
  expect(await frame(page).evaluate((el) => el.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');

  // A menu on the first row runs down over the name cells of the rows below, and stays on top of them.
  await page.getByRole('button', { name: /^Status of Launch site/ }).click();
  await expectFullyShown(page, page.getByRole('menuitemradio', { name: 'Cancelled', exact: true }));
});

test('FR-1.7: a milestone sits at its date and a one-date item is an 8 px marker', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  const bar = await box(row(page, 'Launch site').locator('.bar'));
  const beta = await box(row(page, 'Launch site').locator('.milestone'));
  // The diamond is centred on the start of 1 Apr: 29 days after 3 Mar at 6 px.
  expect(beta.x + beta.width / 2 - bar.x).toBeCloseTo(174, 0);
  expect(await barWidth(page, 'Design')).toBeCloseTo(8, 0);
});

test('FR-1.7: a search with no match shows the no-match message and Clear filters on the Timeline', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id, '?q=nothing-like-this');
  await expect(page.getByText('No projects match these filters.', { exact: true })).toBeVisible();
  await expect(timeline(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(row(page, 'Launch site')).toBeVisible();
  await expect(row(page, 'Hire')).toBeVisible();
});

test('FR-1.7: Zoom changes the scale and is kept in the address', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await expect(zoom(page)).toHaveValue('months');
  await zoom(page).selectOption({ label: 'Weeks' });
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline?zoom=weeks`);
  // A new scale puts today back a third of the way in.
  await expect.poll(() => todayInView(page)).toBe(true);
  // 57 days at 24 px.
  await expect.poll(() => barWidth(page, 'Launch site')).toBeCloseTo(1368, 0);
  await zoom(page).selectOption({ label: 'Quarters' });
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline?zoom=quarters`);
  await expect.poll(() => barWidth(page, 'Launch site')).toBeCloseTo(114, 0);
  await page.reload();
  await expect(zoom(page)).toHaveValue('quarters');
  await expect(zoom(page).locator('option:checked')).toHaveText('Quarters');
});

test('FR-1.7: changing a filter keeps the zoom', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id, '?zoom=weeks');
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('la');
  await expect(page).toHaveURL(`/r/${roadmap.id}/timeline?q=la&zoom=weeks`);
  await expect(zoom(page)).toHaveValue('weeks');
});

test('FR-1.7: the header shows the dates for the zoom', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  const header = timeline(page).locator('thead');
  await expect(header).toContainText('2027');
  await expect(header).toContainText('Mar');
  await zoom(page).selectOption({ label: 'Weeks' });
  await expect(header).toContainText('March 2027');
  await zoom(page).selectOption({ label: 'Quarters' });
  await expect(header).toContainText('Q1');
});

test('FR-1.7: the Timeline opens with today in view, and Today brings it back', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  // At Weeks the schedule is far wider than the window.
  await openTimeline(page, roadmap.id, '?zoom=weeks');
  await expect.poll(() => todayInView(page)).toBe(true);
  await frame(page).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => todayInView(page)).toBe(false);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect.poll(() => todayInView(page)).toBe(true);
});

test('FR-1.7: Review focus 1: items in 1900 and 2200 give a track no wider than 24,000 px', async ({ page, call, roadmap }) => {
  const base = `/api/roadmaps/${roadmap.id}/projects`;
  const old = await seedProject(call, roadmap.id, 'Old');
  const far = await seedProject(call, roadmap.id, 'Far');
  await call('PATCH', `${base}/${old}`, { version: 1, startDate: '1900-01-01', endDate: '1900-01-02' });
  await call('PATCH', `${base}/${far}`, { version: 1, startDate: '2200-12-30', endDate: '2200-12-31' });
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Far')).toContainText('30 Dec to 31 Dec 2200');
  const scrollWidth = await frame(page).evaluate((el) => el.scrollWidth);
  const names = await box(nameHeader(page));
  expect(scrollWidth).toBeLessThanOrEqual(24_000 + Math.ceil(names.width));
  expect(await barWidth(page, 'Old')).toBeGreaterThanOrEqual(8);
  expect(await barWidth(page, 'Far')).toBeGreaterThanOrEqual(8);
});

test('FR-1.9: at 375 px the timeline scrolls sideways inside its frame and the page does not', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Launch site')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const sizes = await frame(page).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);
  // The name column is narrow, and the status and Actions menu are left to the panel and the List.
  expect((await box(nameHeader(page))).width).toBeCloseTo(140, 0);
  await expect(row(page, 'Launch site').getByRole('button', { name: 'Actions for Launch site', exact: true })).toBeHidden();
  await expect(row(page, 'Launch site').getByRole('button', { name: /^Status of Launch site/ })).toBeHidden();
  // The status is still said, as text: no button in the row can take focus for it.
  await expect(row(page, 'Launch site').getByRole('rowheader')).toHaveAccessibleName(/Not started/);
  await expect(row(page, 'Launch site').getByRole('button', { name: /Status of/ })).toHaveCount(0);

  await frame(page).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => frame(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const link = timeline(page).getByRole('link', { name: 'Launch site', exact: true });
  await expect(link).toBeInViewport();
  expect((await box(link)).x).toBeGreaterThanOrEqual((await box(frame(page))).x);
});

test('FR-1.7: the name column stays in place while the bars scroll', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id, '?zoom=weeks');
  const link = timeline(page).getByRole('link', { name: 'Launch site', exact: true });
  const bar = row(page, 'Launch site').locator('.bar');
  await frame(page).evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect.poll(() => frame(page).evaluate((el) => el.scrollLeft)).toBe(0);
  const before = { name: (await box(link)).x, bar: (await box(bar)).x };
  await frame(page).evaluate((el) => {
    el.scrollLeft = 400;
  });
  await expect.poll(async () => (await box(bar)).x).toBeCloseTo(before.bar - 400, 0);
  expect((await box(link)).x).toBeCloseTo(before.name, 0);
  // The bars pass under the names, not over them.
  await expectFullyShown(page, link);
});

test('FR-1.9: the Timeline passes axe at 375 px', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Launch site')).toBeVisible();
  await expectNoA11yViolations(page);
});

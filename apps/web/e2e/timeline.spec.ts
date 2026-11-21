import type { Page } from '@playwright/test';
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

test('bars sit where the dates say', async ({ page, call, roadmap }) => {
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

test('rows collapse and expand, and the List shows the same state', async ({ page, call, roadmap }) => {
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

test('choosing a row opens the panel beside the Timeline, and saving new dates moves the bar', async ({ page, call, roadmap }) => {
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

test('the status pill and the Actions menu work on a row', async ({ page, call, roadmap }) => {
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

test('Review focus 5: switching view with unsaved panel text asks first', async ({ page, call, roadmap }) => {
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

test('filters apply: a search shows the match and its greyed ancestor', async ({ page, call, roadmap }) => {
  await seeded(call, roadmap.id);
  await openTimeline(page, roadmap.id, '?q=design');
  await expect(row(page, 'Design')).toBeVisible();
  await expect(row(page, 'Design')).not.toContainText('Shown for context');
  await expect(row(page, 'Launch site')).toContainText('Shown for context');
  await expect(row(page, 'Hire')).toHaveCount(0);
});

test('empty states', async ({ page, call, roadmap }) => {
  await openTimeline(page, roadmap.id);
  await expect(page.getByText('No projects yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await expect(timeline(page)).toHaveCount(0);

  await seedProject(call, roadmap.id, 'Hire');
  await page.reload();
  await expect(page.getByText('No items have dates yet. Open an item to add its dates.', { exact: true })).toBeVisible();
  await expect(row(page, 'Hire')).toContainText('No dates');
});

test('a Contributor who is not assigned sees plain status text and no Archive or Delete', async ({ browser, call, roadmap }) => {
  await seeded(call, roadmap.id);
  const guest = await joinByApi(browser, call, roadmap.id, 'contributor', 'viewer');
  const page = guest.page;
  await openTimeline(page, roadmap.id);
  await expect(row(page, 'Hire')).toContainText('Not started');
  await expect(row(page, 'Hire').getByRole('button', { name: /^Status of Hire/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Actions for Hire', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
  await guest.context.close();
});

import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Download, Page } from '@playwright/test';
import type { Project } from '@roadmap/shared';
import ICAL from 'ical.js';
import { expectNoA11yViolations, useCspGuard } from './helpers.ts';
import { expect, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const FEED_URL = /^http:\/\/localhost:5173\/api\/calendar\/[A-Za-z0-9_-]+\.ics$/;

/** The calendar a feed URL answers with, fetched with no cookies, as a calendar app does. */
async function fetchFeed(request: APIRequestContext, url: string) {
  const res = await request.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  expect(res.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  const cal = new ICAL.Component(ICAL.parse(await res.text()) as unknown[]);
  return cal.getAllSubcomponents('vevent').map((e) => ({
    summary: String(e.getFirstPropertyValue('summary')),
    start: String(e.getFirstPropertyValue('dtstart')),
    end: String(e.getFirstPropertyValue('dtend')),
  }));
}

/** An item with both dates and a milestone, through the API; gives back the saved item. */
async function seedDatedItem(call: ApiCall, roadmapId: string): Promise<Project> {
  const { id } = await call<{ id: string }>('POST', `/api/roadmaps/${roadmapId}/projects`, { parentId: null, title: 'Launch' });
  return call<Project>('PATCH', `/api/roadmaps/${roadmapId}/projects/${id}`, {
    version: 1,
    startDate: '2027-03-03',
    endDate: '2027-04-28',
    milestones: [{ name: 'Beta', date: '2027-03-20' }],
  });
}

async function openCalendarSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Security' }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Calendar feed' }).click();
  await expect(page).toHaveURL('/settings/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar feed', level: 1 })).toBeVisible();
}

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Makes the link on the page and copies it; returns what the clipboard holds. */
async function createAndCopy(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create calendar link' }).click();
  await expect(page.getByRole('heading', { name: 'Your calendar link', level: 2 })).toBeFocused();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied.' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(FEED_URL);
  await expect(page.getByLabel('Calendar link', { exact: true })).toHaveValue(copied);
  return copied;
}

test('FR-4.1: a person creates a feed, copies the link, and fetching it returns a calendar with their item\'s dates', async ({ page, call, roadmap, request }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedDatedItem(call, roadmap.id);
  await openCalendarSettings(page);
  const url = await createAndCopy(page);

  const events = await fetchFeed(request, url);
  expect(events).toEqual(
    expect.arrayContaining([
      { summary: 'Launch', start: '2027-03-03', end: '2027-04-29' },
      { summary: 'Beta · Launch', start: '2027-03-20', end: '2027-03-21' },
    ]),
  );
  expect(events).toHaveLength(2);

  // Only milestones, saved on the page, and the same link shows just those.
  await page.getByRole('checkbox', { name: 'Item dates' }).uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect((await fetchFeed(request, url)).map((e) => e.summary)).toEqual(['Beta · Launch']);
});

test('FR-4.4: after "Get a new link" the old link is 404 and the new one works', async ({ page, call, roadmap, request }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedDatedItem(call, roadmap.id);
  await openCalendarSettings(page);
  const oldUrl = await createAndCopy(page);

  await page.getByRole('button', { name: 'Get a new link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Get a new calendar link?' });
  await dialog.getByRole('button', { name: 'Get new link' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Your calendar link', level: 2 })).toBeFocused();
  const newUrl = await page.getByLabel('Calendar link', { exact: true }).inputValue();
  expect(newUrl).toMatch(FEED_URL);
  expect(newUrl).not.toBe(oldUrl);

  expect((await request.get(oldUrl)).status()).toBe(404);
  expect((await fetchFeed(request, newUrl)).map((e) => e.summary).sort()).toEqual(['Beta · Launch', 'Launch']);

  // Turning it off ends the new link too.
  await page.getByRole('button', { name: 'Turn off the feed' }).click();
  await page.getByRole('dialog', { name: 'Turn off your calendar feed?' }).getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Create calendar link' })).toBeFocused();
  expect((await request.get(newUrl)).status()).toBe(404);
});

test('FR-4.1: the page passes axe with no feed, just after creating, and on a later visit; at 375 px there is no sideways scroll', async ({ page, owner, roadmap }) => {
  void owner;
  void roadmap;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const tabs = page.getByRole('navigation', { name: 'Settings' });

  await openCalendarSettings(page);
  await expect(tabs.getByRole('link')).toHaveText(['Security', 'Email notifications', 'Calendar feed']);
  await expect(tabs.getByRole('link', { name: 'Calendar feed' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Create calendar link' })).toBeVisible();
  await expectNoA11yViolations(page);
  expect(await noSidewaysScroll(page)).toBe(true);

  await createAndCopy(page);
  await page.getByRole('radio', { name: 'Only these' }).check();
  await expect(page.getByRole('group', { name: 'Only these' }).getByRole('checkbox', { name: 'Fixture plan' })).toBeEnabled();
  await expect(page.getByText('Choose at least one roadmap.')).toBeVisible();
  await expectNoA11yViolations(page);
  expect(await noSidewaysScroll(page)).toBe(true);

  // Unsaved: the tabs ask before leaving.
  await tabs.getByRole('link', { name: 'Email notifications' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard your unsaved changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL('/settings/calendar');

  await page.getByRole('checkbox', { name: 'Fixture plan' }).check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  await page.reload();
  await expect(page.getByText(/^Your calendar link is active\. It was made on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/)).toBeVisible();
  await expect(page.getByText('No calendar app has checked it yet.')).toBeVisible();
  await expect(page.getByLabel('Calendar link', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Only these' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Fixture plan' })).toBeChecked();
  await expectNoA11yViolations(page);
  expect(await noSidewaysScroll(page)).toBe(true);

  await page.getByRole('button', { name: 'Get a new link' }).click();
  await expect(page.getByRole('dialog', { name: 'Get a new calendar link?' })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole('dialog', { name: 'Get a new calendar link?' }).getByRole('button', { name: 'Get new link' }).click();
  await expect(page.getByLabel('Calendar link', { exact: true })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectNoA11yViolations(page);
});

/** The events in a downloaded calendar file, with their UIDs. */
async function eventsIn(download: Download) {
  const path = await download.path();
  const cal = new ICAL.Component(ICAL.parse(await readFile(path, 'utf8')) as unknown[]);
  return cal.getAllSubcomponents('vevent').map((e) => ({
    uid: String(e.getFirstPropertyValue('uid')),
    summary: String(e.getFirstPropertyValue('summary')),
    start: String(e.getFirstPropertyValue('dtstart')),
    end: String(e.getFirstPropertyValue('dtend')),
  }));
}

test('FR-4.5: "Add to calendar" on an item downloads "{title}.ics", which parses to the item\'s event and its milestones with the feed\'s UIDs', async ({ page, call, roadmap, request }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const launch = await seedDatedItem(call, roadmap.id);
  await call('POST', `/api/roadmaps/${roadmap.id}/projects`, { parentId: null, title: 'Undated' });
  const beta = launch.milestones[0]!;
  const expected = [
    { uid: `item-${launch.id}@localhost:5173`, summary: 'Launch', start: '2027-03-03', end: '2027-04-29' },
    { uid: `milestone-${beta.id}@localhost:5173`, summary: 'Beta · Launch', start: '2027-03-20', end: '2027-03-21' },
  ];

  // The feed's UIDs for the same item, to compare with.
  await openCalendarSettings(page);
  const feedUrl = await createAndCopy(page);
  const feed = await request.get(feedUrl);
  const feedCal = new ICAL.Component(ICAL.parse(await feed.text()) as unknown[]);
  const feedUids = feedCal.getAllSubcomponents('vevent').map((e) => String(e.getFirstPropertyValue('uid')));
  expect(feedUids.sort()).toEqual(expected.map((e) => e.uid).sort());

  // The Actions menu on the List; an item with no dates doesn't offer it.
  await page.goto(`/r/${roadmap.id}/projects`);
  await page.getByRole('button', { name: 'Actions for Undated', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add to calendar' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Actions for Launch', exact: true }).click();
  const fromMenu = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Add to calendar' }).click();
  const download = await fromMenu;
  expect(download.suggestedFilename()).toBe('Launch.ics');
  expect(await eventsIn(download)).toEqual(expect.arrayContaining(expected));
  expect(await eventsIn(download)).toHaveLength(2);
  await expect(page).toHaveURL(`/r/${roadmap.id}/projects`);

  // The button in the item panel, under the dates, on the Board.
  await page.goto(`/r/${roadmap.id}/board/${launch.id}`);
  const panel = page.getByRole('region', { name: 'Launch', exact: true });
  const fromPanel = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Add to calendar' }).click();
  const again = await fromPanel;
  expect(again.suggestedFilename()).toBe('Launch.ics');
  expect((await eventsIn(again)).map((e) => e.uid).sort()).toEqual(expected.map((e) => e.uid).sort());
  await expect(page).toHaveURL(`/r/${roadmap.id}/board/${launch.id}`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('FR-4.5: when the download is refused the page stays put and says so', async ({ page, call, roadmap }) => {
  await seedDatedItem(call, roadmap.id);
  // The connection drops on the way to the file.
  await page.route('**/calendar.ics', (route) => route.abort());
  await page.goto(`/r/${roadmap.id}/board`);
  await page.getByRole('button', { name: 'Actions for Launch', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add to calendar' }).click();
  await expect(page.getByRole('alert')).toHaveText("Couldn't download the calendar file. Try again.");
  await expect(page).toHaveURL(`/r/${roadmap.id}/board`);
});

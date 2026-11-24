import type { APIRequestContext, Page } from '@playwright/test';
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

/** An item with both dates and a milestone, through the API. */
async function seedDatedItem(call: ApiCall, roadmapId: string) {
  const { id } = await call<{ id: string }>('POST', `/api/roadmaps/${roadmapId}/projects`, { parentId: null, title: 'Launch' });
  await call('PATCH', `/api/roadmaps/${roadmapId}/projects/${id}`, {
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

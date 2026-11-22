import type { Page } from '@playwright/test';
import { expectNoA11yViolations, field, seedNote, seedProject, useCspGuard, watchCsp } from './helpers.ts';
import { createSnapshotByApi, expect, SNAPSHOT_PASSWORD, strangerContext, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const AS_OF = /^As of \d{1,2} [A-Z][a-z]{2} \d{4}$/;

async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

/** Records every API path the page asks for. */
function apiPaths(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/')) paths.push(pathname);
  });
  return paths;
}

/** Opens the link, enters the right password, and waits for the list. */
async function unlock(page: Page, linkId: string, roadmapName: string) {
  await page.goto(`/s/${linkId}`);
  await field(page, 'Password').fill(SNAPSHOT_PASSWORD);
  await page.getByRole('button', { name: 'View snapshot' }).click();
  await expect(page).toHaveURL(`/s/${linkId}/list`);
  await expect(page.getByRole('heading', { level: 1, name: roadmapName })).toBeVisible();
}

/**
 * "Launch site" (in progress, 3 Mar to 28 Apr 2027, P1, assigned to the owner, with a description, a milestone, a tag,
 * a link, blocked by "Hire", and a note with a reply) holding "Design"; and "Hire".
 */
async function seeded(call: ApiCall, roadmapId: string) {
  const base = `/api/roadmaps/${roadmapId}/projects`;
  const me = (await call<{ user: { id: string } }>('GET', '/api/me')).user.id;
  const launch = await seedProject(call, roadmapId, 'Launch site');
  const hire = await seedProject(call, roadmapId, 'Hire');
  await seedProject(call, roadmapId, 'Design', launch);
  await call('PATCH', `${base}/${launch}`, {
    version: 1,
    status: 'in_progress',
    startDate: '2027-03-03',
    endDate: '2027-04-28',
    description: 'First line\nSecond line',
    milestones: [{ name: 'Beta', date: '2027-04-01' }],
    tags: ['web'],
    links: [{ label: 'Spec', url: 'https://example.com/spec' }],
    blockedBy: [hire],
  });
  await call('PUT', `${base}/${launch}/assignees`, { userIds: [me] });
  await call('PUT', `${base}/${launch}/priority-label`, { label: 'P1' });
  const top = await seedNote(call, roadmapId, launch, 'Kick-off went well');
  await seedNote(call, roadmapId, launch, 'Agreed', top);
  return { base, launch, hire };
}

test('FR-3.2: a stakeholder opens the link, enters the password and reads the list and the timeline', async ({ browser, call, owner, roadmap }) => {
  await seeded(call, roadmap.id);
  const linkId = await createSnapshotByApi(call, roadmap.id, { include: { notes: true, assignees: true } });
  const { context, page } = await strangerContext(browser);
  const asked = apiPaths(page);

  await page.goto(`/s/${linkId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'This snapshot is password protected' })).toBeVisible();
  await expect(page.getByText('Enter the password you were given.')).toBeVisible();
  await expect(page.getByText("If you don't have the password, ask the person who sent you the link.")).toBeVisible();
  await expect(field(page, 'Password')).toHaveAttribute('autocomplete', 'current-password');
  // Nothing about the roadmap before the password, and no app header.
  await expect(page.getByText(roadmap.name)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Roadmap' })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  await field(page, 'Password').fill(SNAPSHOT_PASSWORD);
  await page.getByRole('button', { name: 'View snapshot' }).click();
  await expect(page).toHaveURL(`/s/${linkId}/list`);
  const heading = page.getByRole('heading', { level: 1, name: roadmap.name });
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle(`${roadmap.name}: snapshot`);
  await expect(page.getByText(AS_OF)).toBeVisible();
  const list = page.getByRole('table', { name: 'List' });
  await expect(list.getByRole('rowheader')).toHaveText(['Project: Launch site', 'Sub-project: Design', 'Project: Hire']);
  await expect(list.getByText('In progress')).toBeVisible();
  await expect(list.getByText('3 Mar to 28 Apr 2027')).toBeVisible();
  await expect(list.getByText('1 · P1')).toBeVisible();
  await expect(list.getByText(owner.name)).toBeVisible();
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  const title = page.getByRole('button', { name: 'Details for Launch site' });
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  const details = page.locator(`#${await title.getAttribute('aria-controls')}`);
  for (const part of ['Description', 'Milestones', 'Tags', 'Links', 'Blocked by', 'Notes']) {
    await expect(details.getByRole('heading', { name: part, exact: true })).toBeVisible();
  }
  await expect(details.getByText('Beta, 1 Apr 2027')).toBeVisible();
  await expect(details.getByRole('link', { name: 'Spec' })).toHaveAttribute('rel', 'noopener noreferrer');
  const notes = details.getByRole('list', { name: 'Notes' });
  await expect(notes.getByText('Kick-off went well')).toBeVisible();
  await expect(notes.getByRole('list').getByText('Agreed')).toBeVisible();
  await expect(notes.getByText(owner.name).first()).toBeVisible();
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(`/s/${linkId}/timeline`);
  const timeline = page.getByRole('table', { name: 'Timeline' });
  await expect(timeline.getByRole('rowheader')).toHaveCount(3);
  await expect(page.locator('.today-label')).toHaveText('As of');
  await expect(page.getByLabel('Zoom')).toHaveValue('months');
  await page.getByLabel('Zoom').selectOption({ label: 'Weeks' });
  await expect(page).toHaveURL(`/s/${linkId}/timeline?zoom=weeks`);
  // Notes are read in the list; the timeline shows none.
  await expect(page.getByText('Kick-off went well')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  // Only the snapshot's own routes: never /api/me, never anything that could send the stakeholder to sign in.
  expect(asked.every((p) => p.startsWith(`/api/snapshots/${linkId}`))).toBe(true);
  await expect(page).toHaveURL(/\/s\//);
  await context.close();
});

test('FR-3.1: a title changed after the snapshot was made still shows the old title', async ({ browser, call, roadmap }) => {
  const itemId = await seedProject(call, roadmap.id, 'Old title');
  const linkId = await createSnapshotByApi(call, roadmap.id);
  await call('PATCH', `/api/roadmaps/${roadmap.id}/projects/${itemId}`, { version: 1, title: 'New title' });

  const { context, page } = await strangerContext(browser);
  await unlock(page, linkId, roadmap.name);
  await expect(page.getByRole('table', { name: 'List' }).getByText('Old title')).toBeVisible();
  await expect(page.getByText('New title')).toHaveCount(0);
  await context.close();
});

test('FR-3.5: a snapshot made without notes or names shows neither anywhere on the page', async ({ browser, call, owner, roadmap }) => {
  await seeded(call, roadmap.id);
  const linkId = await createSnapshotByApi(call, roadmap.id);
  const { context, page } = await strangerContext(browser);
  await unlock(page, linkId, roadmap.name);

  await expect(page.getByRole('columnheader', { name: 'Assigned to' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Details for Launch site' }).click();
  await expect(page.getByRole('heading', { name: 'Description' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Notes' })).toHaveCount(0);
  let html = await page.content();
  expect(html).not.toContain(owner.name);
  expect(html).not.toContain('Kick-off went well');

  await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Timeline' }).click();
  await expect(page.getByRole('table', { name: 'Timeline' })).toBeVisible();
  html = await page.content();
  expect(html).not.toContain(owner.name);
  expect(html).not.toContain('Kick-off went well');
  await context.close();
});

test('FR-3.6: five wrong passwords lock the link, and the right one then shows the locked message', async ({ browser, call, roadmap }) => {
  const linkId = await createSnapshotByApi(call, roadmap.id);
  const { context, page } = await strangerContext(browser);
  await page.goto(`/s/${linkId}`);
  const password = field(page, 'Password');

  for (let i = 1; i <= 5; i += 1) {
    await password.fill(`wrong guess ${i}`);
    await page.getByRole('button', { name: 'View snapshot' }).click();
    await expect(page.getByRole('alert')).toHaveText(i < 5 ? "That password isn't right." : 'Too many wrong passwords. Try again in 15 minutes.');
    await expect(password).toBeFocused();
  }
  await expectNoA11yViolations(page);

  await password.fill(SNAPSHOT_PASSWORD);
  await page.getByRole('button', { name: 'View snapshot' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many wrong passwords. Try again in 15 minutes.');
  await expect(page).toHaveURL(`/s/${linkId}`);
  await expect(page.getByText(roadmap.name)).toHaveCount(0);
  await context.close();
});

test('FR-3.2: a revoked link shows "This link doesn\'t work"', async ({ browser, page: ownerPage, call, roadmap }) => {
  const linkId = await createSnapshotByApi(call, roadmap.id, { name: 'Board pack' });

  // The Snapshots tab's Open link leads to the password page.
  await ownerPage.goto(`/r/${roadmap.id}/snapshots`);
  const [opened] = await Promise.all([ownerPage.waitForEvent('popup'), ownerPage.getByRole('link', { name: 'Open Board pack' }).click()]);
  watchCsp(opened);
  await expect(opened).toHaveURL(`/s/${linkId}`);
  await expect(opened.getByRole('heading', { level: 1, name: 'This snapshot is password protected' })).toBeVisible();
  await opened.close();

  const { context, page } = await strangerContext(browser);
  await unlock(page, linkId, roadmap.name);

  const { snapshots } = await call<{ snapshots: Array<{ id: string; linkId: string }> }>('GET', `/api/roadmaps/${roadmap.id}/snapshots`);
  await call('DELETE', `/api/roadmaps/${roadmap.id}/snapshots/${snapshots.find((s) => s.linkId === linkId)!.id}`);

  // The tab that had it open reloads.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: "This link doesn't work" })).toBeVisible();
  await expect(page.getByText('The snapshot may have been removed. Ask the person who sent it for a new link.')).toBeVisible();
  await expect(page.getByText(roadmap.name)).toHaveCount(0);
  await expectNoA11yViolations(page);
  await expectNoSidewaysScroll(page);

  // And the link itself.
  await page.goto(`/s/${linkId}`);
  await expect(page.getByRole('heading', { level: 1, name: "This link doesn't work" })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await context.close();
});

test('FR-3.2: reloading keeps the snapshot open, and a new browser context is asked for the password', async ({ browser, call, roadmap }) => {
  await seedProject(call, roadmap.id, 'Launch site');
  const linkId = await createSnapshotByApi(call, roadmap.id);
  const first = await strangerContext(browser);
  await unlock(first.page, linkId, roadmap.name);

  await first.page.reload();
  await expect(first.page).toHaveURL(`/s/${linkId}/list`);
  await expect(first.page.getByRole('heading', { level: 1, name: roadmap.name })).toBeVisible();
  // The password page also goes straight on.
  await first.page.goto(`/s/${linkId}`);
  await expect(first.page).toHaveURL(`/s/${linkId}/list`);

  const second = await strangerContext(browser);
  await second.page.goto(`/s/${linkId}`);
  await expect(second.page.getByRole('heading', { level: 1, name: 'This snapshot is password protected' })).toBeVisible();
  await expect(second.page.getByRole('alert')).toHaveCount(0);
  // The list's own address, kept from before, asks for the password too.
  await second.page.goto(`/s/${linkId}/list`);
  await expect(second.page).toHaveURL(`/s/${linkId}`);
  await expect(second.page.getByRole('alert')).toHaveText('Enter the password again to keep viewing.');
  await expect(second.page.getByText(roadmap.name)).toHaveCount(0);
  await first.context.close();
  await second.context.close();
});

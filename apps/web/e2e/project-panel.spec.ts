import { expect, test, type Page } from '@playwright/test';
import {
  apiAs,
  createRoadmap,
  createSignedInUser,
  expectNoA11yViolations,
  inviteAndJoin,
  openProject,
  projectRow,
  seedProject,
  useCspGuard,
} from './helpers.ts';

useCspGuard();

const panelOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const projectUrl = (roadmapId: string, projectId: string) => `/r/${roadmapId}/projects/${projectId}`;

test('FR-1.4: an Admin opens an item, changes title, description, status and dates, saves, and the row and a reload show them', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'editor');
  const id = await createRoadmap(page, 'Edit plan');
  const admin = await inviteAndJoin(page, browser, testInfo, 'Edit plan', 'chief', 'Admin');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Launch site');

  const p = admin.page;
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto(`/r/${id}/projects`);
  await openProject(p, 'Launch site');
  const panel = panelOf(p, 'Launch site');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Project', { exact: true })).toBeVisible();

  // Focus moves into the panel when it opens.
  await expect(panel.getByRole('heading', { name: 'Launch site', level: 2 })).toBeFocused();

  await panel.getByLabel('Title', { exact: true }).fill('Launch the new site');
  await panel.getByLabel('Description', { exact: true }).fill('Move every page to the new design.');
  await panel.getByLabel('Status', { exact: true }).selectOption({ label: 'In progress' });
  await panel.getByLabel('Start date', { exact: true }).fill('2027-03-03');
  await panel.getByLabel('End date', { exact: true }).fill('2027-04-28');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(panelOf(p, 'Launch the new site').getByRole('status')).toHaveText('Saved.');
  const row = projectRow(p, 'Launch the new site');
  await expect(row).toContainText('In progress');
  await expect(row).toContainText('3 Mar to 28 Apr 2027');

  await p.reload();
  const again = panelOf(p, 'Launch the new site');
  await expect(again.getByLabel('Title', { exact: true })).toHaveValue('Launch the new site');
  await expect(again.getByLabel('Description', { exact: true })).toHaveValue('Move every page to the new design.');
  await expect(again.getByLabel('Status', { exact: true })).toHaveValue('in_progress');
  await expect(again.getByLabel('Start date', { exact: true })).toHaveValue('2027-03-03');
  await expect(again.getByLabel('End date', { exact: true })).toHaveValue('2027-04-28');

  // Clearing a date saves as no date.
  await again.getByLabel('End date', { exact: true }).fill('');
  await again.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(again.getByRole('status')).toHaveText('Saved.');
  await expect(projectRow(p, 'Launch the new site')).toContainText('From 3 Mar 2027');
  expect(itemId).toBeTruthy();
  await admin.context.close();
});

test('the status pill in the row changes status without opening the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'pill');
  const id = await createRoadmap(page, 'Pill plan');
  const call = await apiAs(page);
  await seedProject(call, id, 'Write copy');
  await page.reload();

  const pill = page.getByRole('button', { name: /^Status of Write copy/ });
  await expect(pill).toContainText('Not started');
  await expect(pill).toHaveAttribute('aria-haspopup', 'menu');
  await pill.click();
  await expect(page.getByRole('menuitemradio')).toHaveText(['Not started', 'In progress', 'Blocked', 'Done', 'Cancelled']);
  await expect(page.getByRole('menuitemradio', { name: 'Not started' })).toBeChecked();
  await expect(page.getByRole('menuitemradio', { name: 'Not started' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(projectRow(page, 'Write copy')).toContainText('Blocked');
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Status of Write copy/ })).toBeFocused();

  await page.reload();
  await expect(projectRow(page, 'Write copy')).toContainText('Blocked');
  await page.getByRole('button', { name: /^Status of Write copy/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Blocked' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('Review focus 1: when someone else saved first, Save shows the conflict message, and Reload brings in their change', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'racer');
  const id = await createRoadmap(page, 'Race plan');
  const other = await inviteAndJoin(page, browser, testInfo, 'Race plan', 'rival', 'Admin');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Original');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Original');
  await expect(panel).toBeVisible();

  // Someone else saves first.
  const theirs = await apiAs(other.page);
  await theirs('PATCH', `/api/roadmaps/${id}/projects/${itemId}`, { version: 1, title: 'Their title', status: 'done' });

  await panel.getByLabel('Title', { exact: true }).fill('My title');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Someone else changed this at the same time. Reload and try again.');
  await expect(alert).toBeFocused();
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('My title');

  await alert.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(panelOf(page, 'Their title')).toBeVisible();
  await expect(panelOf(page, 'Their title').getByLabel('Title', { exact: true })).toHaveValue('Their title');
  await expect(panelOf(page, 'Their title').getByLabel('Status', { exact: true })).toHaveValue('done');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(panelOf(page, 'Their title').getByLabel('Title', { exact: true })).toBeFocused();

  // The reloaded form saves.
  await panelOf(page, 'Their title').getByLabel('Title', { exact: true }).fill('Merged title');
  await panelOf(page, 'Their title').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Merged title').getByRole('status')).toHaveText('Saved.');
  await other.context.close();
});

test('Review focus 4: an end date before the start date shows "The end date is before the start date." under End date', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'dates');
  const id = await createRoadmap(page, 'Date plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Season');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Season');

  await panel.getByLabel('Start date', { exact: true }).fill('2027-05-10');
  await panel.getByLabel('End date', { exact: true }).fill('2027-05-01');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  const end = panel.getByLabel('End date', { exact: true });
  await expect(panel.getByText('The end date is before the start date.', { exact: true })).toBeVisible();
  await expect(end).toBeFocused();
  await expect(end).toHaveAttribute('aria-invalid', 'true');
  await expect(end).toHaveAccessibleDescription('The end date is before the start date.');
  await expect(panel.getByRole('status')).toHaveText('');

  // Nothing was sent: the stored item still has no dates.
  const stored = await call<{ items: { id: string; startDate: string | null }[] }>('GET', `/api/roadmaps/${id}/projects`);
  expect(stored.items.find((i) => i.id === itemId)?.startDate).toBeNull();

  // When the server says the same, the same message shows under End date.
  await end.fill('2027-05-20');
  await page.route('**/api/roadmaps/*/projects/*', (route) =>
    route.request().method() === 'PATCH' ? route.fulfill({ status: 422, json: { error: 'date_order' } }) : route.continue(),
  );
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByText('The end date is before the start date.', { exact: true })).toBeVisible();
  await expect(end).toBeFocused();
  await page.unroute('**/api/roadmaps/*/projects/*');

  await end.fill('2027-05-20');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
  await expect(panel.getByText('The end date is before the start date.')).toHaveCount(0);
});

test('an empty title shows "Enter a title." under Title and sends nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'blank2');
  const id = await createRoadmap(page, 'Blank plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Keep me');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Keep me');
  const title = panel.getByLabel('Title', { exact: true });
  await title.fill('   ');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByText('Enter a title.', { exact: true })).toBeVisible();
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(projectRow(page, 'Keep me')).toBeVisible();
});

test('a child outside its parent\'s dates saves and shows "Dates fall outside {parent}\'s dates." and the row shows the warning icon', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'warner2');
  const id = await createRoadmap(page, 'Warn plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Season');
  const child = await seedProject(call, id, 'Opening night', parent);
  await call('PATCH', `/api/roadmaps/${id}/projects/${parent}`, { version: 1, startDate: '2027-03-01', endDate: '2027-03-31' });
  await page.goto(projectUrl(id, child));
  const panel = panelOf(page, 'Opening night');
  await expect(panel.getByText('Sub-project in Season', { exact: true })).toBeVisible();
  await expect(panel.getByText(/fall outside/)).toHaveCount(0);

  await panel.getByLabel('Start date', { exact: true }).fill('2027-04-02');
  await panel.getByLabel('End date', { exact: true }).fill('2027-04-03');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');
  await expect(panel.getByText("Dates fall outside Season's dates.", { exact: true })).toBeVisible();
  await expect(projectRow(page, 'Opening night').getByRole('img', { name: 'Has warnings' })).toBeVisible();
});

test('a Contributor who is not assigned sees the fields read-only with the explanation, and one who is assigned can save', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'lead2');
  const id = await createRoadmap(page, 'Rights plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Rights plan', 'helper2', 'Contributor');
  const call = await apiAs(page);
  const mine = await seedProject(call, id, 'Mine');
  const theirs = await seedProject(call, id, 'Theirs');
  const helper = (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${id}/members`)).members.find((m) => m.email === guest.email)!;

  const p = guest.page;
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto(projectUrl(id, theirs));
  const readOnly = panelOf(p, 'Theirs');
  await expect(readOnly.getByText('Only people assigned to this item, Owners and Admins can change it.', { exact: true })).toBeVisible();
  for (const label of ['Title', 'Description', 'Status', 'Start date', 'End date']) {
    await expect(readOnly.getByLabel(label, { exact: true })).not.toBeEditable();
  }
  await expect(readOnly.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  // A Contributor who may not edit sees the status pill as plain text.
  await expect(p.getByRole('button', { name: /^Status of Theirs/ })).toHaveCount(0);
  await expect(projectRow(p, 'Theirs')).toContainText('Not started');
  await expectNoA11yViolations(p);

  await call('PUT', `/api/roadmaps/${id}/projects/${mine}/assignees`, { userIds: [helper.userId] });
  await p.goto(projectUrl(id, mine));
  const editable = panelOf(p, 'Mine');
  await expect(editable.getByText('Only people assigned to this item, Owners and Admins can change it.')).toHaveCount(0);
  await editable.getByLabel('Title', { exact: true }).fill('Mine, renamed');
  await editable.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(p, 'Mine, renamed').getByRole('status')).toHaveText('Saved.');
  await expect(projectRow(p, 'Mine, renamed')).toBeVisible();

  // The assigned Contributor changes status from the row, too.
  await p.getByRole('button', { name: /^Status of Mine, renamed/ }).click();
  await p.getByRole('menuitemradio', { name: 'Done' }).click();
  await expect(projectRow(p, 'Mine, renamed')).toContainText('Done');
  await guest.context.close();
});

test('the status pill reports a stale version with the conflict message and refreshes the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'stale');
  const id = await createRoadmap(page, 'Stale plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Moving');
  await page.reload();
  await expect(projectRow(page, 'Moving')).toBeVisible();
  await call('PATCH', `/api/roadmaps/${id}/projects/${itemId}`, { version: 1, title: 'Moved' });

  await page.getByRole('button', { name: /^Status of Moving/ }).click();
  await page.getByRole('menuitemradio', { name: 'Done' }).click();
  await expect(page.getByRole('alert')).toContainText('Someone else changed this at the same time. Reload and try again.');
  await expect(projectRow(page, 'Moved')).toBeVisible();
  await expect(projectRow(page, 'Moved')).toContainText('Not started');
});

test('the panel is a side panel at 1280 px and a full screen with "Back to projects" at 375 px', async ({ page }) => {
  await createSignedInUser(page, 'sizer');
  const id = await createRoadmap(page, 'Size plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await seedProject(call, id, 'Beta');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await expect(panel).toBeVisible();
  const row = projectRow(page, 'Beta');
  await expect(row).toBeVisible();
  const [rowBox, panelBox] = [(await row.boundingBox())!, (await panel.boundingBox())!];
  expect(panelBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 1);
  await expect(page.getByRole('link', { name: 'Back to projects', exact: true })).toBeHidden();

  await page.setViewportSize({ width: 375, height: 667 });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('table')).toBeHidden();
  const narrow = (await panel.boundingBox())!;
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoA11yViolations(page);

  await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeFocused();
});

test('opening the panel\'s address directly shows the item, and an unknown id shows the roadmap\'s not-found message', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'direct');
  const id = await createRoadmap(page, 'Direct plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Alpha');
  const child = await seedProject(call, id, 'Beta', parent);

  await page.goto(projectUrl(id, child));
  await expect(panelOf(page, 'Beta')).toBeVisible();
  await expect(panelOf(page, 'Beta').getByText('Sub-project in Alpha', { exact: true })).toBeVisible();
  await expect(projectRow(page, 'Alpha')).toBeVisible();

  await page.goto(projectUrl(id, 'nope'));
  await expect(page.getByText("This roadmap doesn't exist, or you don't have access to it.", { exact: true })).toBeVisible();
  await expect(projectRow(page, 'Alpha')).toBeVisible();
  await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByText("This roadmap doesn't exist, or you don't have access to it.")).toHaveCount(0);
});

test('focus moves into the panel and back to the row on Close and on Escape; the panel passes axe', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'focus');
  const id = await createRoadmap(page, 'Focus plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await seedProject(call, id, 'Beta');
  await page.goto(`/r/${id}/projects`);

  await openProject(page, 'Alpha');
  const panel = panelOf(page, 'Alpha');
  await expect(panel.getByRole('heading', { name: 'Alpha', level: 2 })).toBeFocused();
  await expectNoA11yViolations(page);

  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeFocused();

  await openProject(page, 'Alpha');
  await expect(panelOf(page, 'Alpha')).toBeVisible();
  await page.getByLabel('Description', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeFocused();

  // Choosing another row moves into that item's panel, with its own values.
  await openProject(page, 'Alpha');
  await openProject(page, 'Beta');
  await expect(panelOf(page, 'Beta').getByRole('heading', { name: 'Beta', level: 2 })).toBeFocused();

  // If the row is gone when the panel closes, focus goes to the page heading.
  await page.goto(projectUrl(id, itemId));
  await expect(panelOf(page, 'Alpha')).toBeVisible();
  await call('POST', `/api/roadmaps/${id}/projects/${itemId}/archive`);
  const refetched = page.waitForResponse((r) => r.url().endsWith(`/api/roadmaps/${id}/projects`) && r.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refetched;
  await expect(projectRow(page, 'Alpha')).toHaveCount(0);
  await panelOf(page, 'Alpha').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeFocused();
});

test('a background refetch does not wipe what is typed in the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'typing');
  const id = await createRoadmap(page, 'Typing plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await panel.getByLabel('Description', { exact: true }).fill('Half written');

  await call('PATCH', `/api/roadmaps/${id}/projects/${itemId}`, { version: 1, status: 'done' });
  const refetched = page.waitForResponse((r) => r.url().includes(`/api/roadmaps/${id}/projects`) && r.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refetched;
  await expect(projectRow(page, 'Alpha')).toContainText('Done');
  await expect(panel.getByLabel('Description', { exact: true })).toHaveValue('Half written');
  await expect(panel.getByLabel('Status', { exact: true })).toHaveValue('not_started');

  // A change made elsewhere is not adopted: Save reports the conflict instead of overwriting it.
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Someone else changed this at the same time. Reload and try again.');
  const stored = await call<{ items: { id: string; status: string; description: string }[] }>('GET', `/api/roadmaps/${id}/projects`);
  expect(stored.items.find((i) => i.id === itemId)).toMatchObject({ status: 'done', description: '' });
});

test('changing status from the row while the panel has unsaved edits keeps the edits, and Save succeeds', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'both');
  const id = await createRoadmap(page, 'Both plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await panel.getByLabel('Title', { exact: true }).fill('Alpha, renamed');

  await page.getByRole('button', { name: /^Status of Alpha/ }).click();
  await page.getByRole('menuitemradio', { name: 'In progress' }).click();
  await expect(projectRow(page, 'Alpha')).toContainText('In progress');
  await expect(panel.getByLabel('Status', { exact: true })).toHaveValue('in_progress');
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('Alpha, renamed');

  // A second change from the pill uses the newest version too.
  await page.getByRole('button', { name: /^Status of Alpha/ }).click();
  await page.getByRole('menuitemradio', { name: 'Blocked' }).click();
  await expect(projectRow(page, 'Alpha')).toContainText('Blocked');
  await expect(panel.getByLabel('Status', { exact: true })).toHaveValue('blocked');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Alpha, renamed').getByRole('status')).toHaveText('Saved.');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.reload();
  const again = panelOf(page, 'Alpha, renamed');
  await expect(again.getByLabel('Title', { exact: true })).toHaveValue('Alpha, renamed');
  await expect(again.getByLabel('Status', { exact: true })).toHaveValue('blocked');
});

test('unsaved edits are not thrown away silently: Escape, Close, Back to projects and another row ask first', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'guard');
  const id = await createRoadmap(page, 'Guard plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await seedProject(call, id, 'Beta');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  const description = panel.getByLabel('Description', { exact: true });
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved changes to Alpha?' });

  // A clean form closes at once.
  await panel.focus();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(dialog).toHaveCount(0);

  await openProject(page, 'Alpha');
  await description.fill('Draft');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expectNoA11yViolations(page);
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(projectUrl(id, itemId));
  await expect(description).toHaveValue('Draft');
  await expect(description).toBeFocused();

  // The same question from Close, from another row, and from the row menu's Open.
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('link', { name: 'Beta', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(projectUrl(id, itemId));
  await page.getByRole('button', { name: 'Actions for Beta' }).click();
  await page.getByRole('menuitem', { name: 'Open' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(description).toHaveValue('Draft');

  // Discard goes where the person was going.
  await page.getByRole('link', { name: 'Beta', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(panelOf(page, 'Beta')).toBeVisible();
  await expect(panelOf(page, 'Beta').getByLabel('Description', { exact: true })).toHaveValue('');

  // Discard on Escape closes the panel and returns focus to the row.
  await panelOf(page, 'Beta').getByLabel('Description', { exact: true }).fill('More');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Discard your unsaved changes to Beta?' }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('link', { name: 'Beta', exact: true })).toBeFocused();

  // A saved form is clean again.
  await openProject(page, 'Alpha');
  await panelOf(page, 'Alpha').getByLabel('Description', { exact: true }).fill('Kept');
  await panelOf(page, 'Alpha').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Alpha').getByRole('status')).toHaveText('Saved.');
  await panelOf(page, 'Alpha').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
});

test('Back to projects asks before discarding unsaved edits at 375 px', async ({ page }) => {
  await createSignedInUser(page, 'guard2');
  const id = await createRoadmap(page, 'Guard small');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(projectUrl(id, itemId));
  await panelOf(page, 'Alpha').getByLabel('Description', { exact: true }).fill('Draft');
  await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved changes to Alpha?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(projectUrl(id, itemId));
  await page.getByRole('link', { name: 'Back to projects', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeFocused();
});

test('New project is the primary button until an editable panel opens, then Save is', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'primary');
  const id = await createRoadmap(page, 'Primary plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(`/r/${id}/projects`);
  const add = page.getByRole('button', { name: 'New project' });
  await expect(add).toHaveClass(/btn-primary/);

  await openProject(page, 'Alpha');
  await expect(add).toHaveClass(/btn-secondary/);
  await expect(panelOf(page, 'Alpha').getByRole('button', { name: 'Save', exact: true })).toHaveClass(/btn-primary/);

  await page.keyboard.press('Escape');
  await expect(add).toHaveClass(/btn-primary/);
  expect(itemId).toBeTruthy();
});

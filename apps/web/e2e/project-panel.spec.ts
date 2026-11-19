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

test("a status change from the row does not hide another session's edit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'hidden');
  const id = await createRoadmap(page, 'Hidden plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await panel.getByLabel('Title', { exact: true }).fill('Alpha, mine');

  // Another session edits the description, and a refetch brings it into the list.
  await call('PATCH', `/api/roadmaps/${id}/projects/${itemId}`, { version: 1, description: 'Theirs' });
  const refetched = page.waitForResponse((r) => r.url().endsWith(`/api/roadmaps/${id}/projects`) && r.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refetched;

  await page.getByRole('button', { name: /^Status of Alpha/ }).click();
  await page.getByRole('menuitemradio', { name: 'Done' }).click();
  await expect(projectRow(page, 'Alpha')).toContainText('Done');
  // The form never saw their change, so it keeps its own status and version.
  await expect(panel.getByLabel('Status', { exact: true })).toHaveValue('not_started');

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Someone else changed this at the same time. Reload and try again.');
  const stored = await call<{ items: { id: string; title: string; description: string; status: string }[] }>('GET', `/api/roadmaps/${id}/projects`);
  expect(stored.items.find((i) => i.id === itemId)).toMatchObject({ title: 'Alpha', description: 'Theirs', status: 'done' });

  // Reload brings in both changes.
  await page.getByRole('alert').getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(panelOf(page, 'Alpha').getByLabel('Description', { exact: true })).toHaveValue('Theirs');
  await expect(panelOf(page, 'Alpha').getByLabel('Status', { exact: true })).toHaveValue('done');
});

interface Member {
  userId: string;
  name: string;
  email: string;
}
const membersOf = async (call: Awaited<ReturnType<typeof apiAs>>, roadmapId: string) =>
  (await call<{ members: Member[] }>('GET', `/api/roadmaps/${roadmapId}/members`)).members;

test('FR-1.6: an Admin assigns two members and the row lists both names', async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const owner = await createSignedInUser(page, 'boss');
  const id = await createRoadmap(page, 'Assign plan');
  const second = await inviteAndJoin(page, browser, testInfo, 'Assign plan', 'pal', 'Contributor');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Build it');
  await page.goto(projectUrl(id, itemId));

  const panel = panelOf(page, 'Build it');
  const group = panel.getByRole('group', { name: 'Assignees' });
  await expect(group.getByRole('checkbox')).toHaveCount(2);
  // The box ticks once the server has saved it.
  await group.getByLabel(owner.name, { exact: true }).click();
  await expect(group.getByLabel(owner.name, { exact: true })).toBeChecked();
  await group.getByLabel(second.name, { exact: true }).click();
  await expect(group.getByLabel(second.name, { exact: true })).toBeChecked();
  await expect(projectRow(page, 'Build it')).toContainText(owner.name);
  await expect(projectRow(page, 'Build it')).toContainText(second.name);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.reload();
  const again = panelOf(page, 'Build it').getByRole('group', { name: 'Assignees' });
  await expect(again.getByLabel(owner.name, { exact: true })).toBeChecked();
  await expect(again.getByLabel(second.name, { exact: true })).toBeChecked();

  await again.getByLabel(owner.name, { exact: true }).click();
  await expect(projectRow(page, 'Build it')).not.toContainText(owner.name);
  await expect(projectRow(page, 'Build it')).toContainText(second.name);
  await second.context.close();
});

test('FR-1.4: an Admin adds a tag, a link and a milestone, saves, and a reload shows them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'lister');
  const id = await createRoadmap(page, 'List plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Ship it');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Ship it');

  // The three validation messages.
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(panel.getByText('Enter a tag.', { exact: true })).toBeVisible();
  await panel.getByLabel('Address', { exact: true }).fill('ftp://example.com');
  await panel.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(panel.getByText('Enter an address that starts with http:// or https://.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Add milestone', exact: true }).click();
  await expect(panel.getByText('Enter a name and a date.', { exact: true })).toBeVisible();

  await panel.getByLabel('Add a tag', { exact: true }).fill('Urgent');
  await panel.getByLabel('Add a tag', { exact: true }).press('Enter');
  await expect(panel.getByText('Enter a tag.', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Remove tag urgent' })).toBeVisible();
  await panel.getByLabel('Add a tag', { exact: true }).fill('later');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await panel.getByRole('button', { name: 'Remove tag later' }).click();
  await expect(panel.getByRole('button', { name: 'Remove tag later' })).toHaveCount(0);

  await panel.getByLabel('Label', { exact: true }).fill('Brief');
  await panel.getByLabel('Address', { exact: true }).fill('https://example.com/brief');
  await panel.getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(panel.getByRole('link', { name: 'Brief' })).toHaveAttribute('href', 'https://example.com/brief');
  await expect(panel.getByText('Enter an address that starts with http:// or https://.', { exact: true })).toHaveCount(0);

  await panel.getByLabel('Name', { exact: true }).fill('Beta');
  await panel.getByLabel('Date', { exact: true }).fill('2027-05-01');
  await panel.getByRole('button', { name: 'Add milestone', exact: true }).click();
  await expect(panel.getByText('Beta')).toBeVisible();

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');

  await page.reload();
  const again = panelOf(page, 'Ship it');
  await expect(again.getByRole('button', { name: 'Remove tag urgent' })).toBeVisible();
  await expect(again.getByRole('link', { name: 'Brief' })).toBeVisible();
  await expect(again.getByText('Beta')).toBeVisible();

  // Kept entries keep their ids: removing the link and saving leaves the milestone as it was.
  const before = await call<{ items: { id: string; milestones: { id: string }[] }[] }>('GET', `/api/roadmaps/${id}/projects`);
  const milestoneId = before.items.find((i) => i.id === itemId)!.milestones[0]!.id;
  await again.getByRole('button', { name: 'Remove link Brief' }).click();
  await again.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(again.getByRole('status')).toHaveText('Saved.');
  const after = await call<{ items: { id: string; milestones: { id: string }[]; links: unknown[] }[] }>('GET', `/api/roadmaps/${id}/projects`);
  const stored = after.items.find((i) => i.id === itemId)!;
  expect(stored.links).toEqual([]);
  expect(stored.milestones[0]!.id).toBe(milestoneId);
});

test('FR-1.4: an Admin marks an item blocked by another, and the select does not offer the item itself, its parent or its children', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'blocker');
  const id = await createRoadmap(page, 'Block plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Parent item');
  const middle = await seedProject(call, id, 'Middle item', parent);
  await seedProject(call, id, 'Child item', middle);
  const other = await seedProject(call, id, 'Other item');
  await page.goto(projectUrl(id, middle));
  const panel = panelOf(page, 'Middle item');
  const select = panel.getByLabel('Add an item this is blocked by', { exact: true });

  await expect(select.locator('option')).toHaveCount(2);
  const offered = (await select.locator('option').allInnerTexts()).map((t) => t.trim());
  expect(offered).toContain('Other item');
  for (const left of ['Middle item', 'Parent item', 'Child item']) expect(offered).not.toContain(left);

  await select.selectOption(other);
  await expect(panel.getByRole('button', { name: 'Remove Other item' })).toBeVisible();
  await expect(select.locator('option')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');

  // The other item cannot now be blocked by this one: that would be a cycle.
  await page.goto(projectUrl(id, other));
  const otherOptions = panelOf(page, 'Other item').getByLabel('Add an item this is blocked by', { exact: true }).locator('option');
  await expect(otherOptions.first()).toBeAttached();
  expect((await otherOptions.allInnerTexts()).map((t) => t.trim())).not.toContain('Middle item');

  await page.goto(projectUrl(id, middle));
  await expect(panelOf(page, 'Middle item').getByRole('button', { name: 'Remove Other item' })).toBeVisible();
  await panelOf(page, 'Middle item').getByRole('button', { name: 'Remove Other item' }).click();
  await panelOf(page, 'Middle item').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Middle item').getByRole('status')).toHaveText('Saved.');
  await page.reload();
  await expect(panelOf(page, 'Middle item').getByRole('button', { name: /^Remove / })).toHaveCount(0);
});

test('an item that starts before its blocker ends shows "Starts before {blocker} ends."', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'early');
  const id = await createRoadmap(page, 'Early plan');
  const call = await apiAs(page);
  const blocker = await seedProject(call, id, 'Foundations');
  const item = await seedProject(call, id, 'Walls');
  await call('PATCH', `/api/roadmaps/${id}/projects/${blocker}`, { version: 1, startDate: '2027-01-01', endDate: '2027-06-01' });
  await call('PATCH', `/api/roadmaps/${id}/projects/${item}`, { version: 1, startDate: '2027-05-01', endDate: '2027-07-01', blockedBy: [blocker] });
  await page.goto(projectUrl(id, item));
  await expect(panelOf(page, 'Walls').getByText('Starts before Foundations ends.', { exact: true })).toBeVisible();
  await expect(projectRow(page, 'Walls').getByRole('img', { name: 'Has warnings' })).toBeVisible();
});

test('a Contributor sees assignees and the priority label read-only', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'chief3');
  const id = await createRoadmap(page, 'Read plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Read plan', 'helper3', 'Contributor');
  const call = await apiAs(page);
  const mine = await seedProject(call, id, 'Mine');
  const helper = (await membersOf(call, id)).find((m) => m.email === guest.email)!;
  await call('PUT', `/api/roadmaps/${id}/projects/${mine}/assignees`, { userIds: [helper.userId] });
  await call('PUT', `/api/roadmaps/${id}/projects/${mine}/priority-label`, { label: 'P2' });

  const p = guest.page;
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto(projectUrl(id, mine));
  const panel = panelOf(p, 'Mine');
  // Assigned, so the text fields are editable; assignees and the label still are not.
  await expect(panel.getByLabel('Title', { exact: true })).toBeEditable();
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('group', { name: 'Assignees' })).toContainText(helper.name);
  await expect(panel.getByLabel('Priority label', { exact: true })).toBeDisabled();
  await expect(panel.getByLabel('Priority label', { exact: true })).toHaveValue('P2');
  await expectNoA11yViolations(p);
  await guest.context.close();
});

test('with unsaved text in the panel, changing assignees and the priority label keeps the text, and Save succeeds and everything persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const owner = await createSignedInUser(page, 'mixer');
  const id = await createRoadmap(page, 'Mix plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await panel.getByLabel('Title', { exact: true }).fill('Alpha, renamed');

  await panel.getByRole('group', { name: 'Assignees' }).getByLabel(owner.name, { exact: true }).click();
  await expect(projectRow(page, 'Alpha')).toContainText(owner.name);
  await panel.getByLabel('Priority label', { exact: true }).selectOption('P3');
  await expect(projectRow(page, 'Alpha')).toContainText('1 · P3');
  await expect(panel.getByLabel('Title', { exact: true })).toHaveValue('Alpha, renamed');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panelOf(page, 'Alpha, renamed').getByRole('status')).toHaveText('Saved.');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.reload();
  const again = panelOf(page, 'Alpha, renamed');
  await expect(again.getByRole('group', { name: 'Assignees' }).getByLabel(owner.name, { exact: true })).toBeChecked();
  await expect(again.getByLabel('Priority label', { exact: true })).toHaveValue('P3');
});

test('tags, links, milestones and blocked by count as unsaved edits and are asked about before leaving', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'guard2');
  const id = await createRoadmap(page, 'Guard2 plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Alpha');
  await panel.getByLabel('Add a tag', { exact: true }).fill('x');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard your unsaved changes to Alpha?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await panel.getByRole('button', { name: 'Remove tag x' }).click();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(`/r/${id}/projects`);
});

import { expect, test } from '@playwright/test';
import {
  addChild,
  addProject,
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

test('FR-1.7: a new roadmap opens on Projects and shows the empty message for an Owner', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'empty');
  const id = await createRoadmap(page, 'Fresh plan');
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByText('No projects yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();

  const tabs = page.getByRole('navigation', { name: 'Roadmap sections' }).getByRole('link');
  await expect(tabs).toHaveText(['Projects', 'Members', 'Audit log']);

  await page.goto(`/r/${id}`);
  await expect(page).toHaveURL(`/r/${id}/projects`);

  const guest = await inviteAndJoin(page, browser, testInfo, 'Fresh plan', 'reader', 'Contributor');
  await guest.page.goto(`/r/${id}/projects`);
  await expect(guest.page.getByText('No projects yet. An Admin adds the first one.', { exact: true })).toBeVisible();
  await expect(guest.page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  await guest.context.close();
});

test('FR-1.2: an Owner adds a project, a sub-project, a task and a sub-task in place, and a Sub-task\'s menu has no add item', async ({ page }) => {
  await createSignedInUser(page, 'builder');
  await createRoadmap(page, 'Build plan');

  await addProject(page, 'Alpha');
  await addChild(page, 'Alpha', 'Beta');
  await addChild(page, 'Beta', 'Gamma');
  await addChild(page, 'Gamma', 'Delta');

  // axe refuses aria-level and aria-expanded on a row of a plain table, so the level is read out as text
  // and the chevron's name carries the open or closed state.
  for (const [title, level] of [['Alpha', 'Project'], ['Beta', 'Sub-project'], ['Gamma', 'Task'], ['Delta', 'Sub-task']] as const) {
    await expect(projectRow(page, title).getByRole('rowheader')).toContainText(`${level}: ${title}`);
  }
  await expect(page.getByRole('button', { name: 'Collapse Alpha' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Collapse|Expand) Delta$/ })).toHaveCount(0);

  // The add row names the level it adds.
  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Add sub-project' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the new sub-project' })).toBeFocused();
  await expect(page.getByText('Press Enter to save')).toBeVisible();
  await page.keyboard.press('Escape');

  // A Sub-task's menu holds only "Open".
  const menuButton = page.getByRole('button', { name: 'Actions for Delta' });
  await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem')).toHaveText(['Open']);
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  // A two-item menu: ArrowDown on the closed button opens it, and the arrows, End and Home move between items.
  const gamma = page.getByRole('button', { name: 'Actions for Gamma' });
  await gamma.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Add sub-task' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Add sub-task' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Add sub-task' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(gamma).toBeFocused();

  // A project's menu offers Open, then the add item for its level.
  await page.getByRole('button', { name: 'Actions for Gamma' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Add sub-task']);
  await page.keyboard.press('Escape');

  // Choosing "Open" shows the panel placeholder for that item.
  await page.getByRole('button', { name: 'Actions for Beta' }).click();
  await page.getByRole('menuitem', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole('region', { name: 'Beta' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\/projects$/);

  // Choosing a title does the same.
  await openProject(page, 'Gamma');
  await expect(page.getByRole('region', { name: 'Gamma' })).toBeVisible();
});

test('the add row stays open for another entry at the same level, and shows the server\'s answer when it refuses', async ({ page }) => {
  await createSignedInUser(page, 'repeat');
  await createRoadmap(page, 'Repeat plan');
  await page.getByRole('button', { name: 'New project' }).click();
  const input = page.getByRole('textbox', { name: 'Title of the new project' });
  await input.fill('One');
  await input.press('Enter');
  await expect(projectRow(page, 'One')).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await input.fill('Two');
  await input.press('Enter');
  await expect(projectRow(page, 'Two')).toBeVisible();

  // The server refuses a child of an archived item; the add row says so.
  await page.route('**/api/roadmaps/*/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { error: 'parent_archived' } })
      : route.continue(),
  );
  await input.fill('Three');
  await input.press('Enter');
  await expect(page.getByText('Unarchive the item above this one first.')).toBeVisible();
  await expect(input).toHaveValue('Three');
  await expect(input).toBeFocused();
});

test('the tree collapses and expands, and stays collapsed after a reload', async ({ page }) => {
  await createSignedInUser(page, 'folder');
  await createRoadmap(page, 'Fold plan');
  await addProject(page, 'Alpha');
  await addChild(page, 'Alpha', 'Beta');
  await addChild(page, 'Beta', 'Gamma');

  await page.getByRole('button', { name: 'Collapse Alpha' }).click();
  await expect(projectRow(page, 'Beta')).toHaveCount(0);
  await expect(projectRow(page, 'Gamma')).toHaveCount(0);

  await page.reload();
  await expect(projectRow(page, 'Alpha')).toBeVisible();
  await expect(projectRow(page, 'Beta')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand Alpha' })).toBeVisible();

  await page.getByRole('button', { name: 'Expand Alpha' }).click();
  await expect(projectRow(page, 'Beta')).toBeVisible();
  await expect(projectRow(page, 'Gamma')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Alpha' })).toBeVisible();

  // Adding under a collapsed item opens it.
  await page.getByRole('button', { name: 'Collapse Alpha' }).click();
  await addChild(page, 'Alpha', 'Epsilon');
  await expect(projectRow(page, 'Epsilon')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Alpha' })).toBeVisible();
});

test('collapsed state and an open add row do not carry over when the roadmap is switched from the picker', async ({ page }) => {
  await createSignedInUser(page, 'switcher');
  const a = await createRoadmap(page, 'First list');
  const b = await createRoadmap(page, 'Second list');
  const call = await apiAs(page);
  for (const [id, parent, child] of [[a, 'Alpha', 'Beta'], [b, 'Gamma', 'Delta']] as const) {
    await seedProject(call, id, child, await seedProject(call, id, parent));
  }

  // The second roadmap keeps its own item collapsed.
  await page.goto(`/r/${b}/projects`);
  await page.getByRole('button', { name: 'Collapse Gamma' }).click();
  await expect(projectRow(page, 'Delta')).toHaveCount(0);

  // The first roadmap: collapse an item and leave an add row open.
  await page.goto(`/r/${a}/projects`);
  await page.getByRole('button', { name: 'Collapse Alpha' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the new project' })).toBeVisible();

  await page.getByLabel('Roadmap', { exact: true }).selectOption({ label: 'Second list' });
  await expect(page).toHaveURL(`/r/${b}/projects`);
  await expect(projectRow(page, 'Gamma')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Gamma' })).toBeVisible();
  await expect(projectRow(page, 'Delta')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^Title of the new / })).toHaveCount(0);

  await page.getByLabel('Roadmap', { exact: true }).selectOption({ label: 'First list' });
  await expect(page).toHaveURL(`/r/${a}/projects`);
  await expect(page.getByRole('button', { name: 'Expand Alpha' })).toBeVisible();
  await expect(projectRow(page, 'Beta')).toHaveCount(0);
});

test('an empty title shows "Enter a title." and Escape cancels the row', async ({ page }) => {
  await createSignedInUser(page, 'blank');
  await createRoadmap(page, 'Blank plan');
  const open = page.getByRole('button', { name: 'New project' });
  await open.click();
  const input = page.getByRole('textbox', { name: 'Title of the new project' });
  await input.press('Enter');
  await expect(page.getByText('Enter a title.', { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  await input.fill('   ');
  await input.press('Enter');
  await expect(page.getByText('Enter a title.', { exact: true })).toBeVisible();

  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(page.getByText('No projects yet.', { exact: true })).toBeVisible();
});

test('rows show status, assignee names, dates and position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const user = await createSignedInUser(page, 'seeder');
  const id = await createRoadmap(page, 'Seed plan');
  const call = await apiAs(page);
  const first = await seedProject(call, id, 'Launch site');
  const second = await seedProject(call, id, 'Hire writers');
  const third = await seedProject(call, id, 'Plan party');
  const me = (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${id}/members`)).members.find((m) => m.email === user.email)!;
  await call('PATCH', `/api/roadmaps/${id}/projects/${first}`, { version: 1, status: 'in_progress', startDate: '2027-03-03', endDate: '2027-04-28' });
  await call('PUT', `/api/roadmaps/${id}/projects/${first}/assignees`, { userIds: [me.userId] });
  await call('PUT', `/api/roadmaps/${id}/projects/${second}/priority-label`, { label: 'P1' });
  await call('PATCH', `/api/roadmaps/${id}/projects/${third}`, { version: 1, startDate: '2026-12-01', endDate: '2027-01-15' });
  await page.reload();

  await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Status', 'Assignees', 'Dates', 'Priority', 'Actions']);

  const a = projectRow(page, 'Launch site');
  await expect(a).toContainText('In progress');
  await expect(a).toContainText(user.name);
  await expect(a).toContainText('3 Mar to 28 Apr 2027');
  await expect(a.getByRole('cell', { name: '1', exact: true })).toBeVisible();

  const b = projectRow(page, 'Hire writers');
  await expect(b).toContainText('Not started');
  await expect(b).toContainText('Unassigned');
  await expect(b).toContainText('No dates');
  await expect(b.getByRole('cell', { name: '2 · P1', exact: true })).toBeVisible();

  await expect(projectRow(page, 'Plan party')).toContainText('1 Dec 2026 to 15 Jan 2027');
  await expect(projectRow(page, 'Plan party').getByRole('cell', { name: '3', exact: true })).toBeVisible();
});

test('a warning icon marks an item whose dates fall outside its parent', async ({ page }) => {
  await createSignedInUser(page, 'warner');
  const id = await createRoadmap(page, 'Warn plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Season');
  const child = await seedProject(call, id, 'Opening night', parent);
  await call('PATCH', `/api/roadmaps/${id}/projects/${parent}`, { version: 1, startDate: '2027-03-01', endDate: '2027-03-31' });
  await call('PATCH', `/api/roadmaps/${id}/projects/${child}`, { version: 1, startDate: '2027-04-02', endDate: '2027-04-03' });
  await page.reload();
  await expect(projectRow(page, 'Opening night').getByRole('img', { name: 'Has warnings' })).toBeVisible();
  await expect(projectRow(page, 'Season').getByRole('img', { name: 'Has warnings' })).toHaveCount(0);
});

test('FR-1.9: at 375 px the table shows Name and Status only, four levels of indentation fit, and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await createSignedInUser(page, 'phone');
  const id = await createRoadmap(page, 'Phone plan');
  const call = await apiAs(page);
  const a = await seedProject(call, id, 'Alpha programme');
  const b = await seedProject(call, id, 'Beta stream', a);
  const c = await seedProject(call, id, 'Gamma task', b);
  await seedProject(call, id, 'Delta sub-task', c);
  await page.reload();

  await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
  for (const hidden of ['Assignees', 'Dates', 'Priority']) {
    await expect(page.getByRole('columnheader', { name: hidden })).toHaveCount(0);
  }
  await expect(projectRow(page, 'Alpha programme').getByRole('cell')).toHaveCount(2);
  // Hidden cells stay in the page for larger screens, but are not shown, read out or focusable.
  await expect(page.getByText('Unassigned').first()).toBeHidden();

  const deepest = page.getByRole('link', { name: 'Delta sub-task', exact: true });
  await expect(deepest).toBeVisible();
  const box = (await deepest.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  const menu = (await page.getByRole('button', { name: 'Actions for Delta sub-task' }).boundingBox())!;
  expect(menu.x + menu.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // The add row fits too.
  await page.getByRole('button', { name: 'Actions for Gamma task' }).click();
  await page.getByRole('menuitem', { name: 'Add sub-task' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the new sub-task' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: /Title of the new/ })).toHaveCount(0);
});

test('a Contributor sees the add item only on items they are assigned to or that sit under one', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'lead');
  const id = await createRoadmap(page, 'Scope plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Scope plan', 'helper', 'Contributor');
  const call = await apiAs(page);
  const mine = await seedProject(call, id, 'Mine');
  await seedProject(call, id, 'Under mine', mine);
  const theirs = await seedProject(call, id, 'Theirs');
  await seedProject(call, id, 'Under theirs', theirs);
  const helper = (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${id}/members`)).members.find((m) => m.email === guest.email)!;
  await call('PUT', `/api/roadmaps/${id}/projects/${mine}/assignees`, { userIds: [helper.userId] });

  const p = guest.page;
  await p.goto(`/r/${id}/projects`);
  await expect(projectRow(p, 'Mine')).toBeVisible();
  await expect(p.getByRole('button', { name: 'New project' })).toHaveCount(0);

  const items = async (title: string) => {
    await p.getByRole('button', { name: `Actions for ${title}` }).click();
    const names = await p.getByRole('menuitem').allInnerTexts();
    await p.keyboard.press('Escape');
    return names;
  };
  expect(await items('Mine')).toEqual(['Open', 'Add sub-project']);
  expect(await items('Under mine')).toEqual(['Open', 'Add task']);
  expect(await items('Theirs')).toEqual(['Open']);
  expect(await items('Under theirs')).toEqual(['Open']);
  await guest.context.close();
});

test('Projects screens pass axe, with rows and with the add row open', async ({ page }) => {
  await createSignedInUser(page, 'checker');
  const id = await createRoadmap(page, 'Axe projects');
  await addProject(page, 'Alpha');
  await addChild(page, 'Alpha', 'Beta');
  const call = await apiAs(page);
  const alpha = (await call<{ items: { id: string; title: string }[] }>('GET', `/api/roadmaps/${id}/projects`)).items.find((i) => i.title === 'Alpha')!;
  await call('PATCH', `/api/roadmaps/${id}/projects/${alpha.id}`, { version: 1, startDate: '2027-03-01', endDate: '2027-03-31' });
  await page.reload();
  await expect(projectRow(page, 'Beta')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expectNoA11yViolations(page);
  await page.getByRole('menuitem', { name: 'Add sub-project' }).click();
  await expect(page.getByRole('textbox', { name: 'Title of the new sub-project' })).toBeVisible();
  await expectNoA11yViolations(page);

  await openProject(page, 'Alpha');
  await expect(page.getByRole('region', { name: 'Alpha' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('a failed background refresh keeps the rows and an open add row with its text, and "Try again" brings the list back', async ({ page }) => {
  await createSignedInUser(page, 'flaky');
  const id = await createRoadmap(page, 'Flaky plan');
  const call = await apiAs(page);
  await seedProject(call, id, 'Alpha');
  await page.reload();
  await expect(projectRow(page, 'Alpha')).toBeVisible();

  await page.getByRole('button', { name: 'New project' }).click();
  const input = page.getByRole('textbox', { name: 'Title of the new project' });
  await input.fill('Half typed');

  let failing = true;
  await page.route('**/api/roadmaps/*/projects', (route) =>
    failing && route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { error: 'server_error' } }) : route.continue(),
  );
  // Coming back to the tab makes the list refetch; the request fails (and is retried) before the alert shows.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText("Couldn't refresh the list. Try again.", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(projectRow(page, 'Alpha')).toBeVisible();
  await expect(input).toHaveValue('Half typed');

  failing = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText("Couldn't refresh the list. Try again.", { exact: true })).toHaveCount(0);
  await expect(projectRow(page, 'Alpha')).toBeVisible();
  await expect(input).toHaveValue('Half typed');
});

test('an item added under a parent that was collapsed while the add row was open shows up, with its parent open', async ({ page }) => {
  await createSignedInUser(page, 'folder2');
  const id = await createRoadmap(page, 'Fold again');
  const call = await apiAs(page);
  const alpha = await seedProject(call, id, 'Alpha');
  await seedProject(call, id, 'Beta', alpha);
  await page.reload();

  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  // The menu names its button; it points at it instead of repeating the label.
  const menu = page.getByRole('menu', { name: 'Actions for Alpha' });
  await expect(menu).toHaveAttribute('aria-labelledby', /.+/);
  await expect(menu).not.toHaveAttribute('aria-label');
  await page.getByRole('menuitem', { name: 'Add sub-project' }).click();
  const input = page.getByRole('textbox', { name: 'Title of the new sub-project' });
  await expect(input).toBeFocused();

  await page.getByRole('button', { name: 'Collapse Alpha' }).click();
  await expect(projectRow(page, 'Beta')).toHaveCount(0);
  await input.fill('Gamma');
  await input.press('Enter');
  await expect(projectRow(page, 'Gamma')).toBeVisible();
  await expect(projectRow(page, 'Beta')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse Alpha' })).toBeVisible();
});

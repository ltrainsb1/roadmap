import { expect, test, type Page } from '@playwright/test';
import {
  apiAs,
  createRoadmap,
  createSignedInUser,
  expectNoA11yViolations,
  inviteAndJoin,
  projectRow,
  seedProject,
  useCspGuard,
} from './helpers.ts';

useCspGuard();

type Call = Awaited<ReturnType<typeof apiAs>>;
interface Row {
  id: string;
  title: string;
  parentId: string | null;
  archived: boolean;
}
const list = async (call: Call, roadmapId: string) => (await call<{ items: Row[] }>('GET', `/api/roadmaps/${roadmapId}/projects`)).items;
const titles = (page: Page) => page.locator('.item-title').allInnerTexts();

/** An Owner with a roadmap that holds "One", "Two" and "Three" at the top level. */
async function threeProjects(page: Page, label: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, label);
  const id = await createRoadmap(page, `${label} plan`);
  const call = await apiAs(page);
  const ids = [await seedProject(call, id, 'One'), await seedProject(call, id, 'Two'), await seedProject(call, id, 'Three')];
  await page.reload();
  await expect(projectRow(page, 'Three')).toBeVisible();
  return { id, call, ids };
}

test('FR-1.3: an Admin moves a sub-project up with the row menu, and the order survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'mover');
  const id = await createRoadmap(page, 'Move plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Season');
  await seedProject(call, id, 'Opening', parent);
  await seedProject(call, id, 'Closing', parent);
  await page.reload();
  await expect(projectRow(page, 'Closing')).toBeVisible();

  // The ends of a group cannot move further.
  await page.getByRole('button', { name: 'Actions for Opening' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Actions for Closing' }).click();
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing', 'Opening']);
  await expect(projectRow(page, 'Closing').getByRole('cell', { name: '1', exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['Season', 'Closing', 'Opening']);
});

test('FR-1.3: an Admin reorders with the keyboard on the drag handle', async ({ page }) => {
  await threeProjects(page, 'keys');
  const handle = page.getByRole('button', { name: 'Reorder One' });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('Picked up One.', { exact: true })).toBeAttached();
  // dnd-kit starts listening for the arrow keys a moment after the pick-up.
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByText('Moved One to position 2 of 3.', { exact: true })).toBeAttached();
  await expectNoA11yViolations(page);
  await page.keyboard.press('Space');
  await expect(page.getByText('Dropped One at position 2 of 3.', { exact: true })).toBeAttached();

  await expect.poll(() => titles(page)).toEqual(['Two', 'One', 'Three']);
  await expect(page.getByRole('button', { name: 'Reorder One' })).toBeFocused();
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['Two', 'One', 'Three']);

  // Escape puts the row back.
  await page.getByRole('button', { name: 'Reorder Two' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Reordering cancelled.', { exact: true })).toBeAttached();
  expect(await titles(page)).toEqual(['Two', 'One', 'Three']);
});

test('FR-1.3: an Admin drags a row with the mouse', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a mouse drag; touch is covered by the sensor settings');
  await threeProjects(page, 'dragger');
  const from = (await page.getByRole('button', { name: 'Reorder One' }).boundingBox())!;
  const to = (await projectRow(page, 'Three').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 10, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => titles(page)).toEqual(['Two', 'Three', 'One']);
  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['Two', 'Three', 'One']);
});

test('Review focus 5: when a sibling was added in another session, the reorder shows "The list changed while you were reordering. Try again." and the list refreshes', async ({ page }) => {
  const { id, call } = await threeProjects(page, 'stale');
  await seedProject(call, id, 'Four');
  await page.getByRole('button', { name: 'Actions for One' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await expect(page.getByRole('alert')).toHaveText('The list changed while you were reordering. Try again.');
  await expect(projectRow(page, 'Four')).toBeVisible();
  expect(await titles(page)).toEqual(['One', 'Two', 'Three', 'Four']);
});

test('a Contributor sees no drag handles and no Move items', async ({ page, browser }, testInfo) => {
  await createSignedInUser(page, 'owner4');
  const id = await createRoadmap(page, 'Handles plan');
  const guest = await inviteAndJoin(page, browser, testInfo, 'Handles plan', 'helper4', 'Contributor');
  const call = await apiAs(page);
  const mine = await seedProject(call, id, 'Mine');
  await seedProject(call, id, 'Under mine', mine);
  await seedProject(call, id, 'Theirs');
  const helper = (await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${id}/members`)).members.find((m) => m.email === guest.email)!;
  await call('PUT', `/api/roadmaps/${id}/projects/${mine}/assignees`, { userIds: [helper.userId] });

  const p = guest.page;
  await p.goto(`/r/${id}/projects`);
  await expect(projectRow(p, 'Under mine')).toBeVisible();
  await expect(p.getByRole('button', { name: /^Reorder / })).toHaveCount(0);
  await p.getByRole('button', { name: 'Actions for Under mine' }).click();
  await expect(p.getByRole('menuitem')).toHaveText(['Open', 'Add task', 'Archive', 'Delete']);
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'Actions for Theirs' }).click();
  await expect(p.getByRole('menuitem')).toHaveText(['Open']);
  await guest.context.close();
});

test('an Admin sets the priority label to P1 and the row shows "1 · P1"', async ({ page }) => {
  const { id, ids } = await threeProjects(page, 'labeller');
  await page.goto(`/r/${id}/projects/${ids[0]}`);
  const panel = page.getByRole('region', { name: 'One', exact: true });
  await expect(panel.getByLabel('Priority label', { exact: true }).locator('option')).toHaveText(['None', 'P1', 'P2', 'P3', 'P4']);
  await panel.getByLabel('Priority label', { exact: true }).selectOption({ label: 'P1' });
  await expect(projectRow(page, 'One').getByRole('cell', { name: '1 · P1', exact: true })).toBeVisible();
  await panel.getByLabel('Priority label', { exact: true }).selectOption({ label: 'None' });
  await expect(projectRow(page, 'One').getByRole('cell', { name: '1', exact: true })).toBeVisible();
});

test('archiving shows "Archived {title}." and removes the item and its children from the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'archiver');
  const id = await createRoadmap(page, 'Archive plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Old season');
  await seedProject(call, id, 'Old opening', parent);
  await seedProject(call, id, 'Old closing', parent);
  await seedProject(call, id, 'Keeper');
  await page.goto(`/r/${id}/projects/${parent}`);
  await expect(projectRow(page, 'Old closing')).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Old season' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived Old season.' })).toHaveText('Archived Old season.');
  await expect(projectRow(page, 'Old season')).toHaveCount(0);
  await expect(projectRow(page, 'Old opening')).toHaveCount(0);
  await expect(projectRow(page, 'Keeper')).toBeVisible();
  // The open panel closed with it.
  await expect(page).toHaveURL(`/r/${id}/projects`);
  await expect(page.getByRole('region')).toHaveCount(0);

  const stored = await list(call, id);
  expect(stored.filter((i) => i.title.startsWith('Old')).map((i) => i.archived)).toEqual([true, true, true]);
  expect(stored.find((i) => i.title === 'Keeper')!.archived).toBe(false);
});

test('Review focus 2: deleting an item with two children names the count in the dialog, and Cancel keeps it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'deleter');
  const id = await createRoadmap(page, 'Delete plan');
  const call = await apiAs(page);
  const parent = await seedProject(call, id, 'Doomed');
  await seedProject(call, id, 'Child a', parent);
  await seedProject(call, id, 'Child b', parent);
  const lone = await seedProject(call, id, 'Lonely');
  await page.reload();
  await expect(projectRow(page, 'Child b')).toBeVisible();

  await page.getByRole('button', { name: 'Actions for Doomed' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Doomed?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This also deletes the 2 items under it. This can't be undone.");
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toHaveClass(/btn-danger/);
  await expectNoA11yViolations(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(projectRow(page, 'Doomed')).toBeVisible();
  expect((await list(call, id)).length).toBe(4);

  // With nothing under it the sentence is shorter.
  await page.getByRole('button', { name: 'Actions for Lonely' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete Lonely?' })).toContainText("This can't be undone.");
  await expect(page.getByRole('dialog', { name: 'Delete Lonely?' })).not.toContainText('also deletes');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Actions for Doomed' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete Doomed?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(projectRow(page, 'Doomed')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeFocused();
  expect((await list(call, id)).map((i) => i.id)).toEqual([lone]);
});

test('archive and delete of the open item ask before discarding unsaved edits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'careful');
  const id = await createRoadmap(page, 'Careful plan');
  const call = await apiAs(page);
  const itemId = await seedProject(call, id, 'Alpha');
  await page.goto(`/r/${id}/projects/${itemId}`);
  await page.getByRole('region', { name: 'Alpha', exact: true }).getByLabel('Title', { exact: true }).fill('Alpha, edited');
  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByRole('dialog', { name: 'Discard your unsaved changes to Alpha?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  expect((await list(call, id))[0]!.archived).toBe(false);
  await page.getByRole('button', { name: 'Actions for Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete Alpha?' })).toBeVisible();
});

test('FR-1.3: a sub-project moves only among its own siblings, and a dragged project carries its children with it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createSignedInUser(page, 'nest');
  const id = await createRoadmap(page, 'Nest plan');
  const call = await apiAs(page);
  const season = await seedProject(call, id, 'Season');
  await seedProject(call, id, 'Opening', season);
  await seedProject(call, id, 'Closing', season);
  await seedProject(call, id, 'Other');
  await page.reload();
  await expect(projectRow(page, 'Other')).toBeVisible();

  // Down from the last sub-project stays inside Season: Other is not a place it can land.
  await page.getByRole('button', { name: 'Reorder Closing' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  expect(await titles(page)).toEqual(['Season', 'Opening', 'Closing', 'Other']);
  expect((await list(call, id)).filter((i) => i.parentId === season).length).toBe(2);

  // Season goes below Other with Opening and Closing following it.
  await page.getByRole('button', { name: 'Reorder Season' }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await expect(projectRow(page, 'Opening')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByText('Moved Season to position 2 of 2.', { exact: true })).toBeAttached();
  await page.keyboard.press('Space');
  await expect.poll(() => titles(page)).toEqual(['Other', 'Season', 'Opening', 'Closing']);
});

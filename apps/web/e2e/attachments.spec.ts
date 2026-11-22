import { readFile } from 'node:fs/promises';
import type { Download, Locator, Page } from '@playwright/test';
import { expectNoA11yViolations, field, seedFile, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test, type ApiCall } from './fixtures.ts';

useCspGuard();

const projectUrl = (roadmapId: string, projectId: string) => `/r/${roadmapId}/projects/${projectId}`;
const filesBase = (roadmapId: string, projectId: string) => `/api/roadmaps/${roadmapId}/projects/${projectId}/attachments`;
const panelOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const filesOf = (page: Page, title: string) => panelOf(page, title).getByRole('region', { name: 'Files', exact: true });
const rowOf = (files: Locator, name: string) =>
  files.getByRole('listitem').filter({ has: files.page().getByRole('button', { name: `Download ${name}`, exact: true }) });
const addButton = (files: Locator) => files.getByRole('button', { name: 'Add file', exact: true });

// The standard antivirus test file, built from two halves so this source never holds it whole.
const VIRUS_TEST = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const ARCHIVED = "This item is archived, so notes and files can't be added or changed.";

/** Chooses files through "Add file" and the browser's file chooser. */
async function addFiles(page: Page, files: Locator, chosen: Array<{ name: string; body: string | Buffer }>) {
  const chooser = page.waitForEvent('filechooser');
  await addButton(files).click();
  await (await chooser).setFiles(chosen.map(({ name, body }) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(body) })));
}

/** Chooses "Download {name}" and waits for the browser to save the file. */
async function downloadFrom(page: Page, files: Locator, name: string): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download'), files.getByRole('button', { name: `Download ${name}`, exact: true }).click()]);
  return download;
}

async function bytesOf(download: Download): Promise<string> {
  return (await readFile(await download.path())).toString('utf8');
}

async function linkFor(call: ApiCall, roadmapId: string, projectId: string, fileId: string): Promise<string> {
  return (await call<{ url: string }>('GET', `${filesBase(roadmapId, projectId)}/${fileId}/download`)).url;
}

test('FR-1.4: an Admin adds a small text file: "Uploading …" shows, then its row with size, name and time; it is there after a reload', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const chief = await joinByApi(browser, call, id, 'admin', 'chief');
  const p = chief.page;
  // Holds the upload until the in-progress row has been checked.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await p.route('**/api/roadmaps/*/projects/*/attachments', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  await p.goto(projectUrl(id, itemId));
  const files = filesOf(p, 'Launch site');
  await expect(files.getByText('No files yet.')).toBeVisible();
  await expect(files.getByText('Up to 25 MB each.')).toBeVisible();

  await addFiles(p, files, [{ name: 'brief.txt', body: 'Hello files' }]);
  const uploading = files.getByText('Uploading brief.txt…', { exact: true });
  await expect(uploading).toBeVisible();
  await expect(uploading.locator('xpath=..')).toHaveAttribute('aria-live', 'polite');
  await expectNoA11yViolations(p);
  release();

  const row = rowOf(files, 'brief.txt');
  await expect(row).toBeVisible();
  await expect(uploading).toHaveCount(0);
  await expect(row.locator('.file-meta')).toHaveText(/^11 B · chief user · .+/);
  await expect(row.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(row.getByRole('button', { name: 'Remove brief.txt', exact: true })).toBeVisible();
  await expectNoA11yViolations(p);

  await p.reload();
  await expect(rowOf(filesOf(p, 'Launch site'), 'brief.txt')).toBeVisible();
  await chief.context.close();
});

test('FR-1.4: "Download {name}" saves a file with the same name and bytes, and keeps unsaved edits without asking', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await seedFile(page, id, itemId, 'budget.csv', 'a,b\n1,2\n');
  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Launch site');
  const files = filesOf(page, 'Launch site');
  await panel.getByLabel('Description', { exact: true }).fill('Not saved yet');
  await panel.getByRole('textbox', { name: 'Add a note', exact: true }).fill('Half a note');

  const download = await downloadFrom(page, files, 'budget.csv');
  expect(download.suggestedFilename()).toBe('budget.csv');
  expect(await bytesOf(download)).toBe('a,b\n1,2\n');

  await expect(page).toHaveURL(projectUrl(id, itemId));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel.getByLabel('Description', { exact: true })).toHaveValue('Not saved yet');
  await expect(panel.getByRole('textbox', { name: 'Add a note', exact: true })).toHaveValue('Half a note');
});

test('FR-1.4: a Contributor not assigned to the item sees and downloads its files, with no "Add file" or "Remove"; once assigned they have both', async ({ browser, page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const writer = await joinByApi(browser, call, id, 'contributor', 'writer');
  const p = writer.page;
  const { members } = await call<{ members: { userId: string; email: string }[] }>('GET', `/api/roadmaps/${id}/members`);
  const writerId = members.find((m) => m.email === writer.user.email)!.userId;
  await seedFile(page, id, itemId, 'spec.txt', 'the spec');

  await p.goto(projectUrl(id, itemId));
  const files = filesOf(p, 'Launch site');
  await expect(rowOf(files, 'spec.txt')).toBeVisible();
  expect(await bytesOf(await downloadFrom(p, files, 'spec.txt'))).toBe('the spec');
  await expect(addButton(files)).toHaveCount(0);
  await expect(files.getByRole('button', { name: 'Remove spec.txt', exact: true })).toHaveCount(0);

  await call('PUT', `/api/roadmaps/${id}/projects/${itemId}/assignees`, { userIds: [writerId] });
  await p.reload();
  await expect(addButton(filesOf(p, 'Launch site'))).toBeVisible();
  await expect(filesOf(p, 'Launch site').getByRole('button', { name: 'Remove spec.txt', exact: true })).toBeVisible();
  await writer.context.close();
});

test('FR-1.4: a file with the virus test string is blocked with its message and no row; the audit log records the attempt', async ({ page, call, owner, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Launch site');
  await expect(files.getByText('No files yet.')).toBeVisible();

  await addFiles(page, files, [{ name: 'trap.com', body: VIRUS_TEST }]);
  await expect(files.getByRole('alert')).toHaveText('trap.com was blocked because it failed the virus check.');
  await expect(files.getByText('No files yet.')).toBeVisible();
  await expect(files.getByRole('listitem')).toHaveCount(0);

  await page.goto(`/r/${id}/audit`);
  const log = page.getByRole('list', { name: 'Events' });
  await expect(log.getByRole('listitem').filter({ hasText: `${owner.name} tried to add a file that failed the virus check.` })).toHaveCount(1);
});

test('FR-1.4: when the scanner is down the file is refused with "Files can\'t be checked right now."', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Launch site');
  await addFiles(page, files, [{ name: 'later.txt', body: 'please SCANNER-DOWN now' }]);
  await expect(files.getByRole('alert')).toHaveText("Files can't be checked right now. Try again in a few minutes.");
  await expect(files.getByText('No files yet.')).toBeVisible();
});

test('FR-1.4: a file of 25 MB and 1 byte shows the size message and is never sent', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/attachments')) posts.push(r.url());
  });
  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Launch site');
  await addFiles(page, files, [{ name: 'huge.bin', body: Buffer.alloc(25 * 1024 * 1024 + 1) }]);
  await expect(files.getByRole('alert')).toHaveText('huge.bin is larger than 25 MB.');
  await expect(files.getByText('No files yet.')).toBeVisible();
  expect(posts).toEqual([]);
});

test('FR-1.4: "Remove", then "Remove file": the row goes, focus moves on, and the file\'s download link stops working', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const first = await seedFile(page, id, itemId, 'one.txt', 'first');
  await seedFile(page, id, itemId, 'two.txt', 'second');
  const link = await linkFor(call, id, itemId, first);
  expect((await page.request.get(link)).status()).toBe(200);

  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Launch site');
  await files.getByRole('button', { name: 'Remove one.txt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove one.txt?' });
  await expect(dialog).toContainText('The file is deleted for everyone.');
  await expectNoA11yViolations(page);
  // Escape answers the question, not the panel.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(projectUrl(id, itemId));

  await files.getByRole('button', { name: 'Remove one.txt', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(files, 'one.txt')).toHaveCount(0);
  await expect(files.getByRole('button', { name: 'Remove two.txt', exact: true })).toBeFocused();
  expect((await page.request.get(link)).status()).toBe(404);

  await files.getByRole('button', { name: 'Remove two.txt', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove two.txt?' }).getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(files.getByText('No files yet.')).toBeVisible();
  await expect(addButton(files)).toBeFocused();

  await page.reload();
  await expect(filesOf(page, 'Launch site').getByText('No files yet.')).toBeVisible();
});

test('FR-1.4: an archived item lists and downloads its files and shows the archived message, with no "Add file" or "Remove"', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Old season');
  await seedFile(page, id, itemId, 'wrap-up.txt', 'all done');
  await call('POST', `/api/roadmaps/${id}/projects/${itemId}/archive`);

  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Old season');
  await expect(files.getByText(ARCHIVED)).toBeVisible();
  await expect(rowOf(files, 'wrap-up.txt')).toBeVisible();
  expect(await bytesOf(await downloadFrom(page, files, 'wrap-up.txt'))).toBe('all done');
  await expect(files.getByRole('button')).toHaveCount(1);
});

test('FR-1.4: once the item is deleted, asking for its file\'s link is 404', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Short lived');
  const fileId = await seedFile(page, id, itemId, 'gone.txt', 'bye');
  await call('DELETE', `/api/roadmaps/${id}/projects/${itemId}`);
  const res = await page.request.get(`${filesBase(id, itemId)}/${fileId}/download`);
  expect(res.status()).toBe(404);
});

test('FR-1.4: the audit log shows "added a file" and "removed a file", and the action filter lists file events', async ({ page, call, owner, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const fileId = await seedFile(page, id, itemId, 'secret-name.txt', 'x');
  await call('DELETE', `${filesBase(id, itemId)}/${fileId}`);

  await page.goto(`/r/${id}/audit`);
  const log = page.getByRole('list', { name: 'Events' });
  for (const sentence of ['added a file.', 'removed a file.']) {
    await expect(log.getByRole('listitem').filter({ hasText: `${owner.name} ${sentence}` })).toHaveCount(1);
  }
  for (const [label, sentence] of [
    ['File added', 'added a file.'],
    ['File removed', 'removed a file.'],
  ] as const) {
    await field(page, 'Action').selectOption({ label });
    await expect(log.getByRole('listitem')).toHaveCount(1);
    await expect(log).toContainText(sentence);
  }
  await expect(field(page, 'Action').locator('option', { hasText: 'File blocked by the virus check' })).toHaveCount(1);
});

test('FR-1.4: at 375 px a 200-character file name causes no sideways scroll, and the panel passes axe', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const longName = `${'n'.repeat(196)}.txt`;
  await seedFile(page, id, itemId, longName, 'long');
  await page.goto(projectUrl(id, itemId));
  const files = filesOf(page, 'Launch site');
  await expect(rowOf(files, longName)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expectNoA11yViolations(page);
  const remove = await files.getByRole('button', { name: `Remove ${longName}`, exact: true }).boundingBox();
  expect(remove?.width).toBeGreaterThanOrEqual(44);
  expect(remove?.height).toBeGreaterThanOrEqual(44);
});

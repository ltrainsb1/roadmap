import type { Locator, Page } from '@playwright/test';
import { apiAs, expectNoA11yViolations, field, seedNote, seedProject, useCspGuard } from './helpers.ts';
import { expect, joinByApi, test } from './fixtures.ts';

useCspGuard();

const projectUrl = (roadmapId: string, projectId: string) => `/r/${roadmapId}/projects/${projectId}`;
const panelOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true });
const notesOf = (page: Page, title: string) => panelOf(page, title).getByRole('region', { name: 'Notes', exact: true });
const noteWith = (notes: Locator, text: string) => notes.getByRole('article').filter({ hasText: text });
const newNoteBox = (notes: Locator) => notes.getByRole('textbox', { name: 'Add a note', exact: true });

test('FR-1.5: a Contributor not assigned to an item adds a Markdown note; it shows rendered with their name and a time, and stays after a reload', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const writer = await joinByApi(browser, call, id, 'contributor', 'writer');
  const p = writer.page;
  await p.goto(projectUrl(id, itemId));
  const notes = notesOf(p, 'Launch site');
  await expect(notes.getByText('No notes yet.')).toBeVisible();
  await expect(notes.getByText('You can use Markdown. Type @ to mention someone.')).toBeVisible();

  await newNoteBox(notes).fill('Ship it **soon**\n\n- first step\n- second step');
  await notes.getByRole('button', { name: 'Add note', exact: true }).click();

  const added = noteWith(notes, 'Ship it');
  await expect(added.locator('.markdown strong')).toHaveText('soon');
  await expect(added.getByRole('listitem')).toHaveText(['first step', 'second step']);
  await expect(added.getByText('writer user', { exact: true })).toBeVisible();
  await expect(added.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(added.locator('time')).not.toBeEmpty();
  await expect(newNoteBox(notes)).toHaveValue('');
  await expect(newNoteBox(notes)).toBeFocused();
  await expect(notes.getByText('Note added.', { exact: true })).toHaveAttribute('aria-live', 'polite');

  await p.reload();
  await expect(noteWith(notesOf(p, 'Launch site'), 'Ship it').locator('.markdown strong')).toHaveText('soon');
  await writer.context.close();
});

test('FR-1.5: an Admin replies; the reply nests under the note, and replying to the reply adds to the same thread', async ({ browser, call, owner, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await seedNote(call, id, itemId, 'Owner question');
  const chief = await joinByApi(browser, call, id, 'admin', 'chief');
  const p = chief.page;
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.goto(projectUrl(id, itemId));
  const notes = notesOf(p, 'Launch site');

  await noteWith(notes, 'Owner question').getByRole('button', { name: 'Reply', exact: true }).click();
  const replyBox = notes.getByRole('textbox', { name: `Reply to ${owner.name}`, exact: true });
  await expect(replyBox).toBeFocused();
  await expectNoA11yViolations(p);
  await replyBox.fill('First answer');
  await notes.getByRole('button', { name: 'Add reply', exact: true }).click();
  const replies = notes.locator('.note-replies');
  await expect(replies.getByRole('article')).toHaveCount(1);
  await expect(replies.getByRole('article')).toContainText('First answer');
  await expect(replyBox).toHaveValue('');
  await expect(replyBox).toBeFocused();
  await expect(notes.getByText('Note added.', { exact: true })).toBeVisible();

  await noteWith(notes, 'First answer').getByRole('button', { name: 'Reply', exact: true }).click();
  const second = notes.getByRole('textbox', { name: 'Reply to chief user', exact: true });
  await second.fill('Second answer');
  await notes.getByRole('button', { name: 'Add reply', exact: true }).click();
  await expect(replies).toHaveCount(1);
  await expect(replies.getByRole('article')).toHaveCount(2);
  await expect(replies.getByRole('article').nth(1)).toContainText('Second answer');

  // Cancel closes the box.
  await notes.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(second).toHaveCount(0);
  await chief.context.close();
});

test('FR-1.5: the author edits their note and "Edited" appears; an Admin sees no Edit on it', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const writer = await joinByApi(browser, call, id, 'contributor', 'writer');
  const chief = await joinByApi(browser, call, id, 'admin', 'chief');
  await seedNote(await apiAs(writer.page), id, itemId, 'Draft wording');

  const p = writer.page;
  await p.goto(projectUrl(id, itemId));
  const notes = notesOf(p, 'Launch site');
  await noteWith(notes, 'Draft wording').getByRole('button', { name: 'Edit', exact: true }).click();
  const box = notes.getByRole('textbox', { name: 'Edit your note', exact: true });
  await expect(box).toHaveValue('Draft wording');
  await expect(box).toBeFocused();
  await box.fill('Final wording');
  await notes.getByRole('button', { name: 'Save note', exact: true }).click();
  const edited = noteWith(notes, 'Final wording');
  await expect(edited.getByText('Edited', { exact: true })).toBeVisible();
  await expect(box).toHaveCount(0);
  await expect(edited.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();

  const a = chief.page;
  await a.goto(projectUrl(id, itemId));
  const theirs = noteWith(notesOf(a, 'Launch site'), 'Final wording');
  await expect(theirs.getByText('Edited', { exact: true })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await writer.context.close();
  await chief.context.close();
});

test('FR-1.5: an Admin deletes a note that has a reply; "This note was deleted." stays with the reply, and deleting the reply removes both', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const writer = await joinByApi(browser, call, id, 'contributor', 'writer');
  const chief = await joinByApi(browser, call, id, 'admin', 'chief');
  const top = await seedNote(await apiAs(writer.page), id, itemId, 'Contributor idea');
  await seedNote(call, id, itemId, 'Owner reply', top);

  const p = chief.page;
  await p.goto(projectUrl(id, itemId));
  const notes = notesOf(p, 'Launch site');
  await expect(noteWith(notes, 'Owner reply')).toBeVisible();
  await expectNoA11yViolations(p);

  // Escape answers the question, not the panel: the panel stays open.
  const deleteIdea = noteWith(notes, 'Contributor idea').getByRole('button', { name: 'Delete', exact: true });
  await deleteIdea.click();
  const dialog = p.getByRole('dialog', { name: 'Delete this note?' });
  await expect(dialog).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(p).toHaveURL(projectUrl(id, itemId));
  await expect(deleteIdea).toBeFocused();

  await deleteIdea.click();
  await expect(dialog).toContainText("Its replies stay. This can't be undone.");
  await expectNoA11yViolations(p);
  await dialog.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const placeholder = noteWith(notes, 'This note was deleted.');
  await expect(placeholder).toBeVisible();
  await expect(placeholder.getByRole('button')).toHaveCount(0);
  await expect(notes.getByText('Contributor idea')).toHaveCount(0);
  // The deleted note's place had no control left; focus goes to the next note's.
  await expect(noteWith(notes, 'Owner reply').getByRole('button', { name: 'Reply', exact: true })).toBeFocused();

  await noteWith(notes, 'Owner reply').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toContainText("This can't be undone.");
  await expect(dialog).not.toContainText('Its replies stay.');
  await dialog.getByRole('button', { name: 'Delete note', exact: true }).click();
  await expect(notes.getByRole('article')).toHaveCount(0);
  await expect(notes.getByText('No notes yet.')).toBeVisible();
  await expect(newNoteBox(notes)).toBeFocused();

  await p.reload();
  await expect(notesOf(p, 'Launch site').getByText('No notes yet.')).toBeVisible();
  await writer.context.close();
  await chief.context.close();
});

test('FR-1.5: an empty note says "Write something first."; a 5,001-character note shows the length message and keeps the text', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await page.goto(projectUrl(id, itemId));
  const notes = notesOf(page, 'Launch site');
  const add = notes.getByRole('button', { name: 'Add note', exact: true });

  await add.click();
  await expect(notes.getByRole('alert')).toHaveText('Write something first.');
  await expect(newNoteBox(notes)).toBeFocused();

  const long = 'a'.repeat(5001);
  await newNoteBox(notes).fill(long);
  await add.click();
  await expect(notes.getByRole('alert')).toHaveText('Notes can be up to 5,000 characters.');
  await expect(newNoteBox(notes)).toHaveValue(long);
  await expect(notes.getByRole('article')).toHaveCount(0);
});

test('FR-1.5: text in a note box counts as unsaved: Escape and opening another row ask first, and Keep editing keeps it', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Alpha');
  await seedProject(call, id, 'Beta');
  await page.goto(projectUrl(id, itemId));
  const notes = notesOf(page, 'Alpha');
  const dialog = page.getByRole('dialog', { name: 'Discard your unsaved changes to Alpha?' });

  await newNoteBox(notes).fill('Half a thought');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(projectUrl(id, itemId));
  await expect(newNoteBox(notes)).toHaveValue('Half a thought');

  await page.getByRole('link', { name: 'Beta', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL(projectUrl(id, itemId));
  await expect(newNoteBox(notes)).toHaveValue('Half a thought');

  // Once the box is empty again, nothing asks.
  await newNoteBox(notes).fill('');
  await page.getByRole('link', { name: 'Beta', exact: true }).click();
  await expect(panelOf(page, 'Beta')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test('FR-1.5: a note with an <img onerror> and a javascript: link shows as text and a dead link; nothing runs', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const raw = '<img src=x onerror="window.__notePwned=1">';
  await seedNote(call, id, itemId, `Look ${raw} here\n\n[open me](javascript:window.__notePwned=2)`);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  await page.goto(projectUrl(id, itemId));
  const notes = notesOf(page, 'Launch site');
  const shown = noteWith(notes, 'Look');
  await expect(shown).toContainText(raw);
  await expect(notes.locator('img')).toHaveCount(0);
  const link = shown.locator('a', { hasText: 'open me' });
  await expect(link).toBeVisible();
  await expect(link).not.toHaveAttribute('href');
  await link.click();
  expect(await page.evaluate(() => (window as { __notePwned?: number }).__notePwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test('FR-1.5: an archived item shows its notes and the archived message, with no boxes', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Old season');
  await seedNote(call, id, itemId, 'Wrapped up');
  await call('POST', `/api/roadmaps/${id}/projects/${itemId}/archive`);

  await page.goto(projectUrl(id, itemId));
  const notes = notesOf(page, 'Old season');
  await expect(noteWith(notes, 'Wrapped up')).toBeVisible();
  await expect(notes.getByText("This item is archived, so notes and files can't be added or changed.")).toBeVisible();
  await expect(notes.getByRole('textbox')).toHaveCount(0);
  await expect(notes.getByRole('button')).toHaveCount(0);
});

test('FR-1.5: when the notes fail to load, "Couldn\'t load notes. Try again." shows with its button, and the item form still saves', async ({ page, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  await seedNote(call, id, itemId, 'Hidden for now');
  let blocked = true;
  await page.route('**/api/roadmaps/*/projects/*/notes', (route) => (blocked ? route.abort() : route.continue()));

  await page.goto(projectUrl(id, itemId));
  const panel = panelOf(page, 'Launch site');
  const alert = notesOf(page, 'Launch site').getByRole('alert');
  await expect(alert).toContainText("Couldn't load notes. Try again.");
  await expect(alert.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();

  await panel.getByLabel('Description', { exact: true }).fill('Still editable');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Saved.');

  blocked = false;
  await alert.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(noteWith(notesOf(page, 'Launch site'), 'Hidden for now')).toBeVisible();
  await expect(notesOf(page, 'Launch site').getByRole('alert')).toHaveCount(0);
});

test('FR-1.5: the audit log shows "added a note", "edited a note" and "deleted a note", and the action filter lists them', async ({ page, call, owner, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const noteId = await seedNote(call, id, itemId, 'Secret plan');
  await call('PATCH', `/api/roadmaps/${id}/projects/${itemId}/notes/${noteId}`, { body: 'Secret plan, revised' });
  await call('DELETE', `/api/roadmaps/${id}/projects/${itemId}/notes/${noteId}`);

  await page.goto(`/r/${id}/audit`);
  const log = page.getByRole('list', { name: 'Events' });
  for (const sentence of ['added a note.', 'edited a note.', 'deleted a note.']) {
    await expect(log.getByRole('listitem').filter({ hasText: `${owner.name} ${sentence}` })).toHaveCount(1);
  }
  await expect(log).not.toContainText('Secret plan');

  for (const [label, sentence] of [
    ['Note added', 'added a note.'],
    ['Note edited', 'edited a note.'],
    ['Note deleted', 'deleted a note.'],
  ] as const) {
    await field(page, 'Action').selectOption({ label });
    await expect(log.getByRole('listitem')).toHaveCount(1);
    await expect(log).toContainText(sentence);
  }
});

test('FR-1.5: at 375 px a note with a long unbroken word and a wide code block causes no sideways scroll', async ({ page, call, roadmap }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const topId = await seedNote(call, id, itemId, `Word ${'x'.repeat(300)}\n\n\`\`\`\n${'const wide = 1; '.repeat(30)}\n\`\`\``);
  await page.goto(projectUrl(id, itemId));
  const notes = notesOf(page, 'Launch site');
  await expect(notes.locator('pre')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expectNoA11yViolations(page);

  // Reply, Edit and Delete are 44 by 44 px targets.
  const shown = noteWith(notes, 'Word');
  for (const name of ['Reply', 'Edit', 'Delete']) {
    const box = await shown.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  // Replies are indented 16 px from their note, behind a left border.
  await seedNote(call, id, itemId, 'An answer', topId);
  await page.reload();
  const replies = notesOf(page, 'Launch site').locator('.note-replies');
  const [topBox, replyBox] = await Promise.all([noteWith(notes, 'Word').boundingBox(), replies.getByRole('article').boundingBox()]);
  expect(Math.round((replyBox?.x ?? 0) - (topBox?.x ?? 0))).toBe(16);
  await expect(replies).toHaveCSS('border-left-style', 'solid');
});

test('FR-1.5: a reply to a note that was just deleted keeps the typed text', async ({ browser, call, roadmap }) => {
  const id = roadmap.id;
  const itemId = await seedProject(call, id, 'Launch site');
  const noteId = await seedNote(call, id, itemId, 'Soon gone');
  const chief = await joinByApi(browser, call, id, 'admin', 'chief');
  const p = chief.page;
  await p.goto(projectUrl(id, itemId));
  const notes = notesOf(p, 'Launch site');

  await noteWith(notes, 'Soon gone').getByRole('button', { name: 'Reply', exact: true }).click();
  const replyBox = notes.getByRole('textbox', { name: /^Reply to / });
  await replyBox.fill('My careful answer');
  // Someone else deletes the note while the reply is being written.
  await call('DELETE', `/api/roadmaps/${id}/projects/${itemId}/notes/${noteId}`);
  await notes.getByRole('button', { name: 'Add reply', exact: true }).click();

  await expect(notes.getByRole('alert')).toHaveText('That note no longer exists.');
  await expect(replyBox).toHaveCount(0);
  await expect(notes.getByText('Soon gone')).toHaveCount(0);
  await expect(newNoteBox(notes)).toHaveValue('My careful answer');
  await expect(newNoteBox(notes)).toBeFocused();
  // Still counted as unsaved.
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog', { name: 'Discard your unsaved changes to Launch site?' })).toBeVisible();
  await chief.context.close();
});

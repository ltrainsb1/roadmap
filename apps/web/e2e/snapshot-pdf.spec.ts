import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { field, seedNote, seedProject, useCspGuard } from './helpers.ts';
import { createSnapshotByApi, expect, SNAPSHOT_PASSWORD, strangerContext, test, type ApiCall } from './fixtures.ts';

useCspGuard();

// One PDF layout serves every device, and the PDF service makes two at a time: these run on desktop, one after another.
test.describe.configure({ mode: 'default' });
test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'one PDF layout serves every device; the desktop project covers it');
});

/** The as-of date the header and footer show: the API's UTC date, which createSnapshotByApi sends. */
const asOfText = () =>
  `As of ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`))}`;

/** Each page's text, with runs of white space made one space. */
async function pdfPages(bytes: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** A stakeholder's browser with the snapshot open on `view`. */
async function openSnapshot(browser: Parameters<typeof strangerContext>[0], linkId: string, view: 'list' | 'timeline') {
  const { context, page } = await strangerContext(browser);
  await page.goto(`/s/${linkId}`);
  await field(page, 'Password').fill(SNAPSHOT_PASSWORD);
  await page.getByRole('button', { name: 'View snapshot' }).click();
  await expect(page).toHaveURL(`/s/${linkId}/list`);
  if (view === 'timeline') {
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Timeline' }).click();
    await expect(page).toHaveURL(`/s/${linkId}/timeline`);
  }
  return { context, page };
}

/** Presses "Download PDF" and returns the saved file's bytes, checking the button and its status on the way. */
async function downloadPdf(page: Page): Promise<Buffer> {
  const button = page.getByRole('button', { name: 'Download PDF' });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(button).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  return bytes;
}

/** "Launch site" (dated, with a link, assigned to the owner, with a note and a reply) holding "Design"; and "Hire". */
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
    links: [{ label: 'Spec', url: 'https://example.com/spec' }],
    blockedBy: [hire],
  });
  await call('PUT', `${base}/${launch}/assignees`, { userIds: [me] });
  const top = await seedNote(call, roadmapId, launch, 'Kick-off went well');
  await seedNote(call, roadmapId, launch, 'Agreed on scope', top);
}

test('FR-3.4: Download PDF on the list gives a PDF with the roadmap name, the as-of date, every item title and the notes', async ({ browser, call, owner, roadmap }) => {
  await seeded(call, roadmap.id);
  const linkId = await createSnapshotByApi(call, roadmap.id, { include: { notes: true, assignees: true } });
  const { context, page } = await openSnapshot(browser, linkId, 'list');

  const pages = await pdfPages(await downloadPdf(page));
  const text = pages.join(' ');
  expect(pages[0]).toContain(roadmap.name);
  expect(pages[0]).toContain(asOfText());
  expect(pages[0]).toContain('Times are in UTC.');
  for (const title of ['Launch site', 'Design', 'Hire']) expect(text).toContain(title);
  for (const part of ['Description', 'Milestones', 'Links', 'Blocked by', 'Notes', 'Assigned to']) expect(text).toContain(part);
  expect(text).toContain('Kick-off went well');
  expect(text).toContain('Agreed on scope');
  expect(text).toContain(owner.name);
  expect(text).toContain('Spec (https://example.com/spec)');
  expect(pages[0]).toContain(`${roadmap.name} · ${asOfText()} · Page 1 of ${pages.length}`);
  // A page to download, not to use: no tabs or buttons are printed.
  expect(text).not.toContain('Download PDF');
  expect(text).not.toContain('Timeline');
  await context.close();
});

test('FR-3.4: Download PDF on the timeline gives a one-page-wide PDF with every item title and the "As of" marker', async ({ browser, call, roadmap }) => {
  await seeded(call, roadmap.id);
  // A long run, so the timeline is far wider than the page on screen.
  const long = await seedProject(call, roadmap.id, 'Ten-year plan');
  await call('PATCH', `/api/roadmaps/${roadmap.id}/projects/${long}`, { version: 1, startDate: '2020-01-01', endDate: '2030-12-31' });
  const linkId = await createSnapshotByApi(call, roadmap.id);
  const { context, page } = await openSnapshot(browser, linkId, 'timeline');

  const pages = await pdfPages(await downloadPdf(page));
  const text = pages.join(' ');
  expect(pages[0]).toContain(roadmap.name);
  expect(pages[0]).toContain(asOfText());
  for (const title of ['Launch site', 'Design', 'Hire', 'Ten-year plan']) expect(text).toContain(title);
  expect(text).toContain('As of');
  expect(text).not.toContain('Zoom');
  expect(pages[0]).toContain(`${roadmap.name} · ${asOfText()} · Page 1 of ${pages.length}`);

  // The page the service printed fits the printable width of A4 landscape (273 mm, about 1,031 px) with nothing past it.
  await page.setViewportSize({ width: 1031, height: 730 });
  await page.emulateMedia({ media: 'print' });
  await page.goto(`/s/${linkId}/print/timeline`);
  await expect(page.locator('html[data-print="ready"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1031);
  await expect(page.locator('.today-label')).toHaveText('As of');
  await context.close();
});

test('FR-3.5: the PDF of a snapshot made without notes or names contains neither', async ({ browser, call, owner, roadmap }) => {
  await seeded(call, roadmap.id);
  const linkId = await createSnapshotByApi(call, roadmap.id, { include: { notes: false, assignees: false } });
  const { context, page } = await openSnapshot(browser, linkId, 'list');

  const text = (await pdfPages(await downloadPdf(page))).join(' ');
  expect(text).toContain('Launch site');
  expect(text).toContain('Description');
  expect(text).not.toContain('Kick-off went well');
  expect(text).not.toContain('Agreed on scope');
  expect(text).not.toContain('Notes');
  expect(text).not.toContain('Times are in UTC.');
  expect(text).not.toContain('Assigned to');
  expect(text).not.toContain(owner.name);
  await context.close();
});

test('FR-3.4: asking again downloads the same stored PDF', async ({ browser, call, roadmap }) => {
  await seeded(call, roadmap.id);
  const linkId = await createSnapshotByApi(call, roadmap.id, { include: { notes: true, assignees: false } });
  const { context, page } = await openSnapshot(browser, linkId, 'list');
  const first = await downloadPdf(page);
  const second = await downloadPdf(page);
  expect(second.equals(first)).toBe(true);
  await context.close();
});

test('FR-3.4: 200 items with long titles and 300 notes still make a PDF of more than one page', async ({ browser, call, roadmap }) => {
  // Seeding 500 things through the API and printing them takes longer than the usual test.
  test.setTimeout(300_000);
  const title = (n: number) => `Item ${String(n).padStart(3, '0')} with a long title that has to wrap inside the name column of the list`;
  const ids: string[] = [];
  for (let start = 0; start < 200; start += 10) {
    const batch = Array.from({ length: 10 }, (_, i) => start + i);
    ids.push(...(await Promise.all(batch.map((n) => seedProject(call, roadmap.id, title(n))))));
  }
  for (let start = 0; start < 300; start += 10) {
    const batch = Array.from({ length: 10 }, (_, i) => start + i);
    await Promise.all(batch.map((n) => seedNote(call, roadmap.id, ids[n % 200]!, `Note ${String(n).padStart(3, '0')} says the work is on track.`)));
  }
  const linkId = await createSnapshotByApi(call, roadmap.id, { include: { notes: true, assignees: true } });
  const { context, page } = await openSnapshot(browser, linkId, 'list');

  const pages = await pdfPages(await downloadPdf(page));
  expect(pages.length).toBeGreaterThan(1);
  pages.forEach((p, i) => expect(p).toContain(`${roadmap.name} · ${asOfText()} · Page ${i + 1} of ${pages.length}`));
  const text = pages.join(' ');
  for (let n = 0; n < 200; n++) expect(text).toContain(`Item ${String(n).padStart(3, '0')}`);
  for (let n = 0; n < 300; n++) expect(text).toContain(`Note ${String(n).padStart(3, '0')}`);
  // Every page after the first starts with the column headings again.
  for (const p of pages.slice(1)) expect(p).toContain('Name Status Dates Priority Assigned to');
  await context.close();
});

import type { SnapshotContent } from '@roadmap/shared';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { PRINT_TIMELINE_WIDTH } from './PrintPage.tsx';
import { content, fullContent, item, LINK, locationOf, note, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
const startTitle = document.title;

const printState = () => document.documentElement.dataset.print;
const footer = () => document.head.querySelector<HTMLMetaElement>('meta[name="pdf-footer"]')?.content;

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(() => {
  cleanup();
  document.title = startTitle;
});

/** fullContent() with its notes written out, as `?notes=all` answers. */
const withNotes = (): SnapshotContent => ({
  ...fullContent(),
  notes: [
    note({ id: 'n1', body: 'Kick-off went well', createdAt: '2026-03-10T23:30:00.000Z' }),
    note({ id: 'n2', parentId: 'n1', body: 'Agreed', authorName: null }),
    note({ id: 'n3', body: 'Moved the date', edited: true }),
  ],
});

test('FR-3.4: the list print page writes out every item\'s details and notes with nothing collapsed and no buttons', async () => {
  const calls = scriptApi(mockApi, { content: (all) => (all ? withNotes() : fullContent()) });
  renderViewer(`/s/${LINK}/print/list`);
  await waitFor(() => expect(printState()).toBe('ready'));

  // One call, for everything: no status check, no per-item notes.
  expect(calls).toEqual([`/api/snapshots/${LINK}/content?notes=all`]);
  expect(screen.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeTruthy();
  expect(screen.getByText('As of 12 Mar 2026')).toBeTruthy();
  expect(screen.getByText('Times are in UTC.')).toBeTruthy();
  expect(footer()).toBe('Launch plan · As of 12 Mar 2026');
  expect(document.title).toBe('Launch plan: snapshot');

  const table = screen.getByRole('table', { name: 'List' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Status', 'Dates', 'Priority', 'Assigned to']);
  expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Project: Launch site', 'Sub-project: Design', 'Project: Hire']);
  expect(within(table).getByText('In progress')).toBeTruthy();
  expect(within(table).getByText('1 · P1')).toBeTruthy();
  expect(within(table).getByText('Maria, Sam')).toBeTruthy();

  // Every part of the details, written out under the item.
  for (const part of ['Description', 'Milestones', 'Tags', 'Links', 'Blocked by', 'Notes']) {
    expect(within(table).getByRole('heading', { name: part })).toBeTruthy();
  }
  expect(within(table).getByText('Beta, 1 Apr 2026')).toBeTruthy();
  // A link's address is written after its text; an address that is not a web link is text.
  expect(within(table).getByRole('link', { name: 'Spec' }).getAttribute('href')).toBe('https://example.com/spec');
  expect(within(table).getByText('(https://example.com/spec)')).toBeTruthy();
  expect(within(table).getByText('Sneaky')).toBeTruthy();
  expect(within(table).queryByRole('link', { name: 'Sneaky' })).toBeNull();

  // Every note, replies under their note, with UTC times.
  const notes = within(table).getByRole('list', { name: 'Notes' });
  expect(within(notes).getByText('Kick-off went well')).toBeTruthy();
  expect(within(within(notes).getAllByRole('list')[0]!).getByText('Agreed')).toBeTruthy();
  expect(within(notes).getByText('Former member')).toBeTruthy();
  expect(within(notes).getByText('Edited')).toBeTruthy();
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date('2026-03-10T23:30:00.000Z'));
  expect(within(notes).getByText(when)).toBeTruthy();

  // Nothing to press, nothing collapsed.
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(document.querySelector('[aria-expanded]')).toBeNull();
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByText('Download PDF')).toBeNull();
});

test('FR-3.5: the list print page of a snapshot made without notes or names shows neither', async () => {
  const calls = scriptApi(mockApi, { content: () => content() });
  renderViewer(`/s/${LINK}/print/list`);
  await waitFor(() => expect(printState()).toBe('ready'));
  expect(calls).toEqual([`/api/snapshots/${LINK}/content?notes=all`]);
  const table = screen.getByRole('table', { name: 'List' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Status', 'Dates', 'Priority']);
  expect(within(table).queryByRole('heading', { name: 'Notes' })).toBeNull();
  expect(screen.queryByText('Times are in UTC.')).toBeNull();
  expect(within(table).getByRole('heading', { name: 'Description' })).toBeTruthy();
});

test('FR-3.4: the timeline print page is exactly 760 px of schedule, whatever the range', async () => {
  expect(PRINT_TIMELINE_WIDTH).toBe(760);
  const ranges: Array<[string, string]> = [
    ['2026-03-01', '2026-05-31'],
    ['2020-01-01', '2029-12-31'],
  ];
  for (const [startDate, endDate] of ranges) {
    const calls = scriptApi(mockApi, {
      content: () => content({ items: [item({ id: 'a', title: 'Long run', startDate, endDate, milestones: [{ id: 'm', name: 'Half', date: startDate }] })] }),
    });
    const { container, unmount } = renderViewer(`/s/${LINK}/print/timeline`);
    await waitFor(() => expect(printState()).toBe('ready'));
    expect(calls).toEqual([`/api/snapshots/${LINK}/content`]);

    const table = screen.getByRole('table', { name: 'Timeline' });
    const widths = [container.querySelector<HTMLElement>('.axis')!, ...container.querySelectorAll<HTMLElement>('.track')].map((el) => parseFloat(el.style.width));
    expect(widths).toHaveLength(2);
    for (const w of widths) {
      expect(w).toBeLessThanOrEqual(PRINT_TIMELINE_WIDTH);
      expect(w).toBeCloseTo(PRINT_TIMELINE_WIDTH, 2);
    }
    expect(container.querySelector('.today-label')?.textContent).toBe('As of');
    expect(within(table).getByText('Long run')).toBeTruthy();
    expect(within(table).getByText('Not started')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByLabelText('Zoom')).toBeNull();
    expect(footer()).toBe('Launch plan · As of 12 Mar 2026');
    unmount();
    mockApi.mockReset();
  }
});

test('FR-3.4: the page marks itself ready only after the content is rendered, and marks an error when loading fails', async () => {
  let answer!: (c: SnapshotContent) => void;
  scriptApi(mockApi, { content: () => new Promise<SnapshotContent>((resolve) => (answer = resolve)) });
  const seen: Array<{ state: string | undefined; title: boolean; footer: string | undefined }> = [];
  const watch = new MutationObserver(() =>
    seen.push({ state: printState(), title: document.body.textContent.includes('Launch site'), footer: footer() }),
  );
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-print'] });

  const { unmount } = renderViewer(`/s/${LINK}/print/list`);
  await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
  expect(printState()).toBeUndefined();
  answer(content());
  await waitFor(() => expect(printState()).toBe('ready'));
  watch.disconnect();
  expect(seen).toEqual([{ state: 'ready', title: true, footer: 'Launch plan · As of 12 Mar 2026' }]);

  // Leaving the page takes its marks away.
  unmount();
  expect(printState()).toBeUndefined();
  expect(footer()).toBeUndefined();

  // A refusal or a failure marks an error, and the page shows no content.
  for (const err of [new ApiError(401, 'password_required'), new ApiError(410, 'snapshot_expired'), new ApiError(500, 'unknown')]) {
    mockApi.mockReset();
    scriptApi(mockApi, { content: () => err });
    const page = renderViewer(`/s/${LINK}/print/timeline`);
    await waitFor(() => expect(printState()).toBe('error'));
    // Never the password page: the service's browser has no one to type a password.
    expect(locationOf(page.container)).toBe(`/s/${LINK}/print/timeline`);
    expect(screen.queryByRole('table')).toBeNull();
    expect(footer()).toBeUndefined();
    page.unmount();
  }

  // An empty snapshot is still ready.
  mockApi.mockReset();
  scriptApi(mockApi, { content: () => content({ items: [] }) });
  renderViewer(`/s/${LINK}/print/list`);
  await waitFor(() => expect(printState()).toBe('ready'));
  expect(screen.getByText('This snapshot has no items.')).toBeTruthy();
});

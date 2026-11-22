import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { fullContent, LINK, locationOf, note, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
const startTz = process.env.TZ;

beforeEach(() => {
  mockApi.mockReset();
  process.env.TZ = 'America/New_York';
});
afterEach(() => {
  cleanup();
  if (startTz === undefined) delete process.env.TZ;
  else process.env.TZ = startTz;
});

const THREAD = [
  note({ id: 'n1', body: 'First, with @Sam', mentions: ['Sam'], createdAt: '2026-03-10T14:05:00.000Z' }),
  note({ id: 'n2', parentId: 'n1', body: 'A reply', authorName: null, edited: true, createdAt: '2026-03-11T09:00:00.000Z' }),
  note({ id: 'n3', body: '', deleted: true, createdAt: '2026-03-11T10:00:00.000Z' }),
  note({ id: 'n4', parentId: 'n3', body: 'Reply under a deleted note', authorName: 'Sam', createdAt: '2026-03-11T11:00:00.000Z' }),
];

const notesCalls = () => mockApi.mock.calls.filter(([path]) => path.endsWith('/notes')).map(([path]) => path);

test('FR-3.5: opening an item\'s details loads its notes once, shows replies under their note, "Edited", the deleted placeholder and "Former member"', async () => {
  scriptApi(mockApi, { content: () => fullContent({ p1: 4 }), notes: () => ({ notes: THREAD }) });
  renderViewer(`/s/${LINK}/list`);
  const title = await screen.findByRole('button', { name: 'Details for Launch site' });
  // Nothing is asked for until the details open.
  expect(notesCalls()).toEqual([]);
  fireEvent.click(title);
  expect(screen.getByText('Loading')).toBeTruthy();
  const threads = await screen.findByRole('list', { name: 'Notes' });
  expect(notesCalls()).toEqual([`/api/snapshots/${LINK}/items/p1/notes`]);

  const [first, second] = within(threads).getAllByRole('listitem').filter((li) => li.parentElement === threads);
  const firstNote = within(first!).getAllByRole('article')[0]!;
  expect(within(firstNote).getByText('Maria')).toBeTruthy();
  expect(firstNote.querySelector('.mention')?.textContent).toBe('@Sam');
  const time = firstNote.querySelector('time')!;
  expect(time.getAttribute('datetime')).toBe('2026-03-10T14:05:00.000Z');
  // In the browser's own zone: 14:05 UTC is 10:05 in New York.
  expect(time.textContent).toMatch(/10:05/);
  const reply = within(within(first!).getByRole('list')).getByRole('article');
  expect(within(reply).getByText('Former member')).toBeTruthy();
  expect(within(reply).getByText('Edited')).toBeTruthy();
  expect(within(reply).getByText('A reply')).toBeTruthy();

  expect(within(second!).getAllByRole('article')[0]!.textContent).toBe('This note was deleted.');
  expect(within(within(second!).getByRole('list')).getByText('Reply under a deleted note')).toBeTruthy();

  // Closing and opening again does not ask again.
  fireEvent.click(title);
  fireEvent.click(title);
  await screen.findByRole('list', { name: 'Notes' });
  expect(notesCalls()).toHaveLength(1);
});

test('FR-3.5: a failed notes load shows the message, and "Try again" loads them', async () => {
  let fail = true;
  scriptApi(mockApi, {
    content: () => fullContent({ p1: 1 }),
    notes: () => (fail ? new ApiError(500, 'unknown') : { notes: [note({ id: 'n1', body: 'Back again' })] }),
  });
  renderViewer(`/s/${LINK}/list`);
  fireEvent.click(await screen.findByRole('button', { name: 'Details for Launch site' }));
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText("Couldn't load notes. Try again.")).toBeTruthy();
  fail = false;
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Back again')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('FR-3.5: an item with no notes says "No notes." without asking the server', async () => {
  scriptApi(mockApi, { content: () => fullContent({ p1: 0 }) });
  renderViewer(`/s/${LINK}/list`);
  fireEvent.click(await screen.findByRole('button', { name: 'Details for Launch site' }));
  expect(screen.getByText('No notes.')).toBeTruthy();
  expect(notesCalls()).toEqual([]);
});

test('FR-3.2: a session that ends while notes load returns to the password page', async () => {
  scriptApi(mockApi, { content: () => fullContent({ p1: 1 }), notes: () => new ApiError(401, 'password_required') });
  const { container } = renderViewer(`/s/${LINK}/list`);
  fireEvent.click(await screen.findByRole('button', { name: 'Details for Launch site' }));
  await waitFor(() => expect(locationOf(container)).toBe(`/s/${LINK}`));
  expect((await screen.findByRole('alert')).textContent).toBe('Enter the password again to keep viewing.');
});

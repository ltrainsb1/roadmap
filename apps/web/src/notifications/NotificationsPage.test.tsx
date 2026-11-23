import type { Notification, NotificationPage } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { formatWhen } from '../audit/dates.ts';
import { NotificationsPage } from './NotificationsPage.tsx';
import { NOTIFICATIONS_KEY, UNREAD_KEY } from './useNotifications.ts';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));
vi.mock('../auth/useMe.ts', () => ({
  useMe: () => ({ data: { user: { timezone: 'Europe/Paris' } } }),
}));

const mockApi = vi.mocked(api);
const TZ = 'Europe/Paris';

beforeEach(() => mockApi.mockReset());
afterEach(cleanup);

let seq = 0;
const note = (over: Partial<Notification>): Notification => {
  seq += 1;
  return {
    id: `n${seq}`,
    type: 'assigned',
    roadmapId: 'r1',
    roadmapName: 'Launch plan',
    projectId: `p${seq}`,
    projectTitle: 'Website',
    actorName: 'Maria',
    hasActor: true,
    detail: { kind: 'assigned' },
    createdAt: '2027-01-12T09:30:00.000Z',
    read: true,
    ...over,
  };
};

type Answer = unknown;

/**
 * Answers the page's calls: `pages` by cursor ('' for the first), the unread count, and the two marks.
 * Every call is recorded by the mock, so tests assert on `mockApi`.
 */
function serve(pages: Record<string, Answer>, marks: { one?: Answer; all?: Answer } = {}) {
  mockApi.mockImplementation((path: string) => {
    const answer = (a: Answer) => (a instanceof Error ? Promise.reject(a) : Promise.resolve(a));
    if (path === '/api/notifications/unread-count') return answer({ unread: 0 });
    if (path === '/api/notifications/read-all') return answer(marks.all);
    if (/^\/api\/notifications\/[^/]+\/read$/.test(path)) return answer(marks.one);
    const cursor = new URL(path, 'http://x').searchParams.get('cursor') ?? '';
    if (!(cursor in pages)) throw new Error(`unexpected call ${path}`);
    return answer(pages[cursor]);
  });
}

const page = (items: Notification[], nextCursor: string | null = null): NotificationPage => ({
  items,
  nextCursor,
  unread: items.filter((n) => !n.read).length,
});

function ItemScreen() {
  const { roadmapId, projectId } = useParams();
  return <p>Item {`${roadmapId}/${projectId}`}</p>;
}

function renderPage(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/notifications']}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/r/:roadmapId/projects/:projectId" element={<ItemScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const rowsOf = async () => within(await screen.findByRole('list', { name: 'Notifications' })).getAllByRole('listitem');
const part = (row: HTMLElement, cls: string) => row.querySelector(`.${cls}`)?.textContent ?? null;

test('FR-5.3: each kind of row shows its exact sentence, the roadmap and the time, and "Unread" only on unread rows', async () => {
  const items = [
    note({ read: false }),
    note({ type: 'dates_changed', detail: { kind: 'dates', before: { startDate: '2027-03-03', endDate: '2027-04-28' }, after: { startDate: '2027-03-05', endDate: '2027-04-28' } } }),
    note({ type: 'dates_changed', detail: { kind: 'milestone', change: 'moved', name: 'Beta', date: '2027-05-10' } }),
    note({ type: 'dates_changed', detail: { kind: 'milestone', change: 'added', name: 'Beta', date: '2027-05-10' } }),
    note({ type: 'dates_changed', detail: { kind: 'milestone', change: 'removed', name: 'Beta', date: '2027-05-10' } }),
    note({ type: 'mentioned', actorName: null, detail: { kind: 'mentioned', excerpt: 'Can you check the copy?' }, read: false }),
    note({ type: 'due_soon', actorName: null, hasActor: false, detail: { kind: 'due_end', date: '2027-03-03' } }),
    note({ type: 'due_soon', actorName: null, hasActor: false, detail: { kind: 'due_milestone', name: 'Beta', date: '2027-05-10' } }),
    note({ roadmapName: '', createdAt: '2027-07-01T22:15:00.000Z' }),
  ];
  serve({ '': page(items) });
  renderPage();
  const rows = await rowsOf();
  expect(mockApi).toHaveBeenCalledWith('/api/notifications');

  expect(rows.map((r) => part(r, 'notification-sentence'))).toEqual([
    'Maria assigned you to Website.',
    'Maria changed the dates on Website.',
    'Maria moved the milestone Beta on Website to 10 May 2027.',
    'Maria added the milestone Beta on Website.',
    'Maria removed the milestone Beta on Website.',
    'A former member mentioned you on Website.',
    'Website is due 3 Mar 2027.',
    'The milestone Beta on Website is on 10 May 2027.',
    'Maria assigned you to Website.',
  ]);
  expect(rows.map((r) => part(r, 'notification-excerpt'))).toEqual([null, null, null, null, null, '“Can you check the copy?”', null, null, null]);

  const when = formatWhen('2027-01-12T09:30:00.000Z', TZ);
  expect(part(rows[0]!, 'notification-meta')).toBe(`Launch plan · ${when}`);
  expect(part(rows[1]!, 'notification-meta')).toBe(`3 Mar to 28 Apr 2027 → 5 Mar to 28 Apr 2027 · Launch plan · ${when}`);
  // A roadmap gone mid-request leaves only the time.
  expect(part(rows[8]!, 'notification-meta')).toBe(formatWhen('2027-07-01T22:15:00.000Z', TZ));
  expect(rows[0]!.querySelector('time')?.getAttribute('dateTime')).toBe('2027-01-12T09:30:00.000Z');

  expect(rows.map((r) => within(r).queryByText('Unread') !== null)).toEqual([true, false, false, false, false, true, false, false, false]);
  expect(within(rows[0]!).getByText('Unread').className).toBe('sr-only');

  // Each row is one link to the item, and the page ends with the way to the email settings.
  expect(within(rows[0]!).getByRole('link').getAttribute('href')).toBe(`/r/r1/projects/${items[0]!.projectId}`);
  expect(screen.getByRole('link', { name: 'Change which emails you get' }).getAttribute('href')).toBe('/settings/notifications');
  expect(screen.getByRole('heading', { name: 'Notifications', level: 1 })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

test('FR-5.3: opening a row marks it read and goes to the item', async () => {
  const unread = note({ read: false, roadmapId: 'r9', projectId: 'p9' });
  serve({ '': page([unread]) }, { one: undefined });
  const client = renderPage();
  const [row] = await rowsOf();
  fireEvent.click(within(row!).getByRole('link'));
  expect(await screen.findByText('Item r9/p9')).toBeTruthy();
  expect(mockApi).toHaveBeenCalledWith(`/api/notifications/${unread.id}/read`, { method: 'POST' });
  // The list and the count are marked out of date, so both are asked for again when next shown.
  await waitFor(() => expect(client.getQueryState(NOTIFICATIONS_KEY)?.isInvalidated).toBe(true));
  expect(client.getQueryState(UNREAD_KEY)?.isInvalidated).toBe(true);
});

test('FR-5.3: opening a row still goes to the item when the mark fails, and a read row is not marked again', async () => {
  const unread = note({ read: false, projectId: 'p1' });
  const read = note({ read: true, projectId: 'p2' });
  serve({ '': page([unread, read]) }, { one: new ApiError(500, 'unknown') });
  renderPage();
  let rows = await rowsOf();
  fireEvent.click(within(rows[0]!).getByRole('link'));
  expect(await screen.findByText('Item r1/p1')).toBeTruthy();

  cleanup();
  mockApi.mockClear();
  renderPage();
  rows = await rowsOf();
  fireEvent.click(within(rows[1]!).getByRole('link'));
  expect(await screen.findByText('Item r1/p2')).toBeTruthy();
  expect(mockApi.mock.calls.some(([p]) => p.endsWith('/read'))).toBe(false);
});

test('FR-5.3: "Mark all as read" marks everything read, hides itself and moves focus to the heading; a failure shows its message', async () => {
  const items = [note({ read: false }), note({ read: false }), note({ read: true })];
  serve({ '': page(items) }, { all: new ApiError(500, 'unknown') });
  renderPage();
  await rowsOf();

  fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't mark notifications as read. Try again.");
  expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeTruthy();
  expect(await rowsOf()).toHaveLength(3);
  expect((await rowsOf()).filter((r) => within(r).queryByText('Unread')).length).toBe(2);

  // The next try works; the refetch then answers with everything read.
  serve({ '': page(items.map((n) => ({ ...n, read: true }))) }, { all: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull());
  expect(mockApi).toHaveBeenCalledWith('/api/notifications/read-all', { method: 'POST' });
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Notifications', level: 1 }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect((await rowsOf()).some((r) => within(r).queryByText('Unread'))).toBe(false);
});

test('FR-5.3: "Show more" loads the next 30 and moves focus to the first new row', async () => {
  const first = Array.from({ length: 30 }, () => note({}));
  const second = Array.from({ length: 30 }, () => note({ projectTitle: 'Older item' }));
  serve({ '': page(first, 'c1'), c1: page(second, null) });
  renderPage();
  expect(await rowsOf()).toHaveLength(30);

  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
  await waitFor(async () => expect(await rowsOf()).toHaveLength(60));
  expect(mockApi).toHaveBeenCalledWith('/api/notifications?cursor=c1');
  const rows = await rowsOf();
  await waitFor(() => expect(document.activeElement).toBe(within(rows[30]!).getByRole('link')));
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

test('FR-5.3: the list says when it is loading, when it is empty, and when it could not load, with "Try again"', async () => {
  let fail = true;
  mockApi.mockImplementation((path: string) => {
    if (path === '/api/notifications/unread-count') return Promise.resolve({ unread: 0 });
    return fail ? Promise.reject(new ApiError(500, 'unknown')) : Promise.resolve(page([]));
  });
  renderPage();
  expect(screen.getByRole('status').textContent).toBe('Loading');
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load notifications. Try again.");
  expect(screen.queryByRole('link', { name: 'Change which emails you get' })).toBeTruthy();

  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No notifications yet.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Notifications' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Mark all as read' })).toBeNull();
});

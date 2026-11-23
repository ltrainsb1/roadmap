import type { SnapshotSummary } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { endOfLocalDay } from './useSnapshots.ts';
import { SnapshotsPage } from './SnapshotsPage.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));
vi.mock('../roadmaps/RoadmapLayout.tsx', () => ({
  useRoadmap: () => ({ roadmapId: 'r1', roadmapName: 'Launch plan', role: 'owner' }),
}));
vi.mock('../auth/useMe.ts', () => ({
  useMe: () => ({ data: { user: { timezone: 'UTC' } } }),
}));

const mockApi = vi.mocked(api);
const startTz = process.env.TZ;

// jsdom has no modal dialogs.
beforeAll(() => {
  process.env.TZ = 'UTC';
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
afterAll(() => {
  if (startTz === undefined) delete process.env.TZ;
  else process.env.TZ = startTz;
});

beforeEach(() => {
  mockApi.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = 'UTC';
});

const snapshot = (over: Partial<SnapshotSummary> & Pick<SnapshotSummary, 'id' | 'name'>): SnapshotSummary => ({
  linkId: `link-${over.id}`,
  asOf: '2027-01-10',
  createdAt: '2027-01-11T09:00:00.000Z',
  createdByName: 'Maria',
  expiresAt: null,
  include: { notes: false, assignees: false },
  itemCount: 3,
  noteCount: 0,
  lockedUntil: null,
  openCount: 0,
  lastOpenedAt: null,
  ...over,
});

async function renderPage(snapshots: SnapshotSummary[]) {
  mockApi.mockResolvedValue({ snapshots });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SnapshotsPage />
    </QueryClientProvider>,
  );
  const list = await screen.findByRole('list', { name: 'Snapshots' });
  return (name: string) => {
    const card = within(list)
      .getAllByRole('listitem')
      .find((li) => within(li).queryByRole('heading', { name }));
    if (!card) throw new Error(`no card for ${name}`);
    return card;
  };
}

const lines = (card: HTMLElement) => Array.from(card.querySelectorAll('.snapshot-facts li'), (li) => li.textContent);

test('FR-3.2: a card shows Active, Expired or Locked until {time}, and its opened line in each of its three forms', async () => {
  const card = await renderPage([
    snapshot({ id: 'a', name: 'Fresh', expiresAt: '2027-03-01T23:59:59.999Z' }),
    snapshot({ id: 'b', name: 'Old', expiresAt: '2027-01-14T23:59:59.999Z', openCount: 1, lastOpenedAt: '2027-01-12T08:00:00.000Z', lockedUntil: '2027-01-15T12:10:00.000Z' }),
    snapshot({ id: 'c', name: 'Guessed', lockedUntil: '2027-01-15T12:10:00.000Z', openCount: 3, lastOpenedAt: '2027-01-14T18:00:00.000Z' }),
    snapshot({ id: 'd', name: 'Unlocked again', lockedUntil: '2027-01-15T11:50:00.000Z', createdByName: null }),
  ]);
  expect(mockApi).toHaveBeenCalledWith('/api/roadmaps/r1/snapshots');

  const fresh = card('Fresh');
  expect(within(fresh).getByText('Active').className).toContain('badge');
  expect(lines(fresh)).toEqual(['As of 10 Jan 2027', 'Created by Maria on 11 Jan 2027', 'Expires 1 Mar 2027', 'Not opened yet']);

  // Expired wins over a lock.
  const old = card('Old');
  expect(within(old).getByText('Expired')).toBeTruthy();
  expect(within(old).queryByText(/^Locked until/)).toBeNull();
  expect(lines(old)).toEqual(['As of 10 Jan 2027', 'Created by Maria on 11 Jan 2027', 'Expires 14 Jan 2027', 'Opened once, on 12 Jan 2027']);

  const guessed = card('Guessed');
  expect(within(guessed).getByText('Locked until 12:10')).toBeTruthy();
  expect(lines(guessed)).toEqual(['As of 10 Jan 2027', 'Created by Maria on 11 Jan 2027', 'No expiry', 'Opened 3 times, last on 14 Jan 2027']);

  // A lock that has run out is no lock.
  const again = card('Unlocked again');
  expect(within(again).getByText('Active')).toBeTruthy();
  expect(lines(again)[1]).toBe('Created by a former member on 11 Jan 2027');

  // The actions, each named after its snapshot.
  expect(within(fresh).getByRole('button', { name: 'Copy link to Fresh' })).toBeTruthy();
  expect(within(fresh).getByRole('button', { name: 'Revoke Fresh' })).toBeTruthy();
  const open = within(fresh).getByRole('link', { name: 'Open Fresh' });
  expect(open.getAttribute('href')).toBe('/s/link-a');
  expect(open.getAttribute('target')).toBe('_blank');
  expect(open.getAttribute('rel')).toBe('noopener noreferrer');
});

test("FR-3.5: a card's last line says what the snapshot shows, and is absent when it shows nothing extra", async () => {
  const card = await renderPage([
    snapshot({ id: 'a', name: 'Both', include: { notes: true, assignees: true } }),
    snapshot({ id: 'b', name: 'Notes only', include: { notes: true, assignees: false } }),
    snapshot({ id: 'c', name: 'Names only', include: { notes: false, assignees: true } }),
    snapshot({ id: 'd', name: 'Plain' }),
  ]);
  expect(lines(card('Both'))[4]).toBe('Shows notes and assignee names.');
  expect(lines(card('Notes only'))[4]).toBe('Shows notes.');
  expect(lines(card('Names only'))[4]).toBe('Shows assignee names.');
  expect(lines(card('Plain'))).toHaveLength(4);
  expect(card('Plain').textContent).not.toContain('Shows');
});

test('FR-3.2: the expiry line reads as the day picked, in the browser\'s own zone, while other dates use the profile zone', async () => {
  // The browser is in New York; the profile says UTC. The link was set to expire at the end of 1 Mar in New York.
  process.env.TZ = 'America/New_York';
  const expiresAt = endOfLocalDay('2027-03-01');
  expect(expiresAt).toBe('2027-03-02T04:59:59.999Z');
  const card = await renderPage([snapshot({ id: 'a', name: 'Late', expiresAt, createdAt: '2027-01-11T02:00:00.000Z' })]);
  // Created at 02:00 UTC on the 11th, which is still the 10th in New York: the profile zone wins there.
  expect(lines(card('Late'))).toEqual(['As of 10 Jan 2027', 'Created by Maria on 11 Jan 2027', 'Expires 1 Mar 2027', 'Not opened yet']);
});

test('FR-3.2: a second press on "Revoke snapshot" sends one request, and the next revoke dialog opens without an error', async () => {
  let finish: () => void = () => undefined;
  const list = { snapshots: [snapshot({ id: 'a', name: 'First' }), snapshot({ id: 'b', name: 'Second' })] };
  mockApi.mockImplementation((path, opts) => {
    if (opts?.method === 'DELETE') {
      // The first delete answers when told to; any later one would find it gone.
      if (mockApi.mock.calls.filter(([, o]) => o?.method === 'DELETE').length > 1) return Promise.reject(new ApiError(404, 'not_found'));
      return new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      });
    }
    void path;
    return Promise.resolve(list);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SnapshotsPage />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke First' }));
  const confirm = screen.getByRole('dialog', { name: 'Revoke First?' });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke snapshot' }));
  fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke snapshot' }));
  await waitFor(() => expect(mockApi.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(true));
  list.snapshots = list.snapshots.slice(1);
  finish();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Revoke First?' })).toBeNull());
  expect(mockApi.mock.calls.filter(([, o]) => o?.method === 'DELETE')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Revoke Second' }));
  const next = screen.getByRole('dialog', { name: 'Revoke Second?' });
  expect(within(next).queryByRole('alert')).toBeNull();
});

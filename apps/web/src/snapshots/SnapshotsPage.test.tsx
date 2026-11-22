import type { SnapshotSummary } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
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

beforeEach(() => {
  mockApi.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-15T12:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

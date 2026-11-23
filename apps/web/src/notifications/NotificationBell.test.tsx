import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
import { NotificationBell } from './NotificationBell.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

beforeEach(() => mockApi.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const countCalls = () => mockApi.mock.calls.filter(([path]) => path === '/api/notifications/unread-count').length;

test('FR-5.3: the bell shows no badge at 0, the count up to 99, then "99+", and its accessible name says how many are unread', async () => {
  const cases: Array<[number, string, string | null]> = [
    [0, 'Notifications', null],
    [1, 'Notifications, 1 unread', '1'],
    [99, 'Notifications, 99 unread', '99'],
    [100, 'Notifications, 99+ unread', '99+'],
  ];
  for (const [unread, name, badge] of cases) {
    mockApi.mockResolvedValue({ unread });
    const { container, unmount } = renderBell();
    const link = await screen.findByRole('link', { name });
    expect(link.getAttribute('href')).toBe('/notifications');
    expect(link.textContent).toBe(badge === null ? 'Notifications' : `Notifications ${badge}`);
    expect(container.querySelector('.bell-badge')?.textContent ?? null).toBe(badge);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    unmount();
  }
  expect(mockApi).toHaveBeenCalledWith('/api/notifications/unread-count', { quiet: true });
});

test('FR-5.3: the bell asks for the count every 60 seconds and when the window is shown again, and stops once it is gone', async () => {
  // Only the interval is faked, so the queries' own timeouts and Testing Library's waits run as usual.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  mockApi.mockResolvedValue({ unread: 2 });
  const { unmount } = renderBell();
  await screen.findByRole('link', { name: 'Notifications, 2 unread' });
  expect(countCalls()).toBe(1);

  mockApi.mockResolvedValue({ unread: 3 });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  await screen.findByRole('link', { name: 'Notifications, 3 unread' });
  expect(countCalls()).toBe(2);

  // The browser fires this at the document and it bubbles to the window, where the query library listens.
  act(() => void document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
  await vi.waitFor(() => expect(countCalls()).toBe(3));

  unmount();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(countCalls()).toBe(3);
});

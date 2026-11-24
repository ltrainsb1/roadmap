import type { MeResponse } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
import { CalendarSettingsPage } from './CalendarSettingsPage.tsx';
import { NotificationSettingsPage } from './NotificationSettingsPage.tsx';
import { SecurityPage } from './SecurityPage.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

const ME: MeResponse = {
  user: { id: 'u1', email: 'pat@example.com', name: 'Pat', timezone: 'UTC', hasTotp: true, passkeys: [] },
  csrfToken: 'csrf',
  memberships: [],
};

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation((path: string) => {
    if (path === '/api/me') return Promise.resolve(ME);
    if (path === '/api/notifications/unread-count') return Promise.resolve({ unread: 0 });
    if (path === '/api/me/notification-prefs')
      return Promise.resolve({ prefs: { assigned: 'instant', mentioned: 'instant', dates_changed: 'digest', due_soon: 'instant' }, timezone: 'UTC' });
    if (path === '/api/me/calendar-feed') return Promise.resolve({ feed: null });
    throw new Error(`unexpected call ${path}`);
  });
});
afterEach(cleanup);

const PAGES = [
  { path: '/settings/security', heading: 'Security', current: 'Security' },
  { path: '/settings/notifications', heading: 'Email notifications', current: 'Email notifications' },
  { path: '/settings/calendar', heading: 'Calendar feed', current: 'Calendar feed' },
] as const;

test.each(PAGES)('the three settings pages show the tabs with the current one marked: $path', async ({ path, heading, current }) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/security" element={<SecurityPage />} />
          <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
          <Route path="/settings/calendar" element={<CalendarSettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole('heading', { name: heading, level: 1 })).toBeTruthy();
  const tabs = within(screen.getByRole('navigation', { name: 'Settings' })).getAllByRole('link');
  expect(tabs.map((t) => t.textContent)).toEqual(['Security', 'Email notifications', 'Calendar feed']);
  expect(tabs.map((t) => t.getAttribute('href'))).toEqual(['/settings/security', '/settings/notifications', '/settings/calendar']);
  expect(tabs.filter((t) => t.getAttribute('aria-current') === 'page').map((t) => t.textContent)).toEqual([current]);
  // Let the page's loads settle inside the test.
  await screen.findAllByRole('link', { name: current });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { UnsubscribePage } from './UnsubscribePage.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
beforeEach(() => mockApi.mockReset());
afterEach(cleanup);

const TOKEN = 'tenant-1.user-1.sig_-x';

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/unsubscribe" element={<UnsubscribePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BAD = "This link doesn't work. You can change your emails in your notification settings.";
const textOf = (role: string) => screen.getByRole(role).textContent;

test('FR-5: the page shows the heading, the body and the button, and loading it makes no request', () => {
  renderAt(`/unsubscribe?t=${TOKEN}`);
  expect(screen.getByRole('heading', { level: 1, name: 'Turn off notification emails' })).toBeTruthy();
  expect(screen.getByText("This turns off every notification email. You'll still see notifications in the app.")).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off emails' })).toBeTruthy();
  expect(mockApi).not.toHaveBeenCalled();
});

test('FR-5: the button POSTs once to the API with the page\'s token and shows the done text with a link to the settings', async () => {
  mockApi.mockResolvedValue(undefined);
  renderAt(`/unsubscribe?t=${TOKEN}`);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off emails' }));
  const status = await screen.findByRole('status');
  expect(status.textContent).toBe('Emails are off. You can turn them back on in your notification settings.');
  expect(screen.getByRole('link', { name: 'notification settings' }).getAttribute('href')).toBe('/settings/notifications');
  expect(mockApi).toHaveBeenCalledTimes(1);
  expect(mockApi.mock.calls[0]![0]).toBe(`/api/email/unsubscribe?t=${encodeURIComponent(TOKEN)}`);
  expect(mockApi.mock.calls[0]![1]).toMatchObject({ method: 'POST', quiet: true });
  expect(screen.queryByRole('button', { name: 'Turn off emails' })).toBeNull();
});

test('FR-5: a 404 shows the bad-link text as an alert, with the settings link', async () => {
  mockApi.mockRejectedValueOnce(new ApiError(404, 'unknown'));
  renderAt(`/unsubscribe?t=${TOKEN}`);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off emails' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(BAD);
  expect(screen.getByRole('link', { name: 'notification settings' }).getAttribute('href')).toBe('/settings/notifications');
});

test('FR-5: a page with no token shows the bad-link text and never calls the API', () => {
  renderAt('/unsubscribe');
  expect(textOf('alert')).toBe(BAD);
  expect(screen.queryByRole('button', { name: 'Turn off emails' })).toBeNull();
  expect(mockApi).not.toHaveBeenCalled();
});

test('FR-5: another failure shows an alert and keeps the button, so the person can try again', async () => {
  mockApi.mockRejectedValueOnce(new ApiError(500, 'unknown')).mockResolvedValueOnce(undefined);
  renderAt(`/unsubscribe?t=${TOKEN}`);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off emails' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Turn off emails' }));
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(mockApi).toHaveBeenCalledTimes(2);
});

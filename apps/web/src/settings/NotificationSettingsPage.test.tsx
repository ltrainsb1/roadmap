import type { NotificationPrefs, PrefsResponse } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { NotificationSettingsPage } from './NotificationSettingsPage.tsx';
import { PREFS_KEY } from './useNotificationPrefs.ts';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

// jsdom has no modal dialogs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
beforeEach(() => {
  mockApi.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SAVED: NotificationPrefs = { assigned: 'instant', mentioned: 'off', dates_changed: 'digest', due_soon: 'instant' };
const ROWS = ['Assigned to you', 'Mentions', 'Dates changed on your items', 'Due soon'] as const;

type Answer = unknown;
type PutAnswer = (body: NotificationPrefs) => Answer;
/** Answers the page's calls: the saved settings, the save (a function of the body sent), and the bell's count. */
function serve(get: Answer, put: PutAnswer = () => undefined) {
  mockApi.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
    const answer = (a: Answer) => (a instanceof Error ? Promise.reject(a) : a instanceof Promise ? a : Promise.resolve(a));
    if (path === '/api/notifications/unread-count') return answer({ unread: 0 });
    if (path === '/api/me/notification-prefs' && opts?.method === 'PUT') return answer(put(opts.body as NotificationPrefs));
    if (path === '/api/me/notification-prefs') return answer(get);
    throw new Error(`unexpected call ${path}`);
  });
}
const loaded = (prefs: NotificationPrefs = SAVED, timezone = 'Europe/Paris'): PrefsResponse => ({ prefs, timezone });
const putCalls = () => mockApi.mock.calls.filter(([p, o]) => p === '/api/me/notification-prefs' && o?.method === 'PUT');

function renderPage(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/notifications']}>
        <Routes>
          <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
          <Route path="/settings/security" element={<p>Security screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const group = (name: string) => screen.getByRole('radiogroup', { name });
const checkedIn = (name: string) => within(group(name)).getAllByRole<HTMLInputElement>('radio').find((r) => r.checked)?.value;
const choose = (row: string, label: string) => fireEvent.click(within(group(row)).getByRole('radio', { name: label }));

test('FR-5.2: the page shows the four rows with their descriptions, checked at the saved values, and the person\'s time zone in the digest line', async () => {
  serve(loaded());
  renderPage();
  expect(screen.getByRole('status').textContent).toBe('Loading');
  expect(screen.getByRole('heading', { name: 'Email notifications', level: 1 })).toBeTruthy();
  await screen.findByRole('button', { name: 'Save changes' });
  expect(mockApi).toHaveBeenCalledWith('/api/me/notification-prefs');
  expect(
    screen.getByText('Choose how you hear about each kind of notification. Every notification also appears in the app.'),
  ).toBeTruthy();

  const table = screen.getByRole('table');
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Notification', 'Instantly', 'Daily digest', 'Off']);
  const rowHeaders = within(table).getAllByRole('rowheader');
  expect(rowHeaders.map((h) => h.querySelector('.pref-name')?.textContent)).toEqual([...ROWS]);
  expect(rowHeaders.map((h) => h.querySelector('.pref-description')?.textContent)).toEqual([
    'Someone adds you to an item.',
    'Someone mentions you in a note.',
    "Someone changes the dates or milestones of an item you're assigned to.",
    "An end date or milestone of an item you're assigned to is 3 days away.",
  ]);
  for (const th of rowHeaders) expect(th.getAttribute('scope')).toBe('row');

  // One radio group per row, named by the row, with its three choices named by their column.
  for (const row of ROWS) {
    expect(within(group(row)).getAllByRole('radio').map((r) => r.getAttribute('aria-label') ?? r.closest('label')?.textContent)).toEqual([
      'Instantly',
      'Daily digest',
      'Off',
    ]);
  }
  expect(ROWS.map(checkedIn)).toEqual(['instant', 'off', 'digest', 'instant']);
  expect(group('Mentions').getAttribute('aria-describedby')).toBeTruthy();
  expect(document.getElementById(group('Mentions').getAttribute('aria-describedby')!)?.textContent).toBe('Someone mentions you in a note.');

  expect(
    screen.getByText('The daily digest arrives at 8 am in your time zone (Europe/Paris), on days with something in it.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save changes' }).getAttribute('type')).toBe('submit');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('FR-5.2: below 600 px each row is a fieldset with its radios stacked', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  serve(loaded());
  renderPage();
  await screen.findByRole('button', { name: 'Save changes' });
  expect(screen.queryByRole('table')).toBeNull();
  const groups = screen.getAllByRole('radiogroup');
  expect(groups.map((g) => g.tagName)).toEqual(['FIELDSET', 'FIELDSET', 'FIELDSET', 'FIELDSET']);
  expect(groups.map((g) => g.querySelector('legend')?.textContent)).toEqual([...ROWS]);
  const due = screen.getByRole('radiogroup', { name: 'Due soon' });
  expect(within(due).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Instantly', 'Daily digest', 'Off']);
  expect(within(due).getByRole('radio', { name: 'Instantly' })).toHaveProperty('checked', true);
  expect(document.getElementById(due.getAttribute('aria-describedby')!)?.textContent).toBe(
    "An end date or milestone of an item you're assigned to is 3 days away.",
  );
});

test('FR-5.2: "Save changes" sends all four values and says "Saved."; a failure says so and keeps the choices', async () => {
  let fail = true;
  let release: (v: unknown) => void = () => undefined;
  serve(loaded(), (body) => {
    if (fail) return new ApiError(500, 'unknown');
    return new Promise((resolve) => (release = () => resolve(loaded(body))));
  });
  const client = renderPage();
  await screen.findByRole('button', { name: 'Save changes' });

  choose('Assigned to you', 'Off');
  choose('Dates changed on your items', 'Instantly');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save your settings. Try again.");
  expect(ROWS.map(checkedIn)).toEqual(['off', 'off', 'instant', 'instant']);
  expect(screen.queryByText('Saved.')).toBeNull();

  // The next try works; a second press while it is on its way sends nothing more.
  fail = false;
  mockApi.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(putCalls()).toHaveLength(1));
  release(undefined);
  const status = await screen.findByText('Saved.');
  expect(status.getAttribute('role')).toBe('status');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(putCalls()).toEqual([
    ['/api/me/notification-prefs', { method: 'PUT', body: { assigned: 'off', mentioned: 'off', dates_changed: 'instant', due_soon: 'instant' } }],
  ]);
  expect(ROWS.map(checkedIn)).toEqual(['off', 'off', 'instant', 'instant']);
  expect(client.getQueryData(PREFS_KEY)).toEqual(loaded({ assigned: 'off', mentioned: 'off', dates_changed: 'instant', due_soon: 'instant' }));

  // A new choice clears "Saved." until the next save.
  choose('Due soon', 'Off');
  expect(screen.queryByText('Saved.')).toBeNull();
});

test('FR-5.2: leaving with unsaved changes asks first, as the item form does', async () => {
  serve(loaded(), (body) => loaded(body));
  renderPage();
  await screen.findByRole('button', { name: 'Save changes' });

  // Nothing changed: the link just goes, and leaving the site is not held up.
  const unload = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(unload()).toBe(false);

  choose('Mentions', 'Daily digest');
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Security' }));
  const dialog = await screen.findByRole('dialog', { name: 'Discard your unsaved changes?' });
  expect(screen.getByRole('heading', { name: 'Email notifications', level: 1 })).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(checkedIn('Mentions')).toBe('digest');

  // A click with a modifier key opens a new tab and is left alone.
  fireEvent.click(screen.getByRole('link', { name: 'Security' }), { metaKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('link', { name: 'Security' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your unsaved changes?' })).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByText('Security screen')).toBeTruthy();
  expect(putCalls()).toHaveLength(0);
});

test('FR-5.2: once saved, leaving does not ask', async () => {
  serve(loaded(), (body) => loaded(body));
  renderPage();
  await screen.findByRole('button', { name: 'Save changes' });
  choose('Mentions', 'Daily digest');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('Saved.');
  fireEvent.click(screen.getByRole('link', { name: 'Security' }));
  expect(await screen.findByText('Security screen')).toBeTruthy();
});

test('FR-5.2: settings that could not load say so, with "Try again"', async () => {
  let fail = true;
  mockApi.mockImplementation((path: string) => {
    if (path === '/api/notifications/unread-count') return Promise.resolve({ unread: 0 });
    return fail ? Promise.reject(new ApiError(500, 'unknown')) : Promise.resolve(loaded());
  });
  renderPage();
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again.');
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('radiogroup', { name: 'Assigned to you' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

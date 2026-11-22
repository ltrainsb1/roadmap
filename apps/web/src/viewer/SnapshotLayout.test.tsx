import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { content, LINK, locationOf, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
const startTitle = document.title;

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(() => {
  cleanup();
  document.title = startTitle;
});

test('FR-3.3: the header shows the roadmap name and "As of 12 Mar 2026", and the page title is "{roadmap name}: snapshot"', async () => {
  scriptApi(mockApi, {});
  const { unmount } = renderViewer(`/s/${LINK}/list`);
  expect(await screen.findByRole('heading', { level: 1, name: 'Launch plan' })).toBeTruthy();
  expect(screen.getByText('As of 12 Mar 2026')).toBeTruthy();
  expect(document.title).toBe('Launch plan: snapshot');
  const tabs = screen.getByRole('navigation', { name: 'View' });
  expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['List', 'Timeline']);
  expect(within(tabs).getByRole('link', { name: 'List' }).getAttribute('aria-current')).toBe('page');
  expect(within(tabs).getByRole('link', { name: 'Timeline' }).getAttribute('href')).toBe(`/s/${LINK}/timeline`);
  // No app header: no brand link, no account navigation.
  expect(screen.queryByRole('link', { name: 'Roadmap' })).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Account' })).toBeNull();
  unmount();
  expect(document.title).toBe(startTitle);
});

test('FR-3.3: the tabs keep the zoom in the address', async () => {
  scriptApi(mockApi, {});
  const { container } = renderViewer(`/s/${LINK}/timeline?zoom=weeks`);
  const tabs = await screen.findByRole('navigation', { name: 'View' });
  expect(within(tabs).getByRole('link', { name: 'Timeline' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(within(tabs).getByRole('link', { name: 'List' }));
  await waitFor(() => expect(locationOf(container)).toBe(`/s/${LINK}/list?zoom=weeks`));
});

test('FR-3.3: a snapshot with no items says so in both views', async () => {
  scriptApi(mockApi, { content: () => content({ items: [] }) });
  const list = renderViewer(`/s/${LINK}/list`);
  expect(await screen.findByText('This snapshot has no items.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  list.unmount();

  renderViewer(`/s/${LINK}/timeline`);
  expect(await screen.findByText('This snapshot has no items.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByLabelText('Zoom')).toBeNull();
});

test('FR-3.2: a session that ended returns to the password page with "Enter the password again to keep viewing.", then back to the same view', async () => {
  let open = false;
  scriptApi(mockApi, {
    content: () => (open ? content() : new ApiError(401, 'password_required')),
    unlock: () => {
      open = true;
      return undefined;
    },
  });
  const { container } = renderViewer(`/s/${LINK}/timeline?zoom=weeks`);
  expect(await screen.findByRole('heading', { level: 1, name: 'This snapshot is password protected' })).toBeTruthy();
  expect(locationOf(container)).toBe(`/s/${LINK}`);
  expect(screen.getByRole('alert').textContent).toBe('Enter the password again to keep viewing.');
  // Nothing about the roadmap is left on the page or in its title.
  expect(screen.queryByText('Launch plan')).toBeNull();
  expect(document.title).toBe(startTitle);

  fireEvent.change(screen.getByLabelText('Password', { exact: true }), { target: { value: 'a long enough password' } });
  fireEvent.click(screen.getByRole('button', { name: 'View snapshot' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Launch plan' })).toBeTruthy();
  expect(locationOf(container)).toBe(`/s/${LINK}/timeline?zoom=weeks`);
});

test('FR-3.2: a link revoked or expired while open shows its card when the content loads', async () => {
  scriptApi(mockApi, { content: () => new ApiError(404, 'not_found') });
  const gone = renderViewer(`/s/${LINK}/list`);
  expect(await screen.findByRole('heading', { level: 1, name: "This link doesn't work" })).toBeTruthy();
  gone.unmount();

  scriptApi(mockApi, { content: () => new ApiError(410, 'snapshot_expired') });
  renderViewer(`/s/${LINK}/timeline`);
  expect(await screen.findByRole('heading', { level: 1, name: 'This link has expired' })).toBeTruthy();
});

test('FR-3.3: while the content loads the page says so, and a failed load can be tried again', async () => {
  let fail = true;
  scriptApi(mockApi, { content: () => (fail ? new ApiError(500, 'unknown') : content()) });
  renderViewer(`/s/${LINK}/list`);
  expect(screen.getByRole('status').textContent).toBe('Loading');
  expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Try again.');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Launch plan' })).toBeTruthy();
});

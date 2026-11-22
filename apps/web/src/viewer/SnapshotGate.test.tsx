import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { content, LINK, locationOf, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
const PASSWORD = 'a long enough password';

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(cleanup);

const passwordField = () => screen.getByLabelText<HTMLInputElement>('Password', { exact: true });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'View snapshot' }));

test('FR-3.2: the gate shows the password page for a locked link, and the not-found and expired cards for 404 and 410, with no field on those', async () => {
  scriptApi(mockApi, { status: () => ({ unlocked: false }) });
  const first = renderViewer(`/s/${LINK}`);
  expect(await screen.findByRole('heading', { level: 1, name: 'This snapshot is password protected' })).toBeTruthy();
  expect(screen.getByText('Enter the password you were given.')).toBeTruthy();
  expect(passwordField().type).toBe('password');
  expect(passwordField().autocomplete).toBe('current-password');
  expect(screen.getByRole('button', { name: 'View snapshot' })).toBeTruthy();
  expect(screen.getByText("If you don't have the password, ask the person who sent you the link.")).toBeTruthy();
  // Nothing about the roadmap before the password is accepted: the content is never asked for.
  expect(mockApi.mock.calls.map(([path]) => path)).toEqual([`/api/snapshots/${LINK}`]);
  first.unmount();

  scriptApi(mockApi, { status: () => new ApiError(404, 'not_found') });
  const gone = renderViewer(`/s/${LINK}`);
  expect(await screen.findByRole('heading', { level: 1, name: "This link doesn't work" })).toBeTruthy();
  expect(screen.getByText('The snapshot may have been removed. Ask the person who sent it for a new link.')).toBeTruthy();
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  gone.unmount();

  scriptApi(mockApi, { status: () => new ApiError(410, 'snapshot_expired') });
  renderViewer(`/s/${LINK}`);
  expect(await screen.findByRole('heading', { level: 1, name: 'This link has expired' })).toBeTruthy();
  expect(screen.getByText('Ask the person who sent it for a new link.')).toBeTruthy();
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('FR-3.6: wrong_password, snapshot_locked and rate_limited each show their own message, and the field keeps focus', async () => {
  const answers = [new ApiError(401, 'wrong_password'), new ApiError(423, 'snapshot_locked'), new ApiError(429, 'rate_limited')];
  scriptApi(mockApi, { unlock: () => answers.shift() });
  renderViewer(`/s/${LINK}`);
  await screen.findByRole('heading', { name: 'This snapshot is password protected' });

  for (const message of [
    "That password isn't right.",
    'Too many wrong passwords. Try again in 15 minutes.',
    'Too many attempts. Wait a minute and try again.',
  ]) {
    fireEvent.change(passwordField(), { target: { value: PASSWORD } });
    submit();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.activeElement).toBe(passwordField());
  }
});

test('FR-3.2: an empty password is not sent, and says what to do', async () => {
  scriptApi(mockApi, {});
  renderViewer(`/s/${LINK}`);
  await screen.findByRole('heading', { name: 'This snapshot is password protected' });
  submit();
  expect((await screen.findByRole('alert')).textContent).toBe('Enter the password.');
  expect(document.activeElement).toBe(passwordField());
  expect(mockApi.mock.calls.map(([path]) => path)).toEqual([`/api/snapshots/${LINK}`]);
});

test('FR-3.2: the right password opens the list, keeps no password in the mutation cache, and a double press sends once', async () => {
  const calls = scriptApi(mockApi, { unlock: () => undefined, content: () => content() });
  const { container, client } = renderViewer(`/s/${LINK}`);
  await screen.findByRole('heading', { name: 'This snapshot is password protected' });
  fireEvent.change(passwordField(), { target: { value: PASSWORD } });
  submit();
  submit();
  const heading = await screen.findByRole('heading', { level: 1, name: 'Launch plan' });
  expect(locationOf(container)).toBe(`/s/${LINK}/list`);
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(calls.filter((p) => p.endsWith('/unlock'))).toHaveLength(1);
  const held = client
    .getMutationCache()
    .getAll()
    .some((m) => JSON.stringify(m.state.variables ?? null).includes(PASSWORD));
  expect(held).toBe(false);
});

test('FR-3.2: a link that is already open goes straight to the list', async () => {
  scriptApi(mockApi, { status: () => ({ unlocked: true }) });
  const { container } = renderViewer(`/s/${LINK}`);
  await screen.findByRole('heading', { level: 1, name: 'Launch plan' });
  expect(locationOf(container)).toBe(`/s/${LINK}/list`);
  // Not a fresh unlock, so the heading does not take focus.
  expect(document.activeElement).toBe(document.body);
});

test('FR-3.2: a link revoked while the password page was open shows the not-found card on submit', async () => {
  scriptApi(mockApi, { unlock: () => new ApiError(404, 'not_found') });
  renderViewer(`/s/${LINK}`);
  await screen.findByRole('heading', { name: 'This snapshot is password protected' });
  fireEvent.change(passwordField(), { target: { value: PASSWORD } });
  submit();
  expect(await screen.findByRole('heading', { level: 1, name: "This link doesn't work" })).toBeTruthy();
  expect(screen.queryByLabelText('Password')).toBeNull();
});

test('FR-3.2: a failed status check says so and tries again', async () => {
  let fail = true;
  scriptApi(mockApi, { status: () => (fail ? new ApiError(500, 'unknown') : { unlocked: false }) });
  renderViewer(`/s/${LINK}`);
  expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Try again.');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'This snapshot is password protected' })).toBeTruthy();
});

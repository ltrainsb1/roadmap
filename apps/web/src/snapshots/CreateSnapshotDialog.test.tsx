import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { CreateSnapshotDialog } from './CreateSnapshotDialog.tsx';
import { endOfLocalDay, snapshotUrl } from './useSnapshots.ts';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);
const startTz = process.env.TZ;
const PASSWORD = 'a long enough secret';

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
});

function renderDialog(onClose = vi.fn(), open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <CreateSnapshotDialog roadmapId="r1" open={isOpen} onClose={onClose} />
    </QueryClientProvider>
  );
  const { rerender } = render(tree(open));
  return {
    dialog: open ? screen.getByRole('dialog', { name: 'Create a snapshot' }) : document.body,
    onClose,
    client,
    setOpen: (isOpen: boolean) => rerender(tree(isOpen)),
  };
}

/** Whether any mutation the query client still holds carries `text` in what it was sent. */
const cacheHolds = (client: QueryClient, text: string) =>
  client
    .getMutationCache()
    .getAll()
    .some((m) => JSON.stringify(m.state.variables ?? null).includes(text));

const input = (dialog: HTMLElement, label: string) => within(dialog).getByLabelText<HTMLInputElement>(label, { exact: true });
const type = (dialog: HTMLElement, label: string, value: string) => fireEvent.change(input(dialog, label), { target: { value } });
const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Create snapshot' }));
const errorOf = (dialog: HTMLElement, label: string) => {
  const ids = input(dialog, label).getAttribute('aria-describedby') ?? '';
  return ids
    .split(' ')
    .map((id) => document.getElementById(id))
    .find((el) => el?.classList.contains('field-error'))?.textContent;
};

function fillValid(dialog: HTMLElement) {
  type(dialog, 'Name', 'Board pack');
  type(dialog, 'Password', PASSWORD);
}

test('FR-3.1: the form refuses an empty name, a short password, a future as-of date and an expiry that is not after today, each with its message, and sends nothing', () => {
  const { dialog } = renderDialog();
  expect(input(dialog, 'As of').value).toBe('2027-01-15');
  expect(input(dialog, 'As of').max).toBe('2027-01-15');

  type(dialog, 'Password', 'too short');
  type(dialog, 'As of', '2027-01-16');
  fireEvent.click(within(dialog).getByLabelText('On a date'));
  type(dialog, 'Expiry date', '2027-01-15');
  submit(dialog);

  expect(errorOf(dialog, 'Name')).toBe('Enter a name.');
  expect(errorOf(dialog, 'Password')).toBe('Use at least 10 characters.');
  expect(errorOf(dialog, 'As of')).toBe('Choose today or an earlier date.');
  expect(errorOf(dialog, 'Expiry date')).toBe('Choose a date after today.');
  expect(document.activeElement).toBe(input(dialog, 'Name'));

  // No date chosen is no later date either.
  type(dialog, 'Expiry date', '');
  submit(dialog);
  expect(errorOf(dialog, 'Expiry date')).toBe('Choose a date after today.');

  // More than 730 days ahead.
  fillValid(dialog);
  type(dialog, 'As of', '2027-01-15');
  type(dialog, 'Expiry date', '2029-01-15');
  submit(dialog);
  expect(errorOf(dialog, 'Expiry date')).toBe('Choose a date within two years.');
  expect(errorOf(dialog, 'Name')).toBeUndefined();
  expect(errorOf(dialog, 'Password')).toBeUndefined();
  expect(errorOf(dialog, 'As of')).toBeUndefined();

  expect(mockApi).not.toHaveBeenCalled();
});

test('FR-3.5: both Include boxes start unticked and the request carries what was ticked', async () => {
  mockApi.mockResolvedValue({ id: 's1', linkId: 'link-1' });
  const { dialog } = renderDialog();
  const notes = input(dialog, 'Notes');
  const assignees = input(dialog, 'Assignee names');
  expect(notes.checked).toBe(false);
  expect(assignees.checked).toBe(false);
  expect(within(dialog).getByText("Notes are shown with their authors' names. Files are never included.").id).toBe(
    notes.getAttribute('aria-describedby'),
  );
  expect(input(dialog, 'Never').checked).toBe(true);
  expect(within(dialog).queryByLabelText('Expiry date')).toBeNull();

  fillValid(dialog);
  fireEvent.click(assignees);
  fireEvent.click(within(dialog).getByLabelText('On a date'));
  type(dialog, 'Expiry date', '2027-02-01');
  submit(dialog);

  await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(1));
  expect(mockApi).toHaveBeenCalledWith('/api/roadmaps/r1/snapshots', {
    body: {
      name: 'Board pack',
      asOf: '2027-01-15',
      password: PASSWORD,
      expiresAt: endOfLocalDay('2027-02-01'),
      include: { notes: false, assignees: true },
    },
  });
});

test('FR-3.2: after creating, the dialog shows the link and never shows the password again', async () => {
  mockApi.mockResolvedValue({ id: 's1', linkId: 'link-1' });
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const { dialog, onClose } = renderDialog();
  fillValid(dialog);
  // Shown while typing, the password is still never shown after.
  fireEvent.click(within(dialog).getByLabelText('Show password'));
  expect(input(dialog, 'Password').type).toBe('text');
  submit(dialog);

  const created = await screen.findByRole('dialog', { name: 'Snapshot created' });
  const heading = within(created).getByRole('heading', { name: 'Snapshot created' });
  expect(document.activeElement).toBe(heading);
  expect(within(created).getByText('Send this link to the people who should see it. Send the password separately.')).toBeTruthy();
  const link = input(created, 'Link');
  expect(link.value).toBe(snapshotUrl('link-1'));
  expect(link.readOnly).toBe(true);
  expect(within(created).queryByLabelText('Password')).toBeNull();
  expect(within(created).queryByDisplayValue(PASSWORD)).toBeNull();
  expect(created.textContent).not.toContain(PASSWORD);

  fireEvent.click(within(created).getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(within(created).getByRole('status').textContent).toBe('Link copied.'));
  expect(writeText).toHaveBeenCalledWith(snapshotUrl('link-1'));

  writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  fireEvent.click(within(created).getByRole('button', { name: 'Copy link' }));
  await waitFor(() =>
    expect(within(created).getByRole('alert').textContent).toBe("Couldn't copy the link. Select it and copy it yourself."),
  );
  expect(within(created).getByRole('status').textContent).toBe('');

  fireEvent.click(within(created).getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
});

test('FR-3.1: too_many_snapshots and too_many_notes show their own messages in the dialog and keep what was typed', async () => {
  mockApi.mockRejectedValueOnce(new ApiError(422, 'too_many_snapshots'));
  const { dialog } = renderDialog();
  fillValid(dialog);
  fireEvent.click(input(dialog, 'Notes'));
  submit(dialog);

  await waitFor(() =>
    expect(within(dialog).getByRole('alert').textContent).toBe('This roadmap already has 50 snapshots. Revoke one to create another.'),
  );
  expect(document.activeElement).toBe(within(dialog).getByRole('alert'));
  expect(input(dialog, 'Name').value).toBe('Board pack');
  expect(input(dialog, 'Password').value).toBe(PASSWORD);
  expect(input(dialog, 'Notes').checked).toBe(true);

  mockApi.mockRejectedValueOnce(new ApiError(422, 'too_many_notes'));
  submit(dialog);
  await waitFor(() =>
    expect(within(dialog).getByRole('alert').textContent).toBe('This roadmap has more than 5,000 notes. Create the snapshot without notes.'),
  );
  expect(input(dialog, 'Name').value).toBe('Board pack');
  expect(screen.queryByRole('dialog', { name: 'Snapshot created' })).toBeNull();
});

test('FR-3.2: once a snapshot is created, the password is gone from the mutation cache', async () => {
  mockApi.mockResolvedValue({ id: 's1', linkId: 'link-1' });
  const { dialog, client, onClose, setOpen } = renderDialog();
  fillValid(dialog);
  submit(dialog);
  const created = await screen.findByRole('dialog', { name: 'Snapshot created' });
  await waitFor(() => expect(cacheHolds(client, PASSWORD)).toBe(false));

  fireEvent.click(within(created).getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
  setOpen(false);
  expect(cacheHolds(client, PASSWORD)).toBe(false);
});

test('FR-3.2: after a refused create the form keeps the password, and closing leaves none in the mutation cache', async () => {
  mockApi.mockRejectedValue(new ApiError(422, 'too_many_snapshots'));
  const { dialog, client, setOpen } = renderDialog();
  fillValid(dialog);
  submit(dialog);
  await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
  expect(input(dialog, 'Password').value).toBe(PASSWORD);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  setOpen(false);
  await waitFor(() => expect(cacheHolds(client, PASSWORD)).toBe(false));
});

test('FR-3.1: the as-of date and its limit are today at the time the dialog opens, not when the page loaded', () => {
  // The page loads late on the 15th and is left open past midnight.
  vi.setSystemTime(new Date('2027-01-15T23:30:00Z'));
  const { setOpen } = renderDialog(vi.fn(), false);
  vi.setSystemTime(new Date('2027-01-16T08:00:00Z'));
  setOpen(true);
  const dialog = screen.getByRole('dialog', { name: 'Create a snapshot' });
  expect(input(dialog, 'As of').value).toBe('2027-01-16');
  expect(input(dialog, 'As of').max).toBe('2027-01-16');
  fireEvent.click(within(dialog).getByLabelText('On a date'));
  expect(input(dialog, 'Expiry date').min).toBe('2027-01-17');
});

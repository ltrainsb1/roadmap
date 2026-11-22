import type { Attachment, Project } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError, upload } from '../api/client.ts';
import { formatWhen } from '../audit/dates.ts';
import { AttachmentsSection, uploadErrorMessage } from './AttachmentsSection.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
  upload: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockUpload = vi.mocked(upload);

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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  mockApi.mockReset();
  mockUpload.mockReset();
});

const ARCHIVED = "This item is archived, so notes and files can't be added or changed.";
const MB25 = 25 * 1024 * 1024;

const item = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  parentId: null,
  depth: 1,
  path: [],
  title: 'Launch site',
  description: '',
  status: 'not_started',
  startDate: null,
  endDate: null,
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  assigneeIds: [],
  rank: 1,
  priorityLabel: null,
  archived: false,
  version: 1,
  updatedAt: '2027-01-01T00:00:00.000Z',
  ...over,
});

const attachment = (over: Partial<Attachment> & Pick<Attachment, 'id' | 'name'>): Attachment => ({
  projectId: 'p1',
  size: 1536,
  uploadedById: 'u2',
  uploadedByName: 'Bob',
  createdAt: '2027-03-04T15:06:00.000Z',
  ...over,
});

/** Answers the file list with `files` (read on every call), and other api calls with `answer`. */
function serve(files: () => Attachment[], answer: (method: string, path: string) => Promise<unknown> = () => Promise.resolve(undefined)) {
  mockApi.mockImplementation((path: string, opts = {}) => {
    const method = opts.method ?? 'GET';
    if (method === 'GET' && path.endsWith('/attachments')) return Promise.resolve({ attachments: files() });
    return answer(method, path);
  });
}

function show(opts: { editable?: boolean; archived?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const tree = (o: typeof opts) => (
    <QueryClientProvider client={client}>
      <AttachmentsSection roadmapId="r1" item={item({ archived: o.archived ?? false })} editable={o.editable ?? true} timeZone="UTC" />
    </QueryClientProvider>
  );
  const view = render(tree(opts));
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
  /** Shows the section again as a refetch of the item would. */
  const refresh = (o: typeof opts) => view.rerender(tree(o));
  return { client, invalidate, input, refresh };
}

const fileOf = (name: string, size: number) => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const choose = (input: HTMLInputElement | null, files: File[]) => {
  if (!input) throw new Error('no file input');
  fireEvent.change(input, { target: { files } });
};
const alertText = () => screen.getByRole('alert').textContent;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AttachmentsSection', () => {
  test('FR-1.4: lists files oldest first; the second line is "{size} · {person} · {date and time}"', async () => {
    serve(() => [attachment({ id: 'a1', name: 'plan.pdf' }), attachment({ id: 'a2', name: 'notes.txt', size: 12, uploadedByName: 'Ann' })]);
    show();
    await screen.findByRole('button', { name: 'Download plan.pdf' });
    const rows = within(screen.getByRole('list', { name: 'Files' })).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getAllByRole('button')[0]!.textContent)).toEqual(['plan.pdf', 'notes.txt']);
    const meta = rows[0]!.querySelector('.file-meta')!;
    expect(meta.textContent).toBe(`1.5 KB · Bob · ${formatWhen('2027-03-04T15:06:00.000Z', 'UTC')}`);
    expect(meta.querySelector('time')?.getAttribute('datetime')).toBe('2027-03-04T15:06:00.000Z');
    expect(rows[1]!.querySelector('.file-meta')!.textContent).toMatch(/^12 B · Ann · /);
    expect(within(rows[0]!).getByRole('button', { name: 'Remove plan.pdf' }).textContent).toBe('Remove');
    expect(screen.getByRole('button', { name: 'Add file' })).toBeTruthy();
    expect(screen.getByText('Up to 25 MB each.')).toBeTruthy();
  });

  test('FR-1.4: with no files it says so', async () => {
    serve(() => []);
    show();
    expect(await screen.findByText('No files yet.')).toBeTruthy();
  });

  test('FR-1.4: someone who can\'t edit the item sees the files and Download, but no "Add file" or "Remove"', async () => {
    serve(() => [attachment({ id: 'a1', name: 'plan.pdf' })]);
    const { input } = show({ editable: false });
    await screen.findByRole('button', { name: 'Download plan.pdf' });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['plan.pdf']);
    expect(input).toBeNull();
    expect(screen.queryByText('Up to 25 MB each.')).toBeNull();
    expect(screen.queryByText(ARCHIVED)).toBeNull();
  });

  test('FR-1.4: an archived item lists its files with the archived message, and no "Add file" or "Remove"', async () => {
    serve(() => [attachment({ id: 'a1', name: 'plan.pdf' })]);
    const { input } = show({ editable: true, archived: true });
    await screen.findByRole('button', { name: 'Download plan.pdf' });
    expect(screen.getByText(ARCHIVED)).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['plan.pdf']);
    expect(input).toBeNull();
  });

  test('FR-1.4: "Add file" opens the hidden file input, which takes several files', async () => {
    serve(() => []);
    const { input } = show();
    await screen.findByText('No files yet.');
    expect(input?.multiple).toBe(true);
    expect(input?.tabIndex).toBe(-1);
    const click = vi.spyOn(input!, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
    expect(click).toHaveBeenCalledOnce();
  });

  test.each([
    [MB25 + 1, 'big.bin is larger than 25 MB.'],
    [0, 'big.bin is empty.'],
  ])('FR-1.4: a file of %i bytes is refused in the browser with its message, and nothing is sent', async (size, message) => {
    serve(() => []);
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('big.bin', size)]);
    await waitFor(() => expect(alertText()).toBe(message));
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockApi).toHaveBeenCalledTimes(1);
    // Reset, so the same file can be chosen again.
    expect(input!.value).toBe('');
  });

  test('FR-1.4: a file of exactly 25 MB is sent', async () => {
    serve(() => []);
    mockUpload.mockResolvedValue(attachment({ id: 'a1', name: 'edge.bin', size: MB25 }));
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('edge.bin', MB25)]);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledOnce());
    expect(mockUpload.mock.calls[0]![0]).toBe('/api/roadmaps/r1/projects/p1/attachments');
  });

  test.each([
    ['file_too_large', 413, 'a.txt is larger than 25 MB.'],
    ['empty_file', 422, 'a.txt is empty.'],
    ['file_infected', 422, 'a.txt was blocked because it failed the virus check.'],
    ['scan_unavailable', 503, "Files can't be checked right now. Try again in a few minutes."],
    ['too_many_files', 422, 'This item already has 20 files. Remove one to add another.'],
    ['item_archived', 409, ARCHIVED],
    ['uploads_busy', 503, "Couldn't add a.txt. Try again."],
    ['upload_timeout', 408, "Couldn't add a.txt. Try again."],
    ['not_found', 404, "Couldn't add a.txt. Try again."],
    ['validation', 400, "Couldn't add a.txt. Try again."],
  ])('FR-1.4: uploadErrorMessage maps %s', (code, status, message) => {
    expect(uploadErrorMessage(new ApiError(status, code), 'a.txt')).toBe(message);
  });

  test('FR-1.4: a network failure is the generic upload message', () => {
    expect(uploadErrorMessage(new TypeError('offline'), 'a.txt')).toBe("Couldn't add a.txt. Try again.");
  });

  test('FR-1.4: an upload shows "Uploading {name}…" in a polite live region, then the new row', async () => {
    let files: Attachment[] = [];
    serve(() => files);
    const sent = deferred<Attachment>();
    mockUpload.mockReturnValue(sent.promise);
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('report.txt', 10)]);
    const uploading = await screen.findByText('Uploading report.txt…');
    expect(uploading.closest('[aria-live="polite"]')).toBeTruthy();
    expect(screen.queryByText('No files yet.')).toBeNull();
    const added = attachment({ id: 'a1', name: 'report.txt', size: 10 });
    files = [added];
    await act(async () => {
      sent.resolve(added);
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'Download report.txt' })).toBeTruthy();
    expect(screen.queryByText('Uploading report.txt…')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('FR-1.4: several files upload one after another, and one failure does not stop the rest', async () => {
    serve(() => []);
    const first = deferred<Attachment>();
    const second = deferred<Attachment>();
    mockUpload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(attachment({ id: 'a3', name: 'c.txt' }));
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('a.txt', 5), fileOf('huge.bin', MB25 + 1), fileOf('b.txt', 5), fileOf('c.txt', 5)]);
    await screen.findByText('Uploading a.txt…');
    expect(mockUpload).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(attachment({ id: 'a1', name: 'a.txt' }));
      await Promise.resolve();
    });
    await screen.findByText('Uploading b.txt…');
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect((mockUpload.mock.calls[1]![1]).name).toBe('b.txt');
    await act(async () => {
      second.reject(new ApiError(422, 'file_infected'));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(3));
    expect((mockUpload.mock.calls[2]![1]).name).toBe('c.txt');
    await waitFor(() => expect(screen.queryByText(/^Uploading/)).toBeNull());
    const alert = screen.getByRole('alert');
    expect(within(alert).getAllByRole('paragraph').map((p) => p.textContent)).toEqual([
      'huge.bin is larger than 25 MB.',
      'b.txt was blocked because it failed the virus check.',
    ]);
  });

  test('FR-1.4: a refused file\'s message stays until the next upload starts', async () => {
    serve(() => []);
    mockUpload.mockRejectedValueOnce(new ApiError(503, 'scan_unavailable')).mockReturnValueOnce(new Promise(() => undefined));
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('a.txt', 5)]);
    await waitFor(() => expect(alertText()).toBe("Files can't be checked right now. Try again in a few minutes."));
    choose(input, [fileOf('b.txt', 5)]);
    await screen.findByText('Uploading b.txt…');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('FR-1.4: an upload refused because the item was archived says so and refreshes the item', async () => {
    serve(() => []);
    mockUpload.mockRejectedValue(new ApiError(409, 'item_archived'));
    const { input, invalidate } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('a.txt', 5), fileOf('b.txt', 5)]);
    await waitFor(() => expect(alertText()).toBe(ARCHIVED));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'r1'] });
    // The rest can't be added either, so they are not sent.
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  test('FR-1.4: an upload refused because the item is gone sends none of the rest and refreshes the item', async () => {
    serve(() => []);
    mockUpload.mockRejectedValue(new ApiError(404, 'not_found'));
    const { input, invalidate } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('a.txt', 5), fileOf('b.txt', 5), fileOf('c.txt', 5)]);
    await waitFor(() => expect(alertText()).toBe("Couldn't add a.txt. Try again."));
    await waitFor(() => expect(screen.queryByText(/^Uploading/)).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'r1'] });
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  test('FR-1.4: the same message from several files shows once', async () => {
    serve(() => []);
    mockUpload.mockRejectedValue(new ApiError(503, 'scan_unavailable'));
    const { input } = show();
    await screen.findByText('No files yet.');
    choose(input, [fileOf('a.txt', 5), fileOf('b.txt', 5)]);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/^Uploading/)).toBeNull());
    expect(within(screen.getByRole('alert')).getAllByRole('paragraph')).toHaveLength(1);
  });

  test('FR-1.4: Download asks for the link, then goes to it', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(
      () => [attachment({ id: 'a1', name: 'plan.pdf' })],
      (method, path) => {
        expect([method, path]).toEqual(['GET', '/api/roadmaps/r1/projects/p1/attachments/a1/download']);
        return Promise.resolve({ url: '/api/files/local?token=t' });
      },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/files/local?token=t'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('FR-1.4: a download whose file is gone refreshes the list and says it couldn\'t download', async () => {
    let files = [attachment({ id: 'a1', name: 'plan.pdf' })];
    serve(
      () => files,
      () => {
        files = [];
        return Promise.reject(new ApiError(404, 'not_found'));
      },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
    await waitFor(() => expect(alertText()).toBe("Couldn't download plan.pdf. Try again."));
    expect(await screen.findByText('No files yet.')).toBeTruthy();
  });

  test('FR-1.4: any other download failure says it couldn\'t download', async () => {
    serve(
      () => [attachment({ id: 'a1', name: 'plan.pdf' })],
      () => Promise.reject(new ApiError(500, 'unknown')),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
    await waitFor(() => expect(alertText()).toBe("Couldn't download plan.pdf. Try again."));
  });

  test('FR-1.4: Remove asks first; "Remove file" removes the row and focus moves to the next Remove', async () => {
    let files = [attachment({ id: 'a1', name: 'one.txt' }), attachment({ id: 'a2', name: 'two.txt' })];
    const calls: string[] = [];
    serve(
      () => files,
      (method, path) => {
        calls.push(`${method} ${path}`);
        files = files.filter((f) => !path.endsWith(`/${f.id}`));
        return Promise.resolve(undefined);
      },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove one.txt' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove one.txt?' });
    expect(dialog.textContent).toContain('The file is deleted for everyone.');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Download one.txt' })).toBeNull());
    expect(calls).toEqual(['DELETE /api/roadmaps/r1/projects/p1/attachments/a1']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove two.txt' })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('FR-1.4: removing the last file moves focus to the one before it, then to "Add file"', async () => {
    let files = [attachment({ id: 'a1', name: 'one.txt' }), attachment({ id: 'a2', name: 'two.txt' })];
    serve(
      () => files,
      (_m, path) => {
        files = files.filter((f) => !path.endsWith(`/${f.id}`));
        return Promise.resolve(undefined);
      },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove two.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove one.txt' })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove one.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add file' })));
    expect(screen.getByText('No files yet.')).toBeTruthy();
  });

  test('FR-1.4: removing a file someone else already removed counts as removed', async () => {
    let files = [attachment({ id: 'a1', name: 'one.txt' })];
    serve(
      () => files,
      () => {
        files = [];
        return Promise.reject(new ApiError(404, 'not_found'));
      },
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove one.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add file' })));
    expect(screen.getByText('No files yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('FR-1.4: a remove refused because the item was archived says so in the dialog and refreshes the item', async () => {
    serve(
      () => [attachment({ id: 'a1', name: 'one.txt' })],
      () => Promise.reject(new ApiError(409, 'item_archived')),
    );
    const { invalidate } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove one.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove file' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(ARCHIVED));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'r1'] });
    expect(screen.getByRole('button', { name: 'Download one.txt' })).toBeTruthy();
  });

  test('FR-1.4: any other failed remove says so in the dialog and keeps the row', async () => {
    serve(
      () => [attachment({ id: 'a1', name: 'one.txt' })],
      () => Promise.reject(new ApiError(500, 'unknown')),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove one.txt' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Something went wrong. Try again.'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download one.txt' })).toBeTruthy();
  });

  test('FR-1.4: a failed load says so, and Try again loads the files', async () => {
    mockApi.mockRejectedValue(new ApiError(500, 'unknown'));
    show();
    // The list is tried twice before it gives up.
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toContain("Couldn't load files. Try again.");
    serve(() => [attachment({ id: 'a1', name: 'plan.pdf' })]);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Download plan.pdf' })).toBeTruthy();
  });

  test.each([
    ['a javascript: link', 'javascript:alert(1)'],
    ['a data: link', 'data:text/html,<p>hi</p>'],
  ])('FR-1.4: a download link that is %s is not followed, and the download says it failed', async (_what, url) => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(
      () => [attachment({ id: 'a1', name: 'plan.pdf' })],
      () => Promise.resolve({ url }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
    await waitFor(() => expect(alertText()).toBe("Couldn't download plan.pdf. Try again."));
    expect(assign).not.toHaveBeenCalled();
  });

  test.each(['/api/files/local?token=abc', 'https://files.example.com/key?X-Amz-Signature=s'])(
    'FR-1.4: a download link %s is followed',
    async (url) => {
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, assign });
      serve(
        () => [attachment({ id: 'a1', name: 'plan.pdf' })],
        () => Promise.resolve({ url }),
      );
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(url));
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  test('FR-1.4: an upload refused as forbidden says so and refreshes the item and the role; focus moves to the heading once "Add file" goes', async () => {
    serve(() => []);
    mockUpload.mockRejectedValue(new ApiError(403, 'forbidden'));
    const { input, invalidate, refresh } = show();
    await screen.findByText('No files yet.');
    screen.getByRole('button', { name: 'Add file' }).focus();
    choose(input, [fileOf('a.txt', 5)]);
    await waitFor(() => expect(alertText()).toBe("Couldn't add a.txt. Try again."));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'r1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['roadmaps'] });
    refresh({ editable: false });
    expect(screen.queryByRole('button', { name: 'Add file' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Files' }));
  });

  test('FR-1.4: when an upload refused as archived hides "Add file", focus moves to the Files heading', async () => {
    serve(() => []);
    mockUpload.mockRejectedValue(new ApiError(409, 'item_archived'));
    const { input, refresh } = show();
    await screen.findByText('No files yet.');
    screen.getByRole('button', { name: 'Add file' }).focus();
    choose(input, [fileOf('a.txt', 5)]);
    await waitFor(() => expect(alertText()).toBe(ARCHIVED));
    refresh({ archived: true });
    const heading = screen.getByRole('heading', { name: 'Files' });
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  test('FR-1.4: a remove refused as forbidden says so, refreshes the item and the role, and focus goes to the heading after the dialog', async () => {
    serve(
      () => [attachment({ id: 'a1', name: 'one.txt' })],
      () => Promise.reject(new ApiError(403, 'forbidden')),
    );
    const { invalidate, refresh } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove one.txt' }));
    const dialog = screen.getByRole('dialog');
    within(dialog).getByRole('button', { name: 'Remove file' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Something went wrong. Try again.'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'r1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['roadmaps'] });
    refresh({ editable: false });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Remove one.txt' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Files' }));
  });
});

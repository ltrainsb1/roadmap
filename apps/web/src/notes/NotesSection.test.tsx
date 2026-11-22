import type { Note, Project, Role } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { NotesSection, noteErrorMessage } from './NotesSection.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

// Counts how often a note's Markdown is parsed, to show typing does not re-render the notes already shown.
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Real = actual.default;
  return {
    ...actual,
    default: (props: Parameters<typeof Real>[0]) => {
      renders.count += 1;
      return <Real {...props} />;
    },
  };
});

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
afterEach(cleanup);
beforeEach(() => {
  mockApi.mockReset();
  renders.count = 0;
});

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

let seq = 0;
const note = (over: Partial<Note> & Pick<Note, 'id' | 'body'>): Note => ({
  projectId: 'p1',
  parentId: null,
  authorId: 'u2',
  authorName: 'Bob',
  mentions: [],
  createdAt: `2027-01-01T10:${String(seq++ % 60).padStart(2, '0')}:00.000Z`,
  editedAt: null,
  deleted: false,
  ...over,
});

const ME = 'u1';

/** Answers the notes list with `notes`, and other calls with `answer`. */
function serve(notes: Note[], answer: (method: string, path: string, body: unknown) => Promise<unknown> = () => Promise.resolve(undefined)) {
  mockApi.mockImplementation((path: string, opts = {}) => {
    const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
    if (method === 'GET') return Promise.resolve({ notes });
    return answer(method, path, opts.body);
  });
}

function show(opts: { role?: Role; archived?: boolean; onDraftChange?: (hasText: boolean) => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDraftChange = opts.onDraftChange ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <NotesSection
        roadmapId="r1"
        item={item({ archived: opts.archived ?? false })}
        role={opts.role ?? 'contributor'}
        myId={ME}
        members={[]}
        timeZone="UTC"
        onDraftChange={onDraftChange}
      />
    </QueryClientProvider>,
  );
  return { onDraftChange };
}

const articleWith = (text: string) => {
  const found = screen.getAllByRole('article').find((a) => a.textContent.includes(text));
  if (!found) throw new Error(`no note with ${text}`);
  return found;
};
const buttonsIn = (el: HTMLElement) => within(el).queryAllByRole('button').map((b) => b.textContent);
const newBox = () => screen.getByRole('textbox', { name: 'Add a note' });
const valueOf = (el: HTMLElement) => (el as HTMLTextAreaElement).value;

describe('NotesSection', () => {
  test('FR-1.5: threads show oldest first with their replies nested under them, in order', async () => {
    serve([
      note({ id: 'n1', body: 'First' }),
      note({ id: 'r1', parentId: 'n1', body: 'Reply one', authorId: ME, authorName: 'Ann' }),
      note({ id: 'n2', body: 'Second' }),
      note({ id: 'r2', parentId: 'n1', body: 'Reply two' }),
    ]);
    show();
    await screen.findByText('First');
    const threads = screen.getByRole('list', { name: 'Notes' });
    const tops = within(threads).getAllByRole('listitem').filter((li) => li.parentElement === threads);
    expect(tops).toHaveLength(2);
    expect(within(tops[0]!).getAllByRole('article').map((a) => a.querySelector('.markdown')?.textContent)).toEqual([
      'First',
      'Reply one',
      'Reply two',
    ]);
    expect(within(tops[1]!).getAllByRole('article')).toHaveLength(1);
    expect(articleWith('Reply one').closest('ol')?.classList.contains('note-replies')).toBe(true);
    expect(articleWith('Reply one').textContent).toContain('Ann');
    const time = articleWith('First').querySelector('time');
    expect(time?.getAttribute('datetime')).toMatch(/^2027-01-01T10:/);
  });

  test('FR-1.5: an edited note shows "Edited"', async () => {
    serve([note({ id: 'n1', body: 'Changed', editedAt: '2027-01-02T10:00:00.000Z' }), note({ id: 'n2', body: 'Same' })]);
    show();
    await screen.findByText('Changed');
    expect(within(articleWith('Changed')).getByText('Edited')).toBeTruthy();
    expect(within(articleWith('Same')).queryByText('Edited')).toBeNull();
  });

  test('FR-1.5: a deleted note with replies shows "This note was deleted." with no Reply, Edit or Delete', async () => {
    serve([
      note({ id: 'n1', body: '', deleted: true, authorId: ME }),
      note({ id: 'r1', parentId: 'n1', body: 'Still here', authorId: ME }),
    ]);
    show({ role: 'owner' });
    const gone = (await screen.findByText('This note was deleted.')).closest('article')!;
    expect(buttonsIn(gone)).toEqual([]);
    expect(buttonsIn(articleWith('Still here'))).toEqual(['Reply', 'Edit', 'Delete']);
  });

  test('FR-1.5: Edit shows only on my notes; a Contributor deletes only their own', async () => {
    serve([note({ id: 'n1', body: 'Mine', authorId: ME }), note({ id: 'n2', body: 'Theirs' })]);
    show({ role: 'contributor' });
    await screen.findByText('Mine');
    expect(buttonsIn(articleWith('Mine'))).toEqual(['Reply', 'Edit', 'Delete']);
    expect(buttonsIn(articleWith('Theirs'))).toEqual(['Reply']);
  });

  test.each<Role>(['owner', 'admin'])('FR-1.5: the %s can delete anyone\'s note but edit only their own', async (role) => {
    serve([note({ id: 'n1', body: 'Mine', authorId: ME }), note({ id: 'n2', body: 'Theirs' })]);
    show({ role });
    await screen.findByText('Mine');
    expect(buttonsIn(articleWith('Mine'))).toEqual(['Reply', 'Edit', 'Delete']);
    expect(buttonsIn(articleWith('Theirs'))).toEqual(['Reply', 'Delete']);
  });

  test('FR-1.5: an archived item shows its notes and the archived message, with no boxes or controls', async () => {
    serve([note({ id: 'n1', body: 'Old note', authorId: ME })]);
    show({ role: 'owner', archived: true });
    await screen.findByText('Old note');
    expect(screen.getByText('This item is archived, so notes and files can\'t be added or changed.')).toBeTruthy();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  test('FR-1.5: with no notes it says so', async () => {
    serve([]);
    show();
    expect(await screen.findByText('No notes yet.')).toBeTruthy();
    expect(screen.getByText('You can use Markdown. Type @ to mention someone.')).toBeTruthy();
  });

  test('FR-1.5: a failed load says so, and Try again loads the notes', async () => {
    mockApi.mockRejectedValue(new ApiError(500, 'unknown'));
    show();
    // The list is tried twice before it gives up.
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toContain("Couldn't load notes. Try again.");
    serve([note({ id: 'n1', body: 'Loaded' })]);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Loaded')).toBeTruthy();
  });

  test('FR-1.5: adding a note empties the box, keeps focus there and announces "Note added."', async () => {
    const added = note({ id: 'n9', body: 'Fresh', authorId: ME, authorName: 'Ann' });
    serve([], (method, path, body) => {
      expect(method).toBe('POST');
      expect(path).toBe('/api/roadmaps/r1/projects/p1/notes');
      expect(body).toEqual({ body: 'Fresh', mentionIds: [], parentId: null });
      return Promise.resolve(added);
    });
    const { onDraftChange } = show();
    await screen.findByText('No notes yet.');
    fireEvent.change(newBox(), { target: { value: 'Fresh' } });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect((await screen.findByText('Note added.')).getAttribute('aria-live')).toBe('polite');
    expect(valueOf(newBox())).toBe('');
    expect(document.activeElement).toBe(newBox());
    expect(onDraftChange).toHaveBeenLastCalledWith(false);
  });

  test('FR-1.5: a reply to a reply goes to the thread\'s top note', async () => {
    const sent: unknown[] = [];
    serve(
      [note({ id: 'n1', body: 'Top' }), note({ id: 'r1', parentId: 'n1', body: 'Inner', authorName: 'Cleo', authorId: 'u3' })],
      (_m, _p, body) => {
        sent.push(body);
        return Promise.resolve(note({ id: 'r2', parentId: 'n1', body: 'Answer', authorId: ME }));
      },
    );
    show();
    await screen.findByText('Inner');
    fireEvent.click(within(articleWith('Inner')).getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Reply to Cleo' });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
    await waitFor(() => expect(sent).toEqual([{ body: 'Answer', mentionIds: [], parentId: 'n1' }]));
    expect((await screen.findByText('Note added.')).getAttribute('aria-live')).toBe('polite');
  });

  test('FR-1.5: an empty note says "Write something first." and is not sent', async () => {
    serve([]);
    show();
    await screen.findByText('No notes yet.');
    fireEvent.change(newBox(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Write something first.');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  test('FR-1.5: a note over 5,000 characters says so and keeps the text', async () => {
    serve([]);
    show();
    await screen.findByText('No notes yet.');
    const long = 'a'.repeat(5001);
    fireEvent.change(newBox(), { target: { value: long } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Notes can be up to 5,000 characters.');
    expect(valueOf(newBox())).toBe(long);
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  test.each([
    [new ApiError(422, 'too_many_notes'), 'This item already has 500 notes.'],
    [new ApiError(422, 'unknown_note'), 'That note no longer exists.'],
    [new ApiError(404, 'not_found'), "This item no longer exists, or you don't have access to it."],
    [new ApiError(500, 'unknown'), "Couldn't save the note. Try again."],
  ])('FR-1.5: a refused save shows its message and keeps the text (%s)', async (err, message) => {
    serve([], () => Promise.reject(err));
    show();
    await screen.findByText('No notes yet.');
    fireEvent.change(newBox(), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(valueOf(newBox())).toBe('Keep me');
  });

  test('FR-1.5: noteErrorMessage maps each code, and validation by the length of the text', () => {
    const validation = new ApiError(400, 'validation');
    expect(noteErrorMessage(validation, '  ')).toBe('Write something first.');
    expect(noteErrorMessage(validation, 'a'.repeat(5001))).toBe('Notes can be up to 5,000 characters.');
    expect(noteErrorMessage(validation, 'fine')).toBe("Couldn't save the note. Try again.");
    expect(noteErrorMessage(new ApiError(422, 'too_many_notes'), 'x')).toBe('This item already has 500 notes.');
    expect(noteErrorMessage(new ApiError(422, 'unknown_note'), 'x')).toBe('That note no longer exists.');
    expect(noteErrorMessage(new ApiError(404, 'not_found'), 'x')).toBe('That note no longer exists.');
    // On the new-note box a 404 means the item is gone.
    expect(noteErrorMessage(new ApiError(404, 'not_found'), 'x', 'new')).toBe("This item no longer exists, or you don't have access to it.");
    expect(noteErrorMessage(new ApiError(409, 'item_archived'), 'x')).toBe(
      "This item is archived, so notes and files can't be added or changed.",
    );
    expect(noteErrorMessage(new TypeError('offline'), 'x')).toBe("Couldn't save the note. Try again.");
  });

  test('FR-1.5: editing my note opens a box with its text, and Save note sends the change', async () => {
    const sent: Array<[string, string, unknown]> = [];
    serve([note({ id: 'n1', body: 'Before', authorId: ME })], (method, path, body) => {
      sent.push([method, path, body]);
      const saved = note({ id: 'n1', body: 'After', authorId: ME, editedAt: '2027-01-02T00:00:00.000Z' });
      serve([saved]);
      return Promise.resolve(saved);
    });
    const { onDraftChange } = show();
    await screen.findByText('Before');
    fireEvent.click(within(articleWith('Before')).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit your note' });
    expect(valueOf(box)).toBe('Before');
    expect(document.activeElement).toBe(box);
    expect(onDraftChange).not.toHaveBeenCalledWith(true);
    fireEvent.change(box, { target: { value: 'After' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('After')).toBeTruthy();
    expect(sent).toEqual([['PATCH', '/api/roadmaps/r1/projects/p1/notes/n1', { body: 'After', mentionIds: [] }]]);
    expect(screen.queryByRole('textbox', { name: 'Edit your note' })).toBeNull();
    expect(within(articleWith('After')).getByText('Edited')).toBeTruthy();
    expect(document.activeElement).toBe(within(articleWith('After')).getByRole('button', { name: 'Edit' }));
  });

  test('FR-1.5: Cancel closes a box without saving and returns focus to the control that opened it', async () => {
    serve([note({ id: 'n1', body: 'Top' })]);
    show();
    await screen.findByText('Top');
    const reply = within(articleWith('Top')).getByRole('button', { name: 'Reply' });
    fireEvent.click(reply);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Reply to Bob' })).toBeNull();
    expect(document.activeElement).toBe(within(articleWith('Top')).getByRole('button', { name: 'Reply' }));
  });

  test('FR-1.5: the delete question says replies stay for a note that has them, and focus moves to the next note', async () => {
    let notes = [note({ id: 'n1', body: 'Doomed' }), note({ id: 'n2', body: 'Next one' })];
    serve(notes, (method, path) => {
      expect(method).toBe('DELETE');
      expect(path).toBe('/api/roadmaps/r1/projects/p1/notes/n1');
      notes = [notes[1]!];
      serve(notes);
      return Promise.resolve(undefined);
    });
    show({ role: 'admin' });
    await screen.findByText('Doomed');
    fireEvent.click(within(articleWith('Doomed')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this note?', hidden: true });
    expect(dialog.textContent).toContain("This can't be undone.");
    expect(dialog.textContent).not.toContain('Its replies stay.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note', hidden: true }));
    await waitFor(() => expect(screen.queryByText('Doomed')).toBeNull());
    expect(document.activeElement).toBe(within(articleWith('Next one')).getByRole('button', { name: 'Reply' }));
  });

  test('FR-1.5: deleting a note with replies keeps its place as "This note was deleted."', async () => {
    serve([note({ id: 'n1', body: 'Parent' }), note({ id: 'r1', parentId: 'n1', body: 'Child' })], () => Promise.resolve(undefined));
    show({ role: 'owner' });
    await screen.findByText('Parent');
    fireEvent.click(within(articleWith('Parent')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this note?', hidden: true });
    expect(dialog.textContent).toContain("Its replies stay. This can't be undone.");
    // The refetch still answers with the old list; the cached placeholder stands until it settles.
    mockApi.mockImplementation(() =>
      Promise.resolve({ notes: [note({ id: 'n1', body: '', deleted: true }), note({ id: 'r1', parentId: 'n1', body: 'Child' })] }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete note', hidden: true }));
    expect(await screen.findByText('This note was deleted.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(articleWith('Child')).getByRole('button', { name: 'Reply' })));
  });

  test('FR-1.5: typing in the note box does not re-render the notes already shown', async () => {
    serve([note({ id: 'n1', body: 'One' }), note({ id: 'n2', body: 'Two' })]);
    const { onDraftChange } = show();
    await screen.findByText('Two');
    const before = renders.count;
    expect(before).toBeGreaterThan(0);
    act(() => {
      for (const value of ['a', 'ab', 'abc']) fireEvent.change(newBox(), { target: { value } });
    });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(true));
    expect(renders.count).toBe(before);
  });

  describe('fix round 1', () => {
    const goneAlert = () => screen.queryAllByRole('alert').find((a) => a.textContent.includes('That note no longer exists.'));

    test('FR-1.5: an edit of a note that was deleted meanwhile keeps the text in the bottom box, with the alert above it', async () => {
      serve([note({ id: 'n1', body: 'Mine', authorId: ME }), note({ id: 'n2', body: 'Other' })], () => {
        serve([note({ id: 'n2', body: 'Other' })]);
        return Promise.reject(new ApiError(404, 'not_found'));
      });
      const { onDraftChange } = show();
      await screen.findByText('Mine');
      fireEvent.click(within(articleWith('Mine')).getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Edit your note' }), { target: { value: 'Mine, better' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
      // After the refetch: the note is gone from the list, and the text and the alert are at the bottom.
      await waitFor(() => {
        expect(screen.queryByRole('article')?.textContent).toContain('Other');
        expect(screen.getAllByRole('article')).toHaveLength(1);
        expect(goneAlert()).toBeTruthy();
      });
      expect(screen.queryByRole('textbox', { name: 'Edit your note' })).toBeNull();
      const alert = goneAlert();
      expect(alert).toBeTruthy();
      // Directly above the bottom box.
      expect(alert?.nextElementSibling?.contains(newBox())).toBe(true);
      expect(valueOf(newBox())).toBe('Mine, better');
      await waitFor(() => expect(document.activeElement).toBe(newBox()));
      expect(onDraftChange).toHaveBeenLastCalledWith(true);
    });

    test('FR-1.5: a reply to a thread that is gone is added after the text already in the bottom box', async () => {
      const added = note({ id: 'n9', body: 'Earlier\n\nMy reply', authorId: ME });
      serve([note({ id: 'n1', body: 'Top' })], () => {
        serve([], () => Promise.resolve(added));
        return Promise.reject(new ApiError(422, 'unknown_note'));
      });
      const { onDraftChange } = show();
      await screen.findByText('Top');
      fireEvent.change(newBox(), { target: { value: 'Earlier' } });
      fireEvent.click(within(articleWith('Top')).getByRole('button', { name: 'Reply' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Bob' }), { target: { value: 'My reply' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
      await waitFor(() => {
        expect(screen.queryByText('Top')).toBeNull();
        expect(goneAlert()).toBeTruthy();
      });
      expect(screen.queryByRole('textbox', { name: 'Reply to Bob' })).toBeNull();
      expect(valueOf(newBox())).toBe('Earlier\n\nMy reply');
      await waitFor(() => expect(document.activeElement).toBe(newBox()));
      expect(onDraftChange).toHaveBeenLastCalledWith(true);

      // It stays until the next successful add.
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      expect(await screen.findByText('Note added.')).toBeTruthy();
      expect(goneAlert()).toBeUndefined();
    });

    test('FR-1.5: with changed text in a reply box, Edit elsewhere keeps it open and says "Finish or cancel this one first."', async () => {
      serve([note({ id: 'n1', body: 'Top' }), note({ id: 'n2', body: 'Mine', authorId: ME })]);
      show();
      await screen.findByText('Mine');
      fireEvent.click(within(articleWith('Top')).getByRole('button', { name: 'Reply' }));
      const reply = screen.getByRole('textbox', { name: 'Reply to Bob' });
      fireEvent.change(reply, { target: { value: 'Half' } });
      fireEvent.click(within(articleWith('Mine')).getByRole('button', { name: 'Edit' }));
      expect(screen.queryByRole('textbox', { name: 'Edit your note' })).toBeNull();
      expect(valueOf(reply)).toBe('Half');
      expect(document.activeElement).toBe(reply);
      expect(screen.getByRole('alert').textContent).toBe('Finish or cancel this one first.');
      // The next keystroke clears it.
      fireEvent.change(reply, { target: { value: 'Half done' } });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    test('FR-1.5: an unchanged reply box is simply replaced by Edit', async () => {
      serve([note({ id: 'n1', body: 'Top' }), note({ id: 'n2', body: 'Mine', authorId: ME })]);
      show();
      await screen.findByText('Mine');
      fireEvent.click(within(articleWith('Top')).getByRole('button', { name: 'Reply' }));
      fireEvent.click(within(articleWith('Mine')).getByRole('button', { name: 'Edit' }));
      expect(screen.queryByRole('textbox', { name: 'Reply to Bob' })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Edit your note' }));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    test('FR-1.5: while a reply is being sent, the bottom box still adds a note', async () => {
      const sent: unknown[] = [];
      serve([note({ id: 'n1', body: 'Top' })], (_m, _p, body) => {
        sent.push(body);
        // The reply never answers; the note does.
        return (body as { parentId: string | null }).parentId === null
          ? Promise.resolve(note({ id: 'n5', body: 'Separate', authorId: ME }))
          : new Promise(() => undefined);
      });
      show();
      await screen.findByText('Top');
      fireEvent.click(within(articleWith('Top')).getByRole('button', { name: 'Reply' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Bob' }), { target: { value: 'Slow' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add reply' }));
      fireEvent.change(newBox(), { target: { value: 'Separate' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      expect(await screen.findByText('Note added.')).toBeTruthy();
      expect(sent).toHaveLength(2);
    });

    test('FR-1.5: "Note added." clears when the person next types in a note box', async () => {
      serve([], () => Promise.resolve(note({ id: 'n1', body: 'One', authorId: ME })));
      show();
      await screen.findByText('No notes yet.');
      fireEvent.change(newBox(), { target: { value: 'One' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      expect(await screen.findByText('Note added.')).toBeTruthy();
      fireEvent.change(newBox(), { target: { value: 'T' } });
      expect(screen.queryByText('Note added.')).toBeNull();
    });
  });
});

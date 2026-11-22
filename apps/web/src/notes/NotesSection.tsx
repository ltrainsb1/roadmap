import { can, NOTE_LIMITS, type Note, type Project, type Role } from '@roadmap/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorCode, GENERIC_ERROR } from '../api/errors.ts';
import { formatWhen } from '../audit/dates.ts';
import { focusRemaining } from '../projects/focusAfterRemove.ts';
import type { MemberName } from '../projects/PanelLists.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Markdown } from './Markdown.tsx';
import { NoteBox } from './NoteBox.tsx';
import { useAddNote, useDeleteNote, useEditNote, useNotes } from './useNotes.ts';

export const ARCHIVED_CONTENT = "This item is archived, so notes and files can't be added or changed.";
const EMPTY_NOTE = 'Write something first.';
const TOO_LONG = 'Notes can be up to 5,000 characters.';
const SAVE_FAILED = "Couldn't save the note. Try again.";
const NOTE_GONE = 'That note no longer exists.';
const ITEM_GONE = "This item no longer exists, or you don't have access to it.";
const FINISH_FIRST = 'Finish or cancel this one first.';

/** Why `body` can't be saved as a note, or undefined if it can. */
function bodyProblem(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed === '') return EMPTY_NOTE;
  if (trimmed.length > NOTE_LIMITS.body) return TOO_LONG;
  return undefined;
}

/** The message for a refused add, reply or edit of `body`; on the new-note box a 404 means the item is gone. */
export function noteErrorMessage(err: unknown, body: string, box: 'new' | 'reply' | 'edit' = 'reply'): string {
  switch (errorCode(err)) {
    case 'validation':
      return bodyProblem(body) ?? SAVE_FAILED;
    case 'too_many_notes':
      return 'This item already has 500 notes.';
    case 'not_found':
      return box === 'new' ? ITEM_GONE : NOTE_GONE;
    case 'unknown_note':
      return NOTE_GONE;
    case 'item_archived':
      return ARCHIVED_CONTENT;
    default:
      return SAVE_FAILED;
  }
}

interface Thread {
  note: Note;
  replies: Note[];
}

/** Top-level notes in order, each with its replies in order. */
function threadsOf(notes: readonly Note[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const n of notes) if (n.parentId === null) threads.set(n.id, { note: n, replies: [] });
  for (const n of notes) if (n.parentId !== null) threads.get(n.parentId)?.replies.push(n);
  return [...threads.values()];
}

/** The one box open besides the bottom one: a reply under a thread, or an edit of a note. */
type OpenBox = { kind: 'reply'; threadId: string; to: Note } | { kind: 'edit'; note: Note };
type BoxKey = 'new' | 'reply' | 'edit';

interface NotesSectionProps {
  roadmapId: string;
  item: Project;
  role: Role;
  myId: string | undefined;
  members: readonly MemberName[];
  timeZone: string;
  /** True while any note box holds text that differs from what it opened with. */
  onDraftChange: (hasText: boolean) => void;
}

/** The item's notes: threads with their replies, and boxes to add, reply and edit (FR-1.5). */
export function NotesSection({ roadmapId, item, role, myId, members, timeZone, onDraftChange }: NotesSectionProps) {
  const notes = useNotes(roadmapId, item.id);
  const add = useAddNote(roadmapId, item.id);
  const edit = useEditNote(roadmapId, item.id);
  const del = useDeleteNote(roadmapId, item.id);
  const headingId = useId();
  const newBoxId = `notes-${item.id}-new`;
  const focusList = `notes-${item.id}`;
  const section = useRef<HTMLElement>(null);

  const [open, setOpen] = useState<OpenBox | null>(null);
  const [errors, setErrors] = useState<Partial<Record<BoxKey, string>>>({});
  const [status, setStatus] = useState('');
  const [deleting, setDeleting] = useState<{ note: Note; hasReplies: boolean; index: number } | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  // After a delete, where focus goes once the note has left the list.
  const [focusAfterDelete, setFocusAfterDelete] = useState<{ noteId: string; index: number } | null>(null);
  // After a box closes, the control that focus returns to.
  const [returnFocus, setReturnFocus] = useState<{ id: string } | null>(null);
  // Which boxes have a save in flight.
  const [pending, setPending] = useState<Record<BoxKey, boolean>>({ new: false, reply: false, edit: false });
  // A reply or edit whose note vanished: its text moves to the bottom box, with this alert above it.
  const [goneNotice, setGoneNotice] = useState(false);
  const [handover, setHandover] = useState<{ text: string; n: number }>();
  // Shown under an open box with changed text when another Reply or Edit is chosen.
  const [finishFirst, setFinishFirst] = useState(false);
  const typed = useCallback(() => {
    setStatus('');
    setFinishFirst(false);
  }, []);
  // What the person has typed in the open reply or edit box, to hand over if its note vanishes in a refetch.
  const boxText = useRef<Partial<Record<'reply' | 'edit', string>>>({});
  const typedIn = useMemo(() => {
    const track = (key: 'reply' | 'edit') => (text: string) => {
      boxText.current[key] = text;
      typed();
    };
    return { reply: track('reply'), edit: track('edit') };
  }, [typed]);

  const [drafts, setDrafts] = useState<Record<BoxKey, boolean>>({ new: false, reply: false, edit: false });
  const draftFor = useMemo(() => {
    const mark = (key: BoxKey) => (dirty: boolean) => setDrafts((d) => (d[key] === dirty ? d : { ...d, [key]: dirty }));
    return { new: mark('new'), reply: mark('reply'), edit: mark('edit') };
  }, []);
  const hasDraft = drafts.new || drafts.reply || drafts.edit;
  useEffect(() => onDraftChange(hasDraft), [hasDraft, onDraftChange]);

  const list = notes.data?.notes;
  const threads = useMemo(() => threadsOf(list ?? []), [list]);
  const writable = !item.archived;
  const canAdd = writable && can({ role, action: 'note.create' });
  const canEdit = (n: Note) => writable && can({ role, action: 'note.edit', ctx: { isAuthor: n.authorId === myId } });
  const canDelete = (n: Note) => writable && can({ role, action: 'note.delete', ctx: { isAuthor: n.authorId === myId } });

  const controlId = (noteId: string, control: 'reply' | 'edit') => `note-${noteId}-${control}`;
  const boxId = (kind: 'reply' | 'edit') => `notes-${item.id}-${kind}`;

  // A box whose note has left the list (deleted by someone else) is closed. Changed text in it moves to the bottom
  // box, as when a save finds the note gone. While its save is in flight, the save's answer decides instead.
  useEffect(() => {
    if (!open || !list || pending[open.kind]) return;
    const target = open.kind === 'reply' ? open.to.id : open.note.id;
    if (list.some((n) => n.id === target && !n.deleted)) return;
    const text = boxText.current[open.kind] ?? '';
    const initial = open.kind === 'edit' ? open.note.body : '';
    if (text !== initial && text.trim() !== '') {
      setHandover((h) => ({ text, n: (h?.n ?? 0) + 1 }));
      setGoneNotice(true);
    }
    setOpen(null);
  }, [open, list, pending]);

  useEffect(() => {
    if (!focusAfterDelete || !list) return;
    if (list.some((n) => n.id === focusAfterDelete.noteId && !n.deleted)) return;
    if (section.current) focusRemaining(section.current, focusList, focusAfterDelete.index, newBoxId);
    setFocusAfterDelete(null);
  }, [focusAfterDelete, list, focusList, newBoxId]);

  useEffect(() => {
    if (!returnFocus) return;
    document.getElementById(returnFocus.id)?.focus();
    setReturnFocus(null);
  }, [returnFocus]);

  const setError = (key: BoxKey, message: string | undefined) => setErrors((e) => ({ ...e, [key]: message }));

  const openBox = (box: OpenBox) => {
    if (open && drafts[open.kind]) {
      document.getElementById(boxId(open.kind))?.focus();
      setFinishFirst(true);
      return;
    }
    setFinishFirst(false);
    setErrors((e) => ({ ...e, reply: undefined, edit: undefined }));
    boxText.current = {};
    setOpen(box);
  };
  const closeBox = () => {
    setFinishFirst(false);
    if (open) setReturnFocus({ id: controlId(open.kind === 'reply' ? open.to.id : open.note.id, open.kind) });
    setOpen(null);
  };

  /** Checks the text, then runs `save`; shows any problem in the box named `key`. */
  const attempt = async (key: BoxKey, body: string, save: () => Promise<unknown>): Promise<boolean> => {
    if (key === 'new') setGoneNotice(false);
    else setFinishFirst(false);
    const problem = bodyProblem(body);
    if (problem) {
      setError(key, problem);
      return false;
    }
    setError(key, undefined);
    setPending((p) => ({ ...p, [key]: true }));
    try {
      await save();
      return true;
    } catch (err) {
      const code = errorCode(err);
      const gone = code === 'not_found' || code === 'unknown_note';
      if (gone && key !== 'new') {
        // The note is gone, so its box goes; what was typed moves to the bottom box rather than being lost.
        setOpen(null);
        setHandover((h) => ({ text: body, n: (h?.n ?? 0) + 1 }));
        setGoneNotice(true);
      } else {
        setError(key, noteErrorMessage(err, body, key));
      }
      if (gone) void notes.refetch();
      return false;
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  const addNote = (key: 'new' | 'reply', parentId: string | null) => async (body: string, mentionIds: string[]) => {
    setStatus('');
    const saved = await attempt(key, body, () => add.mutateAsync({ body, mentionIds, parentId }));
    if (saved) {
      if (key === 'reply') boxText.current.reply = '';
      setGoneNotice(false);
      setStatus('Note added.');
    }
    return saved;
  };

  const saveEdit = (n: Note) => async (body: string, mentionIds: string[]) => {
    const saved = await attempt('edit', body, () => edit.mutateAsync({ noteId: n.id, body: { body, mentionIds } }));
    if (saved) closeBox();
    return saved;
  };

  const askDelete = (n: Note, hasReplies: boolean) => {
    const buttons = section.current ? Array.from(section.current.querySelectorAll(`[data-list="${focusList}"]`)) : [];
    const index = Math.max(0, buttons.indexOf(document.getElementById(controlId(n.id, 'reply'))!));
    setDeleteError(undefined);
    setDeleting({ note: n, hasReplies, index });
  };
  const confirmDelete = () => {
    const target = deleting;
    if (!target || del.isPending) return;
    del.mutate(target.note.id, {
      onSuccess: () => {
        setDeleting(null);
        if (open && (open.kind === 'edit' ? open.note.id : open.to.id) === target.note.id) setOpen(null);
        setFocusAfterDelete({ noteId: target.note.id, index: target.index });
      },
      onError: (err) => {
        const gone = errorCode(err) === 'not_found';
        setDeleteError(gone ? NOTE_GONE : GENERIC_ERROR);
        if (gone) void notes.refetch();
      },
    });
  };

  const renderNote = (n: Note, thread: Thread) => {
    if (n.deleted) {
      return (
        <article className="note">
          <p className="note-deleted">This note was deleted.</p>
        </article>
      );
    }
    if (open?.kind === 'edit' && open.note.id === n.id) {
      return (
        <article className="note">
          <NoteHeader note={n} timeZone={timeZone} />
          <NoteBox
            key={n.id}
            id={boxId('edit')}
            label="Edit your note"
            submitLabel="Save note"
            initial={n.body}
            members={members}
            busy={pending.edit}
            error={errors.edit}
            onSubmit={saveEdit(n)}
            onCancel={closeBox}
            onDirtyChange={draftFor.edit}
            onType={typedIn.edit}
            autoFocus
          />
          {finishFirst && <Alert>{FINISH_FIRST}</Alert>}
        </article>
      );
    }
    return (
      <article className="note">
        <NoteHeader note={n} timeZone={timeZone} />
        <Markdown body={n.body} mentions={n.mentions} />
        {(canAdd || canEdit(n) || canDelete(n)) && (
          <div className="note-actions">
            {canAdd && (
              <Button
                variant="link"
                id={controlId(n.id, 'reply')}
                data-list={focusList}
                onClick={() => openBox({ kind: 'reply', threadId: thread.note.id, to: n })}
              >
                Reply
              </Button>
            )}
            {canEdit(n) && (
              <Button variant="link" id={controlId(n.id, 'edit')} onClick={() => openBox({ kind: 'edit', note: n })}>
                Edit
              </Button>
            )}
            {canDelete(n) && (
              <Button variant="link" onClick={() => askDelete(n, n.parentId === null && thread.replies.length > 0)}>
                Delete
              </Button>
            )}
          </div>
        )}
      </article>
    );
  };

  return (
    <section className="notes-section" ref={section} aria-labelledby={headingId}>
      <h3 id={headingId}>Notes</h3>
      {item.archived && <p>{ARCHIVED_CONTENT}</p>}
      {notes.isError && !list && (
        <Alert>
          <p>Couldn't load notes. Try again.</p>
          <Button onClick={() => void notes.refetch()}>Try again</Button>
        </Alert>
      )}
      {notes.isPending && <p className="hint">Loading</p>}
      {list && threads.length === 0 && <p>No notes yet.</p>}
      {threads.length > 0 && (
        <ol className="note-threads" aria-labelledby={headingId}>
          {threads.map((thread) => (
            <li key={thread.note.id} className="note-thread">
              {renderNote(thread.note, thread)}
              {thread.replies.length > 0 && (
                <ol className="note-replies">
                  {thread.replies.map((reply) => (
                    <li key={reply.id}>{renderNote(reply, thread)}</li>
                  ))}
                </ol>
              )}
              {open?.kind === 'reply' && open.threadId === thread.note.id && (
                <>
                  <NoteBox
                    key={open.to.id}
                    id={boxId('reply')}
                    label={`Reply to ${open.to.authorName}`}
                    submitLabel="Add reply"
                    initial=""
                    members={members}
                    busy={pending.reply}
                    error={errors.reply}
                    onSubmit={addNote('reply', thread.note.id)}
                    onCancel={closeBox}
                    onDirtyChange={draftFor.reply}
                    onType={typedIn.reply}
                    autoFocus
                  />
                  {finishFirst && <Alert>{FINISH_FIRST}</Alert>}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {canAdd && list && (
        <>
          {goneNotice && <Alert>{NOTE_GONE}</Alert>}
          <NoteBox
            id={newBoxId}
            label="Add a note"
            submitLabel="Add note"
            initial=""
            members={members}
            busy={pending.new}
            error={errors.new}
            onSubmit={addNote('new', null)}
            onDirtyChange={draftFor.new}
            onType={typed}
            inject={handover}
          />
        </>
      )}
      {/* A polite live region; not role="status", so the panel's own "Saved." stays the panel's one status. */}
      <div aria-live="polite" className="saved notes-status">
        {status}
      </div>
      {/* The dialog sits inside the panel: Escape answers it and must not also close the panel. */}
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.stopPropagation();
        }}
      >
        <ConfirmDialog
          open={deleting !== null}
          title="Delete this note?"
          confirmLabel="Delete note"
          error={deleteError}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        >
          <p>{deleting?.hasReplies ? "Its replies stay. This can't be undone." : "This can't be undone."}</p>
        </ConfirmDialog>
      </div>
    </section>
  );
}

function NoteHeader({ note, timeZone }: { note: Note; timeZone: string }) {
  return (
    <p className="note-meta">
      <strong>{note.authorName}</strong> <time dateTime={note.createdAt}>{formatWhen(note.createdAt, timeZone)}</time>
      {note.editedAt && <span className="note-edited">Edited</span>}
    </p>
  );
}

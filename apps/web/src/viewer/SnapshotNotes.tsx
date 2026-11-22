import type { SnapshotNote } from '@roadmap/shared';
import { useContext, useEffect, useId } from 'react';
import { formatWhen } from '../audit/dates.ts';
import { Markdown } from '../notes/Markdown.tsx';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { linkProblemOf, ReportLinkProblem } from './SnapshotGate.tsx';
import { useReturnToGate, useSnapshotNotes } from './useSnapshot.ts';

const FORMER_MEMBER = 'Former member';

interface Thread {
  note: SnapshotNote;
  replies: SnapshotNote[];
}

/** Top notes with their replies under them, both oldest first. A reply whose note is missing stands on its own. */
export function threadsOf(notes: readonly SnapshotNote[]): Thread[] {
  const tops = new Map<string, Thread>();
  for (const n of notes) if (n.parentId === null) tops.set(n.id, { note: n, replies: [] });
  const threads: Thread[] = [];
  for (const n of notes) {
    const parent = n.parentId === null ? undefined : tops.get(n.parentId);
    if (parent) parent.replies.push(n);
    else if (n.parentId !== null) threads.push({ note: n, replies: [] });
    else threads.push(tops.get(n.id)!);
  }
  return threads;
}

/** The browser's own zone: a stakeholder has no profile to take one from. */
const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One frozen note, read only, in the markup the app's notes use. */
export function SnapshotNoteView({ note, timeZone }: { note: SnapshotNote; timeZone: string }) {
  if (note.deleted) {
    return (
      <article className="note">
        <p className="note-deleted">This note was deleted.</p>
      </article>
    );
  }
  return (
    <article className="note">
      <p className="note-meta">
        <strong>{note.authorName ?? FORMER_MEMBER}</strong> <time dateTime={note.createdAt}>{formatWhen(note.createdAt, timeZone)}</time>
        {note.edited && <span className="note-edited">Edited</span>}
      </p>
      {/* Frozen mentions are names; the name stands in for the id Markdown matches on. */}
      <Markdown body={note.body} mentions={note.mentions.map((name) => ({ userId: name, name }))} />
    </article>
  );
}

/** Threads of frozen notes, replies indented under their note. */
export function SnapshotThreads({ notes, labelledBy, timeZone = browserZone() }: { notes: readonly SnapshotNote[]; labelledBy: string; timeZone?: string }) {
  return (
    <ol className="note-threads" aria-labelledby={labelledBy}>
      {threadsOf(notes).map((thread) => (
        <li key={thread.note.id} className="note-thread">
          <SnapshotNoteView note={thread.note} timeZone={timeZone} />
          {thread.replies.length > 0 && (
            <ol className="note-replies">
              {thread.replies.map((reply) => (
                <li key={reply.id}>
                  <SnapshotNoteView note={reply} timeZone={timeZone} />
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The Notes part on a print page: the item's notes, already loaded with the content, written out with their times in
 * UTC, which the page says.
 */
export function PrintedNotes({ notes }: { notes: readonly SnapshotNote[] }) {
  const headingId = useId();
  return (
    <section className="notes-section details-part" aria-labelledby={headingId}>
      <h2 id={headingId}>Notes</h2>
      <SnapshotThreads notes={notes} labelledBy={headingId} timeZone="UTC" />
    </section>
  );
}

interface SnapshotNotesProps {
  linkId: string;
  itemId: string;
  /** How many notes the item has; with none, nothing is asked for. */
  noteCount: number | undefined;
}

/** The Notes part of an item's details. The notes load when it first shows and are kept. */
export function SnapshotNotes({ linkId, itemId, noteCount }: SnapshotNotesProps) {
  const headingId = useId();
  const none = noteCount === 0;
  const notes = useSnapshotNotes(linkId, itemId, !none);
  const leaving = useReturnToGate(linkId, notes.error);
  // Revoked or expired since the page loaded: the page shows the card, as it does when its own content says so.
  const problem = linkProblemOf(notes.error);
  const report = useContext(ReportLinkProblem);
  useEffect(() => {
    if (problem) report(problem);
  }, [problem, report]);
  // Nothing here while the page goes back to the password page or turns into the card, so no alert is announced first.
  if (leaving || problem) return null;

  let body;
  if (none || notes.data?.notes.length === 0) body = <p>No notes.</p>;
  else if (notes.data) body = <SnapshotThreads notes={notes.data.notes} labelledBy={headingId} />;
  else if (notes.isError) {
    body = (
      <Alert>
        <p>Couldn't load notes. Try again.</p>
        <Button onClick={() => void notes.refetch()}>Try again</Button>
      </Alert>
    );
  } else body = <p className="hint">Loading</p>;

  return (
    <section className="notes-section details-part" aria-labelledby={headingId}>
      <h2 id={headingId}>Notes</h2>
      {body}
    </section>
  );
}

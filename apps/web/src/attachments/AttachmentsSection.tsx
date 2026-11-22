import { cleanFileName, formatFileSize, NOTE_LIMITS, type Attachment, type AttachmentList, type Project } from '@roadmap/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { ARCHIVED_CONTENT, errorCode, GENERIC_ERROR } from '../api/errors.ts';
import { formatWhen } from '../audit/dates.ts';
import { focusRemaining } from '../projects/focusAfterRemove.ts';
import { PROJECTS_KEY } from '../projects/useProjects.ts';
import { ROADMAPS_KEY } from '../roadmaps/useRoadmaps.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { ATTACHMENTS_KEY, downloadAttachment, useAttachments, useDeleteAttachment, useUploadAttachment } from './useAttachments.ts';

const tooLarge = (name: string) => `${name} is larger than 25 MB.`;
const empty = (name: string) => `${name} is empty.`;
const downloadFailed = (name: string) => `Couldn't download ${name}. Try again.`;

/** The message for an upload of the file called `name` that the server refused, or that never arrived. */
export function uploadErrorMessage(err: unknown, name: string): string {
  switch (errorCode(err)) {
    case 'file_too_large':
      return tooLarge(name);
    case 'empty_file':
      return empty(name);
    case 'file_infected':
      return `${name} was blocked because it failed the virus check.`;
    case 'scan_unavailable':
      return "Files can't be checked right now. Try again in a few minutes.";
    case 'too_many_files':
      return 'This item already has 20 files. Remove one to add another.';
    case 'item_archived':
      return ARCHIVED_CONTENT;
    default:
      return `Couldn't add ${name}. Try again.`;
  }
}

/** Why `file` can't be sent, checked in the browser so nothing is sent; undefined if it can. */
function fileProblem(file: File, name: string): string | undefined {
  if (file.size > NOTE_LIMITS.fileBytes) return tooLarge(name);
  if (file.size === 0) return empty(name);
  return undefined;
}

interface AttachmentsSectionProps {
  roadmapId: string;
  item: Project;
  /** Whether the signed-in person may change the item; adding and removing files follows it. */
  editable: boolean;
  timeZone: string;
}

/** The item's files: download any of them, and add or remove them when the item is theirs to change (FR-1.4). */
export function AttachmentsSection({ roadmapId, item, editable, timeZone }: AttachmentsSectionProps) {
  const files = useAttachments(roadmapId, item.id);
  const add = useUploadAttachment(roadmapId, item.id);
  const del = useDeleteAttachment(roadmapId, item.id);
  const queryClient = useQueryClient();
  const headingId = useId();
  const addId = `files-${item.id}-add`;
  const focusList = `files-${item.id}`;
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // The control in this section that last had focus, to notice when a refresh removes it.
  const lastFocused = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Files chosen and not yet sent, in order; one is sent at a time.
  const queue = useRef<File[]>([]);
  const running = useRef(false);
  const [uploading, setUploading] = useState<string | null>(null);
  // Messages for refused files and failed downloads; they stay until the next upload starts.
  const [messages, setMessages] = useState<string[]>([]);
  const [removing, setRemoving] = useState<{ file: Attachment; index: number } | null>(null);
  const [removeError, setRemoveError] = useState<string | undefined>();
  // After a remove, where focus goes once the file has left the list.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ id: string; index: number } | null>(null);

  const list = files.data?.attachments;
  const canChange = editable && !item.archived;

  const say = (message: string) => setMessages((m) => (m.includes(message) ? m : [...m, message]));
  const refreshItem = () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) });
  /** After a `forbidden`, refetches what decides whether this person may change the item: the item and their role. */
  const refreshAccess = () => {
    refreshItem();
    void queryClient.invalidateQueries({ queryKey: ROADMAPS_KEY });
  };

  // When a refresh removes the control that had focus ("Add file" or "Remove" once the item is archived or no
  // longer theirs), focus goes to the heading rather than being lost. A remove places focus itself.
  useEffect(() => {
    const was = lastFocused.current;
    if (!was || was.isConnected || focusAfterRemove) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    heading.current?.focus();
  });

  useEffect(() => {
    if (!focusAfterRemove || !list) return;
    if (list.some((a) => a.id === focusAfterRemove.id)) return;
    if (section.current) focusRemaining(section.current, focusList, focusAfterRemove.index, addId);
    setFocusAfterRemove(null);
  }, [focusAfterRemove, list, focusList, addId]);

  const sendQueue = async () => {
    running.current = true;
    for (let file = queue.current.shift(); file; file = queue.current.shift()) {
      const name = cleanFileName(file.name);
      const problem = fileProblem(file, name);
      if (problem) {
        say(problem);
        continue;
      }
      setUploading(name);
      try {
        await add.mutateAsync(file);
      } catch (err) {
        say(uploadErrorMessage(err, name));
        const code = errorCode(err);
        if (code === 'item_archived' || code === 'forbidden') {
          // Nothing more can be added to it by this person.
          queue.current = [];
          if (code === 'item_archived') refreshItem();
          else refreshAccess();
        }
      }
    }
    setUploading(null);
    running.current = false;
  };

  const chosen = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    // Emptied, so choosing the same file again is a change too.
    e.target.value = '';
    if (picked.length === 0) return;
    queue.current.push(...picked);
    if (running.current) return;
    setMessages([]);
    void sendQueue();
  };

  const download = async (file: Attachment) => {
    try {
      await downloadAttachment(roadmapId, item.id, file.id);
    } catch (err) {
      if (errorCode(err) === 'not_found') await files.refetch();
      say(downloadFailed(file.name));
    }
  };

  const askRemove = (file: Attachment, index: number) => {
    setRemoveError(undefined);
    setRemoving({ file, index });
  };
  const removed = (target: { file: Attachment; index: number }) => {
    setRemoving(null);
    setFocusAfterRemove({ id: target.file.id, index: target.index });
  };
  const confirmRemove = () => {
    const target = removing;
    if (!target || del.isPending) return;
    del.mutate(target.file.id, {
      onSuccess: () => removed(target),
      onError: (err) => {
        const code = errorCode(err);
        if (code === 'not_found') {
          // Already gone: as good as removed.
          const key = ATTACHMENTS_KEY(roadmapId, item.id);
          queryClient.setQueryData<AttachmentList>(key, (l) => l && { attachments: l.attachments.filter((a) => a.id !== target.file.id) });
          void queryClient.invalidateQueries({ queryKey: key });
          removed(target);
          return;
        }
        setRemoveError(code === 'item_archived' ? ARCHIVED_CONTENT : GENERIC_ERROR);
        if (code === 'item_archived') refreshItem();
        if (code === 'forbidden') refreshAccess();
      },
    });
  };

  // Once the item shows as archived, the paragraph says it; the same words in the alert would repeat it.
  const shown = item.archived ? messages.filter((m) => m !== ARCHIVED_CONTENT) : messages;

  return (
    <section
      className="files-section"
      ref={section}
      aria-labelledby={headingId}
      onFocus={(e) => {
        lastFocused.current = e.target;
      }}
    >
      <h3 id={headingId} ref={heading} tabIndex={-1}>
        Files
      </h3>
      {item.archived && <p>{ARCHIVED_CONTENT}</p>}
      {files.isError && !list && (
        <Alert>
          <p>Couldn't load files. Try again.</p>
          <Button onClick={() => void files.refetch()}>Try again</Button>
        </Alert>
      )}
      {files.isPending && <p className="hint">Loading</p>}
      {list && list.length === 0 && !uploading && <p>No files yet.</p>}
      {list && list.length > 0 && (
        <ul className="file-list" aria-labelledby={headingId}>
          {list.map((a, index) => (
            <li key={a.id} className="file-row">
              <div className="file-text">
                <Button variant="link" className="file-name" aria-label={`Download ${a.name}`} onClick={() => void download(a)}>
                  {a.name}
                </Button>
                <p className="file-meta">
                  {formatFileSize(a.size)} · {a.uploadedByName} · <time dateTime={a.createdAt}>{formatWhen(a.createdAt, timeZone)}</time>
                </p>
              </div>
              {canChange && (
                <Button variant="link" className="file-remove" aria-label={`Remove ${a.name}`} data-list={focusList} onClick={() => askRemove(a, index)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div aria-live="polite" className="file-uploading">
        {uploading && <p className="file-row">Uploading {uploading}…</p>}
      </div>
      {shown.length > 0 && (
        <Alert>
          {shown.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </Alert>
      )}
      {canChange && (
        <div className="file-add">
          <Button id={addId} onClick={() => input.current?.click()}>
            Add file
          </Button>
          <p className="hint">Up to 25 MB each.</p>
          {/* Opened by "Add file"; the button is the control people and screen readers use. */}
          <input ref={input} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={chosen} />
        </div>
      )}
      {/* The dialog sits inside the panel: Escape answers it and must not also close the panel. */}
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.stopPropagation();
        }}
      >
        <ConfirmDialog
          open={removing !== null}
          title={`Remove ${removing?.file.name ?? ''}?`}
          confirmLabel="Remove file"
          error={removeError}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        >
          <p>The file is deleted for everyone.</p>
        </ConfirmDialog>
      </div>
    </section>
  );
}

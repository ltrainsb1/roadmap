# v1 Notes, Mentions and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every member can discuss an item in threaded Markdown notes and @mention other members, and the people who can edit an item can attach files to it, which are virus-checked on upload and downloaded through short-lived links.

**Architecture:** Notes and attachments are two new tenant-scoped collections that hang off a project item; neither changes the item's `version`. Files go through the API: it buffers the upload, sends it to a scanner, and only then writes it to an object store. The store and the scanner are interfaces with drivers chosen by config, the same way the mailer is: S3 and ClamAV in production, a local-disk store and a fake scanner for local runs and the end-to-end suite. Downloads never pass through the API in production: the API returns a pre-signed S3 link that lasts 60 seconds. Notes are rendered to React elements by `react-markdown`, never through `innerHTML`.

**Tech Stack:** As the earlier plans, plus `@fastify/multipart`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (API) and `react-markdown` (web). ClamAV (`clamav/clamav` image) and MinIO (tests only) as containers. Before using any of these libraries, read its current docs (the context7 tools) and do not rely on memory for its API.

**Spec:** `docs/prd.md`. Sections this plan implements: FR-1.5 (notes are threaded, Markdown, with @mentions), the attachments part of FR-1.4, the data model's Note entity and its Attachments rule ("stored in S3 with a size limit per file, a malware scan on upload, and pre-signed URLs for download"), and the audit-log rule that every create, update and delete is recorded.

**Builds on:** branch `v1-views` (PR `ltrainsb1/roadmap#3`). Start branch `v1-notes` from it, or from whichever of `v1-foundation` and `main` it has been merged into. Earlier decisions are in the three follow-ups documents in `docs/superpowers/plans/`.

**Not in this plan:** Emails or an in-app list for mentions (the notifications plan, FR-5, reads the mentions this plan stores). Showing notes in snapshots (FR-3.5). Live updates of notes without a refresh. File previews or thumbnails. Attaching files to a note. Note or file counts on the List, Timeline or Board. The S3 bucket, its KMS key and IAM role (the POC infrastructure plan); this plan only reads their names from config.

## Global Constraints

Every constraint in the three earlier plans' Global Constraints sections still binds. The ones this plan leans on, and the new ones:

- Every query goes through `scoped()`; every route has `config.auth`; permission checks use `can()` from `@roadmap/shared` through the policy hook, never a role comparison in a handler.
- Every create, update and delete of a note or attachment writes an audit event inside the same transaction. Audit events for notes carry ids only, never the note's text.
- The page's content policy stays as it is (`default-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, `connect-src 'self'`). Nothing in this plan loosens it. A download is a top-level navigation to the signed link, which the policy does not restrict. Every new E2E spec calls `useCspGuard()`.
- Note text is untrusted. It is never passed to `dangerouslySetInnerHTML` or `innerHTML`. Raw HTML in a note shows as text.
- A file's name and type as sent by the browser are untrusted. The name is display text only and is never part of a storage key or a path. Every file is served with `Content-Disposition: attachment` and `Content-Type: application/octet-stream`.
- Scanning fails closed: if the scanner can't be reached, times out, or answers anything but "clean", the file is not stored.
- With `NODE_ENV=production`, config loading fails unless `FILES=s3` and `SCANNER=clamd`.
- Definition of done for every task: unit tests for pure code, API tests for routes (including one "Tenant isolation: …" test and the forbidden roles per route), E2E for screens, coverage at 80% or more in every package (`pnpm run test --coverage` from the repo root), axe passes on each new screen state, each screen works from 375 px wide with no sideways page scroll, and the FR id appears in the test name.
- All tests run as GitHub Actions in the existing jobs. Check the CI result after every push. No test retries and no fixed waits.
- Docker runs on the devbox through the SSH tunnel, never on the Mac. On the devbox, touch only containers, images and volumes whose names start with `roadmap-`, never run `docker system prune`, never publish ports 80 or 443, and remove what you started. Local unit, API and E2E runs need no Docker: container-backed tests are skipped unless their `TEST_…=container` variable is set, and CI sets all of them.
- On-screen copy follows the `mobbin:plain-writing` rules and the exact text in the UI/UX plan below. E2E tests assert that text word for word.
- Commit trailers name the model that wrote the commit.
- **Plan decisions where the PRD is silent** (change them here and every task follows):
  - *Who can do what.* Every member (Owner, Admin, Contributor) can read notes and files, add a note and reply, on any item in the roadmap. A person can edit and delete their own notes. The Owner and Admins can delete anyone's note; nobody edits someone else's. Adding and removing files follows item editing: the Owner, Admins, and a Contributor assigned to the item or to one above it.
  - *Threads.* One level. A note is either a top-level note or a reply to a top-level note. Replying to a reply adds to the same thread.
  - *Order.* Top-level notes oldest first; replies oldest first under their note; the box for a new note is at the bottom.
  - *Limits.* A note is 1 to 5,000 characters after trimming. 500 notes per item. A file is at most 25 MB and not empty. 20 files per item. A file name is at most 200 characters.
  - *Deleting.* Deleting a reply, or a top-level note with no replies, removes it. Deleting a top-level note that has replies keeps its place and shows "This note was deleted."; its text and mentions are erased. When its last reply is deleted, the placeholder is removed too.
  - *Mentions.* Typing `@` opens a list of the roadmap's members. A mention is stored as the person's id and their name at the time. In the note's text it is plain `@Name`. A mention is recorded only if the person is a member of the roadmap when the note is saved and `@Name` appears in the text. Nothing is sent to the mentioned person in this plan.
  - *Markdown.* CommonMark as `react-markdown` renders it by default, without raw HTML. Images are not loaded: an image shows as a link with its alt text. Links open in a new tab with `rel="noopener noreferrer"`, and only `http:`, `https:` and `mailto:` links are kept. Headings in a note render as bold paragraphs so they don't break the page's heading outline.
  - *Archived items.* Notes and files on an archived item can be read and downloaded. None can be added, edited or removed until it is unarchived.
  - *Deleting an item or roadmap* deletes its notes and files, and those of everything under it.
  - *A member who leaves* keeps their name on the notes they wrote and the files they added.
  - *Unsaved text.* Text typed in a note box counts as an unsaved change: Escape, Close, opening another item and changing view ask before discarding it, as they do for the item form.
  - *Scan outcome.* An infected file is refused with a message and recorded in the audit log. There is no quarantine.
  - *Times* on notes and files are shown in the signed-in person's time zone as a date and time, with the full ISO time in a `<time datetime>`.

## Review Focus

- A note containing `<script>`, an `<img onerror>`, a `javascript:` link, a `data:` link, or a Markdown image: nothing runs and nothing is fetched; the text or a plain link shows. (Task 5)
- A file named `../../etc/passwd`, `a\b.txt`, a name with a newline or 300 characters, a name with emoji, and an empty file: the name is cleaned for display, the key never contains it, the download's `Content-Disposition` is well formed, and the empty file is refused. (Task 4)
- The scanner is down, slow, or drops the connection halfway: the upload is refused with "try again", nothing is written to the store, and no attachment record exists. (Tasks 3 and 4)
- An item is deleted while a note is being added or a file uploaded to it: afterwards there is no note, attachment record or stored object for the deleted item. (Tasks 2 and 4)
- Two members called "Ann" and "Anna", a member whose name contains `(`, `*` or `_`, and a mentioned member who is later removed: the right person is recorded, the highlight covers the whole name and only the name, and old notes still render. (Tasks 1, 5 and 7)

---

## File Structure

```
packages/shared/src/
  notes.ts                      NOTE_LIMITS, note and attachment schemas and types, findMentions, cleanFileName, formatFileSize
  roles.ts, policy.ts           three new actions and their rules
  schemas.ts                    six new audit actions
apps/api/src/
  config.ts                     FILES, S3_*, FILES_DIR, FILES_SIGNING_KEY, SCANNER, CLAMD_*, SCAN_TIMEOUT_MS
  db/types.ts, scoped.ts, indexes.ts   NoteDoc, AttachmentDoc, their collections and indexes
  notes/routes.ts               list, create, edit, delete
  files/object-store.ts         ObjectStore, MemoryObjectStore, LocalObjectStore, S3ObjectStore, createObjectStore
  files/scanner.ts              Scanner, FakeScanner, ClamdScanner, createScanner
  files/local-routes.ts         GET /api/files/local (only when FILES=local or memory)
  attachments/routes.ts         list, upload, download link, delete
  projects/content.ts           assertOpenForContent, deleteContentOf (shared by notes, attachments and the cascades)
  projects/lifecycle-routes.ts, members/routes.ts   call deleteContentOf
apps/web/src/
  api/client.ts                 upload()
  notes/Markdown.tsx            safe rendering with mention highlights
  notes/useNotes.ts             queries and mutations
  notes/NotesSection.tsx        the thread list and its states
  notes/NoteBox.tsx             the textarea used for add, reply and edit
  notes/MentionPicker.tsx       the @ list
  attachments/useAttachments.ts
  attachments/AttachmentsSection.tsx
  projects/ProjectPanel.tsx     renders both sections after the form; folds note drafts into `onDirtyChange`
  audit/describe.ts, AuditPage.tsx   the six new actions
deploy/poc/                     clamav service, env example, upload size in the Caddyfile
```

## UI/UX plan

References looked at (Mobbin, web):

- Thread in an item panel, box at the bottom: [Asana](https://mobbin.com/screens/a8232453-e2b4-4ccc-9e08-a8fe155500c7?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Todoist](https://mobbin.com/screens/f60860d4-80cb-4a3d-a2e0-1b58ba046b2f?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Bonsai](https://mobbin.com/screens/6a11eb38-29f1-486b-ba71-5150b92d0d05?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). Each shows the author's name, the time, then the text, with one button to post. Asana marks an edited comment beside the time.
- A reply count that opens the replies under the comment: [ClickUp](https://mobbin.com/screens/ee60ac43-6456-4368-816b-9d6463ef4cd7?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). This plan always shows replies, indented, since a panel thread is short.
- The @ list opens by the text box and shows names, first match highlighted: [Microsoft Teams](https://mobbin.com/screens/a59556e6-8f71-4263-89a7-16a366c0172c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Jitter](https://mobbin.com/screens/5a02e6ef-d245-4d90-a877-cdc2dae5f422?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).
- Files as a plain list of name and date with one "Add file" button: [Twenty](https://mobbin.com/screens/18f1f96e-ff54-4199-ae71-86fd65ddd0f2?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Wrike](https://mobbin.com/screens/50673371-77a3-4057-a5ea-9672d82649a5?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). The size limit stated beside the upload control: [Plane](https://mobbin.com/screens/c6df7aa1-6b51-4e03-b668-bdf2f03f78d0?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Layout. Two sections come after the item form in the panel, in this order: "Files", then "Notes". Each is a `<section>` with an `h3`. They are outside the `<form>`, so Save does not touch them and they are shown to people who can't edit the item.

**Files.** A list, one row per file: the name as a button that downloads it, then a second line "{size} · {name of who added it} · {date and time}", then a "Remove" button (44 px target) for people who can edit the item. Under the list: an "Add file" button that opens the file chooser (several files may be chosen; they upload one after another) and the hint. While a file uploads, it shows as a row "Uploading {file name}…" with no percentage. A refused file shows its message under the list in an alert that stays until the next upload starts.

**Notes.** A list of threads. A note shows the author's name in bold, the time, "Edited" when it was edited, then the rendered text. Under it: "Reply", and "Edit" and "Delete" when allowed. Replies are a nested list indented 16 px with a left border. "Reply" opens a box under that thread; "Edit" swaps the note's text for a box holding it. Only one box besides the bottom one is open at a time. The bottom box is always there for members, with its hint and "Add note".

**The @ list.** Typing `@` at the start of the text or after a space or new line opens a list under the text box with up to 8 members whose names contain what was typed after the `@` (case ignored), in name order. Up and Down move through it, Enter or Tab picks, Escape closes it and leaves the text as typed. Picking replaces the `@…` with `@Name ` and the box keeps focus. The textarea is a `combobox` only while the list is open (`aria-expanded`, `aria-controls`, `aria-activedescendant`); the list is a `listbox` named "People". The list is positioned with the same fixed-position rules as `Menu` so the panel doesn't clip it.

Copy (exact):

| Where | Text |
| --- | --- |
| Section headings | "Files", "Notes" |
| No files | "No files yet." |
| Add control | "Add file" |
| Hint by the add control | "Up to 25 MB each." |
| Upload in progress | "Uploading {file name}…" |
| File row, second line | "{size} · {person} · {date and time}" |
| Download control, accessible name | "Download {file name}" |
| Remove control | "Remove", accessible name "Remove {file name}" |
| Remove dialog | "Remove {file name}?" / "The file is deleted for everyone." / "Remove file" / "Cancel" |
| File too large | "{file name} is larger than 25 MB." |
| Empty file | "{file name} is empty." |
| Failed the scan | "{file name} was blocked because it failed the virus check." |
| Scanner unavailable | "Files can't be checked right now. Try again in a few minutes." |
| Too many files | "This item already has 20 files. Remove one to add another." |
| Upload failed otherwise | "Couldn't add {file name}. Try again." |
| Download failed | "Couldn't download {file name}. Try again." |
| No notes | "No notes yet." |
| New note box label | "Add a note" |
| Hint under any note box | "You can use Markdown. Type @ to mention someone." |
| New note button | "Add note" |
| Reply control | "Reply" |
| Reply box label | "Reply to {author}" |
| Reply buttons | "Add reply", "Cancel" |
| Edit control | "Edit" |
| Edit box label | "Edit your note" |
| Edit buttons | "Save note", "Cancel" |
| Edited mark | "Edited" |
| Delete control | "Delete" |
| Delete dialog | "Delete this note?" / "This can't be undone." / "Delete note" / "Cancel" |
| Delete dialog, note with replies | second line is "Its replies stay. This can't be undone." |
| Deleted note with replies | "This note was deleted." |
| Empty note submitted | "Write something first." |
| Note too long | "Notes can be up to 5,000 characters." |
| Too many notes | "This item already has 500 notes." |
| Note couldn't be saved | "Couldn't save the note. Try again." |
| The note being replied to or edited is gone | "That note no longer exists." |
| Notes or files failed to load | "Couldn't load notes. Try again." / "Couldn't load files. Try again." with a "Try again" button |
| Archived item | "This item is archived, so notes and files can't be added or changed." |
| @ list name | "People" |
| @ list, nothing matches | "No one matches." |
| Author no longer has an account | "Former member" |
| Audit log | "added a note", "edited a note", "deleted a note", "added a file", "removed a file", "tried to add a file that failed the virus check" |

Accessibility: after "Add note" or "Add reply" succeeds, focus stays in the box (now empty) and a polite status says "Note added."; after a delete, focus moves as `focusAfterRemove` does for the panel's lists (next, previous, or the new-note box); after a file is removed, the same within the file list, ending on "Add file". Errors are `role="alert"`. The upload row is in a polite live region.

---

### Task 1: Shared rules for notes, mentions and files

**Files:**
- Create: `packages/shared/src/notes.ts`, `packages/shared/test/notes.test.ts`
- Modify: `packages/shared/src/roles.ts`, `packages/shared/src/policy.ts`, `packages/shared/src/schemas.ts`, `packages/shared/src/index.ts`, `packages/shared/test/policy.test.ts`

**Interfaces:**
- Produces, from `notes.ts`:
  - `NOTE_LIMITS = { body: 5000, notesPerItem: 500, fileBytes: 25 * 1024 * 1024, filesPerItem: 20, fileName: 200, mentionChoices: 8 } as const`
  - `mentionSchema = { userId, name }`; `noteSchema = { id, projectId, parentId: string | null, authorId, authorName, body, mentions: Mention[], createdAt, editedAt: string | null, deleted: boolean }`; `noteListSchema = { notes: Note[] }`; `noteBodySchema = { body: string (trimmed, 1..5000), mentionIds: string[] (max 50, default []) }`; `createNoteBodySchema = noteBodySchema + { parentId: string | null (default null) }`
  - `attachmentSchema = { id, projectId, name, size, uploadedById, uploadedByName, createdAt }`; `attachmentListSchema = { attachments: Attachment[] }`; `downloadLinkSchema = { url: string }`
  - `findMentions(body: string, candidates: readonly Mention[]): Mention[]`
  - `mentionRanges(body: string, mentions: readonly Mention[]): Array<{ start: number; end: number; userId: string }>`
  - `cleanFileName(raw: string): string`
  - `formatFileSize(bytes: number): string`
- Produces, in `roles.ts` `ACTIONS`: `'note.create'`, `'note.edit'`, `'note.delete'`. In `PolicyContext`: `isAuthor?: boolean`. Rules: `note.create` everyone; `note.edit` only when `ctx.isAuthor === true`, for any role; `note.delete` Owner and Admin always, a Contributor only when `ctx.isAuthor === true`. File actions reuse `project.edit` (add, remove) and `roadmap.view` (list, download).
- Produces, in `AUDIT_ACTIONS`: `'note.create'`, `'note.update'`, `'note.delete'`, `'attachment.create'`, `'attachment.delete'`, `'attachment.rejected'`.

- [ ] **Step 1: Write failing tests** in `notes.test.ts` and extend the role table in `policy.test.ts`:

```ts
const ann = { userId: 'u1', name: 'Ann' };
const anna = { userId: 'u2', name: 'Anna' };
const odd = { userId: 'u3', name: 'J. (Jo) O_Neil*' };

test('FR-1.5: a mention needs @Name in the text, as a whole name', () => {
  expect(findMentions('ask @Anna today', [ann, anna])).toEqual([anna]);
  expect(findMentions('ask @Ann, then @Anna.', [ann, anna])).toEqual([ann, anna]);
  expect(findMentions('mail ann@Ann.example', [ann])).toEqual([]);          // @ must start the text or follow white space or "("
  expect(findMentions('thanks @annabel', [ann, anna])).toEqual([]);         // a longer word is not a mention
  expect(findMentions('cc @J. (Jo) O_Neil* please', [odd])).toEqual([odd]); // names are matched as plain text
  expect(findMentions('@ANN', [ann])).toEqual([]);                          // case matters: the picker inserts the exact name
});
test('FR-1.5: ranges cover the @ and the whole name, longest name first', () => {
  expect(mentionRanges('hi @Anna and @Ann', [ann, anna])).toEqual([
    { start: 3, end: 8, userId: 'u2' }, { start: 13, end: 17, userId: 'u1' },
  ]);
});
test('FR-1.4: file names are cleaned for display', () => {
  expect(cleanFileName('../../etc/passwd')).toBe('passwd');
  expect(cleanFileName('C:\\tmp\\a\\b.txt')).toBe('b.txt');
  expect(cleanFileName('re\nport\u0000.pdf')).toBe('report.pdf');
  expect(cleanFileName('  ')).toBe('file');
  expect(cleanFileName('x'.repeat(300) + '.pdf')).toHaveLength(200);
  expect(cleanFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
  expect(cleanFileName('plan 🚀.md')).toBe('plan 🚀.md');
});
test('file sizes', () => {
  expect([0, 1023, 1024, 1536, 25 * 1024 * 1024].map(formatFileSize)).toEqual(['0 B', '1023 B', '1 KB', '1.5 KB', '25 MB']);
});
```

Policy table rows to add: `note.create` allowed for all three roles; `note.edit` allowed for each role only with `isAuthor: true`; `note.delete` allowed for owner and admin with or without `isAuthor`, for contributor only with it.

- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test`. Expected: FAIL, `findMentions` is not exported.
- [ ] **Step 3: Implement.** A name "ends" when the next character is not a letter, digit or underscore (Unicode-aware), or the text ends. `mentionRanges` tries longer names first at each `@` so "Anna" wins over "Ann"; `findMentions` returns the distinct people in `mentionRanges` order of first appearance. `formatFileSize` uses 1024 steps, at most one decimal, and drops a trailing ".0".
- [ ] **Step 4: Run** the shared tests, `pnpm lint`, `pnpm typecheck`. Expected: PASS. If the type-check fails in `apps/web/src/audit` or elsewhere on a list of audit actions, add the smallest entry that compiles; Tasks 6 and 8 write the real text.
- [ ] **Step 5: Commit** `feat(shared): rules for notes, mentions and file names (FR-1.4, FR-1.5)`.

### Task 2: API for notes (FR-1.5)

**Files:**
- Create: `apps/api/src/notes/routes.ts`, `apps/api/src/projects/content.ts`, `apps/api/test/notes/notes.test.ts`
- Modify: `apps/api/src/db/types.ts`, `apps/api/src/db/scoped.ts`, `apps/api/src/db/indexes.ts`, `apps/api/src/app.ts`, `apps/api/src/projects/lifecycle-routes.ts`, `apps/api/src/members/routes.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: Task 1's schemas, actions and `findMentions`; `loadProject`, `req.actor`, `createAuditLog`, `HttpError`, `projectParams`.
- Produces:
  - `NoteDoc { _id, tenantId, roadmapId, projectId, parentId: string | null, authorId, body, mentions: { userId, name }[], createdAt: Date, editedAt: Date | null, deletedAt: Date | null }`, collection `notes`, indexes `{ tenantId, projectId, createdAt }` and `{ tenantId, roadmapId }`.
  - `ProjectDoc.contentRevision?: number`. It is not in the DTO and never changes `version`.
  - `assertOpenForContent(s: ScopedDb, roadmapId: string, projectId: string): Promise<ProjectDoc>` in `content.ts`: loads the item (404 `not_found`), refuses an archived one (409 `item_archived`), and `$inc`s `contentRevision` on it. Called first inside every transaction that adds, edits or removes a note or file, so a delete of the item at the same instant conflicts and one side retries.
  - `deleteContentOf(s: ScopedDb, filter: { roadmapId: string; projectIds?: string[] }): Promise<{ keys: string[] }>`: deletes notes (and, from Task 4, attachment records) for those items or the whole roadmap, and returns storage keys to delete after the transaction commits. In this task it returns `{ keys: [] }`.
  - Routes, all `level: 'full'` with `roadmapParam`:
    - `GET /api/roadmaps/:roadmapId/projects/:projectId/notes` → 200 `noteListSchema`, action `roadmap.view`. Oldest first. A deleted note with replies has `deleted: true`, `body: ''`, `mentions: []`.
    - `POST …/notes` body `createNoteBodySchema` → 201 `noteSchema`, action `note.create`.
    - `PATCH …/notes/:noteId` body `noteBodySchema` → 200 `noteSchema`, action `note.edit`, ctx `{ isAuthor }`.
    - `DELETE …/notes/:noteId` → 204, action `note.delete`, ctx `{ isAuthor }`.
  - New error codes: 409 `item_archived`, 422 `too_many_notes`, 422 `unknown_note` (the `parentId` is missing, deleted, in another item, or is itself a reply).
  - `Seeder.note(tenantId, roadmapId, projectId, authorId, over?)` in the test helpers.

- [ ] **Step 1: Write failing API tests** (names start with "FR-1.5:" unless noted):
  - each role adds a note to an item it is not assigned to; the response has `authorName`, `editedAt: null`, `deleted: false`
  - a reply has its `parentId`; a reply to a reply, to a note on another item, to a missing note → 422 `unknown_note`
  - mentions: `mentionIds` of a member whose `@Name` is in the body is stored with their current name; an id whose name is not in the body, an id of a non-member, and an id from another tenant are dropped without an error
  - only the author edits: another Contributor, an Admin and the Owner get 403; the author's edit sets `editedAt`, recomputes mentions, and an edit that changes nothing leaves `editedAt` null
  - delete: author, Admin and Owner can; another Contributor gets 403; a reply is removed; a top-level note with replies becomes `deleted: true` with empty body and mentions, and is removed when its last reply is deleted; editing or replying to a deleted note → 404 / 422
  - validation: empty or white-space body and 5,001 characters → 400 `validation`; the 501st note → 422 `too_many_notes` (build the app with a smaller limit through a `maxNotesPerItem` option on `makeTestApp`, as `maxProjectItems` does)
  - archived item: list works; add, edit and delete → 409 `item_archived`
  - an item's `version` and `updatedAt` are unchanged after notes are added
  - cascade: deleting an item deletes its notes and its descendants' notes; deleting the roadmap deletes all of them
  - race: `Promise.all` of deleting an item and adding a note to it, 20 times; afterwards no note exists whose item is gone (Review Focus)
  - audit: create, update and delete each record one event with target `{ type: 'note', id }`, the item id in `after` or `before`, and no `body` key anywhere in the event
  - a note whose author's user record is gone lists with `authorName: 'Former member'`
  - "Tenant isolation: notes" — a signed-in member of another tenant's roadmap gets 404 for list, create, edit and delete using this roadmap's ids, and a `noteId` from another tenant under their own roadmap is 404
  - signed out → 401; missing CSRF token on the three writes → 403 `csrf`
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test -- notes`. Expected: FAIL with 404s (routes not registered).
- [ ] **Step 3: Implement.** The `isAuthor` ctx loads the note by `{ _id: noteId, roadmapId, projectId }` and 404s when it is missing. Names for `authorName` come from one `users` query per list. The note count for the limit is taken inside the transaction after `assertOpenForContent`.
- [ ] **Step 4: Wire the cascades.** `lifecycle-routes.ts` delete calls `deleteContentOf(s, { roadmapId, projectIds: [item and descendants] })` in its transaction; the roadmap delete in `members/routes.ts` calls it with `{ roadmapId }`.
- [ ] **Step 5: Run** the API tests with coverage, lint and type-check. Expected: PASS, coverage ≥ 80%.
- [ ] **Step 6: Commit** `feat(api): threaded notes with mentions (FR-1.5)`.

### Task 3: Object store and scanner drivers

**Files:**
- Create: `apps/api/src/files/object-store.ts`, `apps/api/src/files/scanner.ts`, `apps/api/src/files/local-routes.ts`, `apps/api/test/files/object-store.test.ts`, `apps/api/test/files/scanner.test.ts`, `apps/api/test/files/containers.test.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/test/helpers.ts`, `apps/api/test/config.test.ts` (or wherever config is tested), `apps/api/package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces, config (env → `Config`):
  - `FILES` = `s3 | local | memory` (default `local`) → `files`
  - `S3_BUCKET` (required for `s3`) → `s3Bucket`; `S3_ENDPOINT` (optional, for MinIO; switches on path-style addressing) → `s3Endpoint`
  - `FILES_DIR` and `FILES_SIGNING_KEY` (base64 of 32 bytes), both required for `local` → `filesDir`, `filesSigningKey`
  - `SCANNER` = `clamd | fake` (default `fake`) → `scanner`; `CLAMD_HOST` (required for `clamd`), `CLAMD_PORT` (default 3310), `SCAN_TIMEOUT_MS` (default 30000)
  - `ConfigError` when `NODE_ENV=production` and `FILES` is not `s3` or `SCANNER` is not `clamd`
- Produces, `object-store.ts`:

```ts
export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  /** A link that downloads the object as `fileName` and stops working after `expiresSeconds`. */
  signedGetUrl(key: string, opts: { fileName: string; expiresSeconds: number }): Promise<string>;
  deleteMany(keys: readonly string[]): Promise<void>;   // missing keys are not an error
}
export const DOWNLOAD_SECONDS = 60;
export function contentDisposition(fileName: string): string;   // attachment; filename="ascii-fallback"; filename*=UTF-8''percent-encoded
export class MemoryObjectStore implements ObjectStore { constructor(origin: string, now?: () => Date); readonly objects: Map<string, Buffer>; read(token: string): Promise<{ body: Buffer; fileName: string } | null>; }
export class LocalObjectStore implements ObjectStore { constructor(dir: string, signingKey: Buffer, origin: string, now?: () => Date); read(token: string): Promise<{ body: Buffer; fileName: string } | null>; }
export class S3ObjectStore implements ObjectStore { constructor(client: S3Client, bucket: string); }
export function createObjectStore(config: Config): ObjectStore;
```

  - `LocalObjectStore.signedGetUrl` returns `${origin}/api/files/local?token=…`, where the token is the key, file name and expiry with an HMAC-SHA-256 over them. `MemoryObjectStore` signs the same way with a random key made at construction.
  - `S3ObjectStore.put` sets `ContentType: application/octet-stream` and `ServerSideEncryption: 'aws:kms'`; `signedGetUrl` sets `ResponseContentDisposition` from `contentDisposition()` and `ResponseContentType: application/octet-stream`.
- Produces, `scanner.ts`:

```ts
export type ScanResult = { clean: true } | { clean: false; signature: string };
export class ScanUnavailableError extends Error {}
export interface Scanner { scan(body: Buffer): Promise<ScanResult>; }
export const EICAR: string;                       // the 68-character standard test string, built from two halves so no scanner flags this source file
export class FakeScanner implements Scanner {}    // not clean when the body contains EICAR; throws ScanUnavailableError when the body contains 'SCANNER-DOWN'
export class ClamdScanner implements Scanner { constructor(opts: { host: string; port: number; timeoutMs: number }); }
export function createScanner(config: Config): Scanner;
```

  - `ClamdScanner` speaks clamd's `INSTREAM` over TCP: send `zINSTREAM\0`; then the body in chunks, each prefixed by its length as a 4-byte big-endian number; then four zero bytes; read the reply up to `\0`. `stream: OK` is clean; `stream: {signature} FOUND` is not; anything else, a socket error, or no full reply within `timeoutMs` throws `ScanUnavailableError`.
- Produces, `local-routes.ts`: `GET /api/files/local?token=…`, registered only when `files` is `local` or `memory`, `config.auth: { level: 'public' }` (or this codebase's name for a route that needs no session). A valid, unexpired token → 200 with the bytes, `Content-Type: application/octet-stream`, `Content-Disposition` from `contentDisposition()`, `X-Content-Type-Options: nosniff`; otherwise 404.
- Produces: `AppDeps.objectStore?: ObjectStore`, `AppDeps.scanner?: Scanner`; `makeTestApp` passes a `MemoryObjectStore` and a `FakeScanner` and exposes them as `TestApp.files` and `TestApp.scanner`.

- [ ] **Step 1: Write failing unit tests.**
  - config: each required-with rule above; production refuses `FILES=local` and `SCANNER=fake`
  - `contentDisposition('report.pdf')`, `('ré sumé".pdf')`, `('plan 🚀.md')`: always starts `attachment;`, the quoted fallback has only printable ASCII with `"` and `\` removed, and `filename*` round-trips through `decodeURIComponent`
  - `LocalObjectStore` in a temp dir: put then read through a signed token returns the bytes and name; a token altered by one character, an expired token (inject `now`), and a token for a deleted key return null; a key containing `..` is refused by `put`
  - `ClamdScanner` against a fake clamd made with `net.createServer` in the test: replies `stream: OK\0` → clean; `stream: Win.Test.EICAR_HDB-1 FOUND\0` → that signature; the server receives exactly the framing above for a 3-chunk body; server closes mid-stream, replies `INSTREAM size limit exceeded. ERROR\0`, or never replies (with `timeoutMs: 50`) → `ScanUnavailableError`
  - `FakeScanner`: clean, EICAR, and `SCANNER-DOWN`
  - the local route: good token 200 with the three headers; bad token 404; the route does not exist when the app is built with an `S3ObjectStore`
- [ ] **Step 2: Run** them. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** config, the drivers, the factory functions and the route.
- [ ] **Step 4: Write container tests** in `containers.test.ts`, each in a `describe.skipIf` on its variable:
  - `TEST_S3=container`: start MinIO with Testcontainers, create a bucket, and run `S3ObjectStore` through put, `signedGetUrl` + `fetch` (200, the bytes, `content-disposition` starts `attachment`, `content-type` is `application/octet-stream`), a second fetch after the link's expiry using a 1-second link (403), and `deleteMany`. MinIO has no KMS key by default: build the store for this test with an option that leaves `ServerSideEncryption` unset, and unit-test separately that the production path sets it.
  - `TEST_CLAMAV=container`: start `clamav/clamav` and wait for its health check (allow 3 minutes), then `ClamdScanner.scan` of a clean buffer → clean, of `Buffer.from(EICAR)` → not clean with a signature containing "EICAR", and of a 20 MB zero buffer → clean.
- [ ] **Step 5: CI.** In `ci.yml`, set `TEST_S3: container` and `TEST_CLAMAV: container` on the job that already sets `TEST_MONGO: container`. Container names from Testcontainers are random; nothing is published on fixed ports.
- [ ] **Step 6: Run** unit tests, coverage, lint, type-check locally (container tests skip), and the container tests once on the devbox with both variables set. Expected: PASS. Remove any container the run left behind.
- [ ] **Step 7: Commit** `feat(api): object store and virus scanner drivers (FR-1.4)`.

### Task 4: API for attachments (FR-1.4)

**Files:**
- Create: `apps/api/src/attachments/routes.ts`, `apps/api/test/attachments/attachments.test.ts`
- Modify: `apps/api/src/db/types.ts`, `apps/api/src/db/scoped.ts`, `apps/api/src/db/indexes.ts`, `apps/api/src/app.ts`, `apps/api/src/projects/content.ts`, `apps/api/src/projects/lifecycle-routes.ts`, `apps/api/src/members/routes.ts`, `apps/api/test/helpers.ts`, `apps/api/package.json`

**Interfaces:**
- Consumes: Task 1's schemas and `cleanFileName`; Task 2's `assertOpenForContent` and `deleteContentOf`; Task 3's `ObjectStore`, `Scanner`, `ScanUnavailableError`, `DOWNLOAD_SECONDS`.
- Produces:
  - `AttachmentDoc { _id, tenantId, roadmapId, projectId, name, size, key, uploadedById, createdAt: Date }`, collection `attachments`, indexes `{ tenantId, projectId, createdAt }` and `{ tenantId, roadmapId }`. `key` is `${tenantId}/${roadmapId}/${_id}` and is never sent to the browser.
  - Routes:
    - `GET /api/roadmaps/:roadmapId/projects/:projectId/attachments` → 200 `attachmentListSchema`, action `roadmap.view`, oldest first.
    - `POST …/attachments`, `multipart/form-data` with one part named `file` → 201 `attachmentSchema`, action `project.edit`, ctx `assignedCtx`.
    - `GET …/attachments/:attachmentId/download` → 200 `downloadLinkSchema`, action `roadmap.view`.
    - `DELETE …/attachments/:attachmentId` → 204, action `project.edit`, ctx `assignedCtx`.
  - New error codes: 413 `file_too_large`, 422 `empty_file`, 422 `too_many_files`, 422 `file_infected`, 503 `scan_unavailable`, 400 `validation` when there is no `file` part or more than one.
  - `deleteContentOf` now also deletes attachment records and returns their keys; both cascades call `objectStore.deleteMany(keys)` after their transaction commits, and log (not throw) if that fails.
  - `Seeder.attachment(tenantId, roadmapId, projectId, uploadedById, over?)` puts bytes in `TestApp.files` and inserts the record.

- [ ] **Step 1: Write failing API tests** (names start with "FR-1.4:" unless noted):
  - Owner, Admin and an assigned Contributor upload; an unassigned Contributor gets 403 for upload and delete but can list and get a download link
  - the response has the cleaned name, the size, `uploadedByName`; the store holds the same bytes under a key that does not contain the file name
  - upload order of work, checked with a store and scanner that record calls: the scanner is called before the store; when the scanner says not clean → 422 `file_infected`, the store was never called, no record exists, and one `attachment.rejected` audit event has the cleaned name and the signature; when it throws `ScanUnavailableError` → 503 `scan_unavailable`, nothing stored, no record
  - if the store's `put` throws → 500 and no record; if the transaction fails after `put` (item deleted in between) → the object is deleted again
  - 25 MB exactly is accepted; one byte more → 413 `file_too_large` with nothing scanned or stored; zero bytes → 422 `empty_file`; the 21st file → 422 `too_many_files` (use a `maxFilesPerItem` option on `makeTestApp`)
  - names: `../../etc/passwd`, `a\b.txt`, a name with a newline, 300 characters, and emoji each store the `cleanFileName` result (Review Focus)
  - download: the link fetched with the app's injector returns the bytes with `content-disposition` starting `attachment` and the cleaned name; a link is refused after 61 seconds (inject `now`); the download route for an attachment of another item under the same roadmap is 404
  - delete removes the record and the object; deleting it again is 404
  - archived item: list and download work; upload and delete → 409 `item_archived`
  - cascade: deleting an item removes its and its descendants' records and objects; deleting the roadmap removes all of them
  - race: `Promise.all` of deleting an item and uploading to it, 20 times; afterwards no record and no object exists for a deleted item (Review Focus)
  - audit: `attachment.create` and `attachment.delete` with target `{ type: 'attachment', id }` and the name and size
  - a file whose uploader's user record is gone lists with `uploadedByName: 'Former member'`
  - "Tenant isolation: attachments" — another tenant's member gets 404 on all four routes with this roadmap's ids, and cannot get a link for an `attachmentId` of this tenant through their own roadmap
  - signed out → 401; missing CSRF token on upload and delete → 403 `csrf`
- [ ] **Step 2: Run** them. Expected: FAIL with 404s.
- [ ] **Step 3: Implement.** Register `@fastify/multipart` with `limits: { fileSize: NOTE_LIMITS.fileBytes, files: 1, fields: 0 }` and read the part into a Buffer; the plugin's size-limit error maps to 413 `file_too_large`. Order in the handler: read and check size → `cleanFileName` → scan → `put` → transaction (`assertOpenForContent`, count check, insert, audit) → on a transaction failure, `deleteMany([key])` then rethrow. Check that the multipart route still passes through the CSRF check in the policy hook; add the test above before trusting it.
- [ ] **Step 4: Run** the API tests with coverage, lint and type-check. Expected: PASS, coverage ≥ 80%.
- [ ] **Step 5: Commit** `feat(api): file attachments with a virus check and signed downloads (FR-1.4)`.

### Task 5: Web: safe Markdown with mention highlights (FR-1.5)

**Files:**
- Create: `apps/web/src/notes/Markdown.tsx`, `apps/web/src/notes/Markdown.test.tsx`
- Modify: `apps/web/package.json`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `mentionRanges`, `Mention` from `@roadmap/shared`.
- Produces: `Markdown({ body, mentions }: { body: string; mentions: readonly Mention[] }): JSX.Element`. It renders inside `<div className="markdown">`. A recorded mention renders as `<span className="mention">@Name</span>`.

- [ ] **Step 1: Write failing unit tests** (Testing Library), names starting "FR-1.5:":
  - `**bold**`, `*em*`, a list, a block quote, inline code and a fenced code block render as `strong`, `em`, `ul > li`, `blockquote`, `code`, `pre > code`
  - `# Title` renders as a bold paragraph; the container has no `h1`–`h6`
  - `[site](https://example.com)` is a link with `target="_blank"` and `rel="noopener noreferrer"`; `[x](javascript:alert(1))`, `[x](data:text/html,hi)` and `[x](vbscript:x)` render with no `href`
  - `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` show as text; the container has no `script` and no `img` element
  - `![chart](https://example.com/a.png)` renders no `img`; it shows a link with the text "chart"
  - mentions: with `mentions = [Ann, Anna]`, "hi @Anna and @Ann" has two `.mention` spans with exactly "@Anna" and "@Ann"; "@Ann" with no recorded mention has none; `**@Ann**` has the span inside the `strong`; "@Ann" inside inline code or a code block is not highlighted; the odd name from Task 1 highlights whole
  - a 5,000-character body of `*` and `_` characters renders in under a second
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test -- Markdown`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** with `react-markdown`: no raw-HTML plugin; `img` and headings replaced through its element options; links filtered by scheme. Mentions are added by a small plugin in this file that walks text nodes outside `code` and splits them at `mentionRanges`. Styles: `.markdown` typography from existing tokens, long words and code wrap or scroll inside the note (`overflow-wrap: anywhere`, `pre { overflow-x: auto }`) so the panel never scrolls sideways; `.mention` is bold with the link colour's contrast.
- [ ] **Step 4: Run** the web unit tests, lint, type-check and `pnpm --filter @roadmap/web build`. Expected: PASS. Note the change in the built JS size in the report.
- [ ] **Step 5: Commit** `feat(web): render notes as safe Markdown (FR-1.5)`.

### Task 6: Web: notes in the item panel (FR-1.5)

**Files:**
- Create: `apps/web/src/notes/useNotes.ts`, `apps/web/src/notes/NotesSection.tsx`, `apps/web/src/notes/NoteBox.tsx`, `apps/web/src/notes/NotesSection.test.tsx`, `apps/web/e2e/notes.spec.ts`
- Modify: `apps/web/src/projects/ProjectPanel.tsx`, `apps/web/src/projects/names.ts` (date-and-time formatting, if no helper exists), `apps/web/src/audit/describe.ts`, `apps/web/src/audit/AuditPage.tsx`, `apps/web/src/styles.css`, `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes: Task 2's routes; Task 5's `Markdown`; `api`, `ApiError`; `can`; `ConfirmDialog`; `focusAfterRemove`; the panel's `onDirtyChange`.
- Produces:
  - `NOTES_KEY(roadmapId, projectId) = ['notes', roadmapId, projectId]`; `useNotes`, `useAddNote`, `useEditNote`, `useDeleteNote`. Mutations put the server's result into the cache and then invalidate.
  - `NotesSection({ roadmapId, item, role, myId, members, timeZone, onDraftChange }: …)`; `onDraftChange(hasText: boolean)` is true while any note box holds text that differs from what it opened with.
  - `NoteBox({ label, submitLabel, initial, members, busy, error, onSubmit, onCancel? })`, where `onSubmit(body: string, mentionIds: string[]): Promise<boolean>`. In this task `mentionIds` is always `[]` and `members` is unused; Task 7 fills them in.
  - `ProjectPanel` reports dirty when the form is dirty or a note box has a draft.
  - `seedNote(call, roadmapId, projectId, body, parentId?)` in the E2E helpers.

- [ ] **Step 1: Write failing tests.** Unit (`NotesSection.test.tsx`, mocked `api`): threads and replies nest in order; a deleted note with replies shows "This note was deleted." with no Reply, Edit or Delete; Edit shows only on my notes; Delete shows on mine, and on all for Owner and Admin; an archived item shows the archived message and no boxes or controls; each error code maps to its copy (`validation` → by length, `too_many_notes`, `unknown_note`, 404, anything else). E2E (`notes.spec.ts`, names starting "FR-1.5:"):
  - a Contributor not assigned to an item adds a note with `**bold**` and a list; it shows rendered with their name and a time; the box is empty and focused, and "Note added." is announced; it is still there after a reload
  - an Admin replies; the reply is nested under the note; replying to that reply adds to the same thread
  - the author edits their note: "Edited" appears; the Admin sees no "Edit" on it
  - the Admin deletes the Contributor's note that has a reply: "This note was deleted." stays with the reply; deleting the reply removes both; focus lands as specified
  - "Write something first." on an empty submit; a 5,001-character note shows the length message and keeps the text
  - text typed in the new-note box, then Escape: the "Discard your unsaved changes" question appears; "Keep editing" keeps the text; the same for opening another row
  - a note containing `<img src=x onerror=…>` and a `javascript:` link shows as text and a dead link; `useCspGuard()` records no violation and no dialog opens
  - an archived item shows its notes and the archived message, with no boxes
  - when the notes request fails (route blocked), "Couldn't load notes. Try again." and its button; the item form above still works
  - the audit log shows "added a note", "edited a note" and "deleted a note" for those actions, and the action filter lists them
  - axe passes on the panel with a thread, with an open reply box, and with the delete dialog; at 375 px the panel has no sideways scroll with a long unbroken word and a wide code block in a note
- [ ] **Step 2: Run** them. Expected: FAIL (no Notes section).
- [ ] **Step 3: Implement** the hooks, `NoteBox` (a labelled textarea, the hint, the buttons, the alert) and `NotesSection`; render it after the form in `ProjectPanel` and fold `onDraftChange` into `onDirtyChange`. Add the three audit descriptions and filter entries.
- [ ] **Step 4: Run** web unit tests with coverage, lint, type-check and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): notes and replies in the item panel (FR-1.5)`.

### Task 7: Web: the @ list (FR-1.5)

**Files:**
- Create: `apps/web/src/notes/MentionPicker.tsx`, `apps/web/src/notes/mentionQuery.ts`, `apps/web/src/notes/mentionQuery.test.ts`, `apps/web/src/notes/NoteBox.test.tsx`
- Modify: `apps/web/src/notes/NoteBox.tsx`, `apps/web/e2e/notes.spec.ts`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `MemberName` (`{ userId, name }`) from the panel; `NOTE_LIMITS.mentionChoices`; `findMentions`; the placement function used by `Menu` (export it from `Menu.tsx` if it is private).
- Produces:
  - `mentionQueryAt(text: string, caret: number): { start: number; query: string } | null` — the `@…` being typed at the caret, or null. `start` is the index of the `@`.
  - `matchMembers(members: readonly MemberName[], query: string): MemberName[]` — names containing the query, case ignored, in name order, at most 8.
  - `insertMention(text: string, at: { start: number; query: string }, name: string): { text: string; caret: number }`.
  - `NoteBox` now calls `onSubmit(body, mentionIds)` with the ids of `findMentions(body, members)`.

- [ ] **Step 1: Write failing unit tests.**

```ts
test('FR-1.5: the query is the text after an @ that starts a word', () => {
  expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
  expect(mentionQueryAt('hi @an', 6)).toEqual({ start: 3, query: 'an' });
  expect(mentionQueryAt('hi @Ann Le', 10)).toEqual({ start: 3, query: 'Ann Le' });   // names have spaces
  expect(mentionQueryAt('mail a@b', 8)).toBeNull();
  expect(mentionQueryAt('hi @an\nnext', 11)).toBeNull();                               // a new line ends it
  expect(mentionQueryAt('hi @' + 'x'.repeat(41), 45)).toBeNull();                      // give up after 40 characters
});
test('FR-1.5: picking replaces the query with the name and a space', () => {
  expect(insertMention('hi @an', { start: 3, query: 'an' }, 'Ann Lee')).toEqual({ text: 'hi @Ann Lee ', caret: 12 });
  expect(insertMention('hi @an there', { start: 3, query: 'an' }, 'Ann Lee')).toEqual({ text: 'hi @Ann Lee there', caret: 12 });   // no second space
});
```

  Plus `matchMembers`: "an" matches "Ann", "Joanna" and "Dan" in name order; an empty query returns the first 8; no match returns `[]`. And `NoteBox.test.tsx`: typing "@a" opens a listbox named "People" with the matches and the first one active; Down, Down, Up moves `aria-activedescendant`; Enter inserts the name and does not submit; Escape closes the list and leaves the text; "No one matches." shows for "@zzz" and Enter then adds a new line as usual; clicking an option inserts it and the textarea keeps focus; submitting "hello @Ann Lee" calls `onSubmit` with Ann's id; deleting part of the name before submitting sends no id.
- [ ] **Step 2: Run** them. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement.** The list is rendered next to the textarea in the DOM and positioned fixed under it (above when there is no room), as `Menu` does. It closes on blur, on a scroll that moves the textarea, and when the query becomes null. With two members of the same name, both are listed with their email after the name in the list; the first one picked is the one recorded.
- [ ] **Step 4: Extend the E2E spec** (names starting "FR-1.5:"): a Contributor types "@", picks an Admin with the keyboard, adds the note, and the name shows highlighted, also after a reload; the notes API response for that note lists the Admin in `mentions`; at 375 px the list is inside the viewport; axe passes with the list open.
- [ ] **Step 5: Run** web unit tests with coverage, lint, type-check and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): mention people in a note with @ (FR-1.5)`.

### Task 8: Web: files in the item panel (FR-1.4)

**Files:**
- Create: `apps/web/src/attachments/useAttachments.ts`, `apps/web/src/attachments/AttachmentsSection.tsx`, `apps/web/src/attachments/AttachmentsSection.test.tsx`, `apps/web/e2e/attachments.spec.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/src/api/client.test.ts`, `apps/web/src/projects/ProjectPanel.tsx`, `apps/web/src/audit/describe.ts`, `apps/web/src/audit/AuditPage.tsx`, `apps/web/src/styles.css`, `apps/web/e2e/global-setup.ts`, `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes: Task 4's routes; `formatFileSize` and `NOTE_LIMITS` from `@roadmap/shared`. The web code and its tests import nothing from `apps/api`: the E2E spec builds the virus test string itself from two halves.
- Produces:
  - `upload<T>(path: string, file: File): Promise<T>` in `client.ts`: a `POST` with a `FormData` holding the file under `file`, the `x-csrf-token` header, no `content-type` header (the browser sets it), and the same error mapping and 401 handling as `api`.
  - `ATTACHMENTS_KEY(roadmapId, projectId) = ['attachments', roadmapId, projectId]`; `useAttachments`, `useUploadAttachment`, `useDeleteAttachment`, `downloadAttachment(roadmapId, projectId, id): Promise<void>` (gets the link, then `window.location.assign(url)`).
  - `AttachmentsSection({ roadmapId, item, editable, timeZone })`.
  - E2E global setup starts the API with `FILES=local`, a temp `FILES_DIR`, a generated `FILES_SIGNING_KEY`, and `SCANNER=fake`.

- [ ] **Step 1: Write failing tests.** Unit: `upload` sends the CSRF header and a `FormData`, maps an error body to `ApiError`, and does not set `content-type`; the section lists files with the second line as specified; no "Add file" or "Remove" when `editable` is false or the item is archived; a file over 25 MB or empty is refused in the browser with its message and no request; each error code maps to its copy; several chosen files upload one after another and one failure does not stop the rest. E2E (`attachments.spec.ts`, names starting "FR-1.4:"):
  - an Admin adds a small text file: "Uploading …" then the row with its name, "… B · {name} · {date}"; it is there after a reload
  - choosing "Download {name}" downloads a file with the same name and bytes (Playwright's download event)
  - a Contributor not assigned to the item sees the file and can download it, and has no "Add file" or "Remove"; an assigned Contributor has both
  - a file containing the test virus string is refused with "… was blocked because it failed the virus check." and no row appears; the audit log shows "tried to add a file that failed the virus check"
  - a file containing `SCANNER-DOWN` shows "Files can't be checked right now. Try again in a few minutes."
  - a file of 25 MB + 1 byte (made in the test with `Buffer.alloc`) shows the size message without a request being sent
  - "Remove", then "Remove file": the row goes, focus lands as specified, and the download link for it no longer works
  - an archived item lists and downloads its files and shows the archived message
  - deleting the item, then asking for its file's link through the API, is 404
  - the audit log shows "added a file" and "removed a file"
  - axe passes on the panel with files, during an upload, and with the remove dialog; no sideways scroll at 375 px with a 200-character file name
- [ ] **Step 2: Run** them. Expected: FAIL (no Files section).
- [ ] **Step 3: Implement** `upload`, the hooks and the section; render it after the form and before Notes. The file input is visually hidden and opened by the "Add file" button; it is reset after each choice so the same file can be chosen again. Add the three audit descriptions and filter entries.
- [ ] **Step 4: Run** web unit tests with coverage, lint, type-check and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): files on an item, with upload, download and remove (FR-1.4)`.

### Task 9: Deployment: ClamAV, upload size and the smoke test

**Files:**
- Modify: `deploy/poc/docker-compose.yml`, `deploy/poc/.env.example`, `deploy/poc/Caddyfile`, `scripts/smoke.sh`, `.github/workflows/ci.yml` (only if the smoke job needs new env)
- Create: `deploy/poc/docker-compose.smoke.yml` (only if needed to add MinIO for the smoke run)

**Interfaces:**
- Consumes: Task 3's config names.
- Produces: a `clamav` service (`clamav/clamav`, pinned by tag, not published, with a health check, a named volume for its signature database, `mem_limit: 2g`, and `read_only` where the image allows); the `api` service gets `SCANNER=clamd`, `CLAMD_HOST=clamav`, `FILES=s3`, `S3_BUCKET`, and `depends_on: clamav: condition: service_healthy`. `.env.example` documents every new variable with one line each and no real values.

- [ ] **Step 1: Extend `scripts/smoke.sh` first** so it fails: after its existing checks, sign in as it already does, create an item, upload a small file and expect 201, fetch the download link and expect the same bytes, upload the test virus string (built in the script from two halves) and expect 422 with `file_infected`. Run it against the current compose on the devbox. Expected: FAIL at the upload.
- [ ] **Step 2: Add the `clamav` service and env.** For the smoke run only, S3 is MinIO: put a `minio` service, a one-shot bucket-creating step and `S3_ENDPOINT` in `docker-compose.smoke.yml`, layered on with a second `-f`. The production compose file has no MinIO.
- [ ] **Step 3: Caddy.** Allow request bodies up to 26 MB on the attachments upload path only and keep the existing limit elsewhere; if the Caddyfile sets no limit today, add 1 MB for `/api/*` and 26 MB for that path, and add a smoke check that a 2 MB JSON body to another route is refused. Confirm the existing rate-limit zones still apply to the upload path.
- [ ] **Step 4: Run** the smoke script on the devbox against the layered compose project (project name starting `roadmap-`, no ports 80 or 443 published). Expected: PASS, including the refused virus file. Record ClamAV's start-up time and memory use (`docker stats --no-stream`) in the report. Take the project down and remove its volumes afterwards.
- [ ] **Step 5: Push and check CI.** `deploy-smoke` must pass with the new steps; if ClamAV's start-up pushes the job past its timeout, raise the timeout, do not skip the check.
- [ ] **Step 6: Commit** `feat(deploy): ClamAV service, upload size limit and smoke checks for files (FR-1.4)`.

---

## Next plans (v1)

1. Snapshots and PDF (FR-3), which reuses `packages/shared/src/timeline.ts` and must decide how notes appear (FR-3.5).
2. Notifications (FR-5): reads `mentions` from notes to send "you were mentioned", with per-user instant, digest or off.
3. Calendar feed (FR-4), POC infrastructure (the S3 bucket, its KMS key and the IAM role this plan assumes), and release hardening.

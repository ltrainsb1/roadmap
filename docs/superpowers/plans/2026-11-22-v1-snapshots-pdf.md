# v1 Snapshots and PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Owner or Admin can freeze a roadmap into a snapshot, share it by a link and a password with people who have no account, and those people can read it as a list or a timeline and download either as a PDF.

**Architecture:** Creating a snapshot copies the roadmap's live items (and, when chosen, notes and assignee names) into three new tenant-scoped collections inside one transaction; nothing in the copy points back at live data. The link carries a random id; the password is stored as an argon2 hash and a correct one earns a 12-hour cookie scoped to that link. Viewer routes are `public` in the policy hook and find their tenant from the link id. PDFs are made by a new small service, `apps/pdf`, that drives headless Chromium: the API hands it a path and a two-minute render token, Chromium opens the web app's own print page with that token, and the API stores the PDF in the object store so each is made once.

**Tech Stack:** As the earlier plans, plus `playwright-core` (the `apps/pdf` service) and `pdfjs-dist` (tests only, to read PDFs back). Before using either, read its current docs (the context7 tools) and do not rely on memory for its API.

**Spec:** `docs/prd.md`. Sections this plan implements: FR-3.1 to FR-3.6, the data model's Snapshot entity, "Snapshot passwords … are stored only as hashes", the audit-log rule "snapshot creation and access", and the Contract test layer's "PDF output renders".

**Builds on:** branch `v1-notes` (PR `ltrainsb1/roadmap#4`). Start branch `v1-snapshots` from it, or from whichever of `v1-views`, `v1-foundation` and `main` it has been merged into. Earlier decisions are in the four follow-ups documents in `docs/superpowers/plans/`.

**Not in this plan:** Rebuilding the roadmap as it was on a past date (the app keeps no item history). The vote-count toggle of FR-3.5 (votes arrive in v2; the toggle is added with them). A queue and worker for PDFs (the PRD's SQS design arrives with the production infrastructure plan; the `PdfRenderer` interface is where it plugs in). Changing a snapshot's password, name or expiry after it is made (revoke it and make another). A Board view in snapshots. Attached files in snapshots. Emailing the link.

## Global Constraints

Every constraint in the four earlier plans' Global Constraints sections still binds. The ones this plan leans on, and the new ones:

- Every query goes through `scoped()`, except the one lookup of a snapshot by its link id, which is added to `unscoped()` beside the other pre-auth lookups. Every route has `config.auth`. Admin routes use `can()` through the policy hook with the action `snapshot.create`.
- Creating and revoking a snapshot, a successful unlock, and a lock tripping each write an audit event. Audit events never carry the password, the link id, or any frozen text.
- The snapshot password is stored only as an argon2 hash (`hashPassword`). It is never logged, never returned, and never written to the audit log.
- What the Admin chose not to include is not copied at all: a snapshot made without notes has no rows in `snapshotNotes`, and one made without assignee names has no `assignees` field on its items.
- The page's content policy stays as it is. Nothing in this plan loosens it. Every new E2E spec calls `useCspGuard()`.
- Frozen text is as untrusted as live text: it is rendered by React and by the existing `Markdown` component, never through `innerHTML`.
- The PDF service renders only paths that match `^/s/[A-Za-z0-9_-]{20,64}/print/(list|timeline)$` on its one configured origin, and Chromium is blocked from requesting any other origin. It is never reachable from outside the Compose network.
- With `NODE_ENV=production`, config loading fails unless `PDF=service`.
- Definition of done for every task: unit tests for pure code, API tests for routes (including one "Tenant isolation: …" test and the forbidden roles per admin route), E2E for screens, coverage at 80% or more in every package (`pnpm run test --coverage` from the repo root), axe passes on each new screen state, each screen works from 375 px wide with no sideways page scroll, and the FR id appears in the test name.
- All tests run as GitHub Actions in the existing jobs. Check the CI result after every push. No test retries, no fixed waits, and no wall-clock limits under 5 seconds (a 1-second limit failed on the CI runner in the last plan).
- Docker runs on the devbox through the SSH tunnel, never on the Mac. On the devbox, touch only containers, images and volumes whose names start with `roadmap-`, never run `docker system prune`, never publish ports 80 or 443, and remove what you started. Tests that need a real browser are skipped unless `TEST_PDF=chromium` is set; CI sets it in the `e2e` job, where Chromium is already installed.
- On-screen copy follows the `mobbin:plain-writing` rules and the exact text in the UI/UX plan below. E2E tests assert that text word for word.
- Commit trailers name the model that wrote the commit.
- **Plan decisions where the PRD is silent** (change them here and every task follows):
  - *What "as of" means* (the user's choice). A snapshot copies the roadmap as it is at the moment it is created. The "as of" date in its header is a label the Admin picks: today by default, or any earlier day. The API accepts a date up to one day after the server's UTC date, so "today" works in every time zone.
  - *What is copied.* Every item that is not archived and has no archived ancestor, with its title, description, status, dates, milestones, tags, links, priority label, order, and its blocked-by list cut down to items that are also in the snapshot. Warnings, versions and who created an item are not copied.
  - *Notes* (the user's choice). When included, every note and reply on a copied item, with its text, its author's name at that moment, its time, whether it was edited, and the names it mentions. A deleted top note that still has replies is copied as a placeholder. Attached files are never copied. Notes are read in the list view and its PDF; the timeline shows none.
  - *Assignee names.* When included, each item carries the names of the people assigned to it at that moment. No ids or emails.
  - *Limits.* 50 snapshots per roadmap. A snapshot holds at most 5,000 notes; with more, it must be made without notes. A name is 1 to 80 characters. A password is 10 to 128 characters; it is not checked against breach lists.
  - *The link* is `{APP_ORIGIN}/s/{linkId}`, where `linkId` is 24 random bytes as base64url. It is stored as it is, so Admins can copy it again later; the password is what protects the snapshot.
  - *Expiry.* Optional. The browser sends the end of the chosen day in the Admin's own time zone as an instant; it must be in the future and at most 730 days away. An expired snapshot stays in the Admin's list, marked "Expired", until it is revoked.
  - *Revoking* deletes the snapshot: its frozen items and notes, its viewer sessions and its stored PDFs. The link then answers as if it never existed. Deleting the roadmap does the same for all of its snapshots.
  - *Wrong passwords* (FR-3.6). The fifth wrong password in a row locks the link for 15 minutes, the same numbers as sign-in. While it is locked every password is refused, the right one included. A right password resets the count. The unlock route is also rate-limited per IP at the sign-in rate.
  - *A viewer's session* lasts 12 hours and is a cookie named `__Secure-snap` with `Path=/api/snapshots/{linkId}`, `HttpOnly`, `Secure`, `SameSite=Strict`, so one browser can hold several snapshots open.
  - *What a stranger learns from a link with no password:* whether it exists and whether it has expired. Not the roadmap's name.
  - *PDFs* (the user's choice of a separate container with no queue). Two per snapshot at most: list and timeline, A4 landscape. The timeline is scaled to fit the page width. The list PDF has every item's details and notes written out. Each is made the first time someone asks and kept until the snapshot is revoked. At most 2 are being made at once per API process; a third request is refused at once with "try again".
  - *Times* in a snapshot are shown in the viewer's own browser time zone; in a PDF they are UTC and say so.
  - *Search engines.* Snapshot pages send `X-Robots-Tag: noindex, nofollow`.

## Review Focus

- A snapshot made without notes or without assignee names: the content answer, the notes route and both PDFs contain no note text, no author and no assignee name anywhere in their bytes. (Tasks 2, 3 and 8)
- After a snapshot is made, an item is renamed, re-dated, archived and deleted, a note is edited and deleted, and a member is removed: the snapshot's content and PDFs are unchanged. Deleting the roadmap removes the snapshot, its rows, its sessions and its stored PDFs. (Tasks 2 and 5)
- Twenty wrong passwords sent at the same moment, then the right one: the link is locked, the right password is refused until the lock ends, and it works afterwards. (Task 3)
- A cookie or render token earned for snapshot A, sent to snapshot B's routes; a live session on a snapshot that has since expired or been revoked; a render token used after two minutes: every one is refused. (Tasks 3 and 5)
- The PDF service is down, slow, or returns something that is not a PDF; a roadmap of 2,000 items and 5,000 notes: the viewer sees "try again", nothing is stored, the in-flight count goes back down, and the next request works. (Tasks 4, 5 and 8)

---

## File Structure

```
packages/shared/src/
  snapshots.ts                  SNAPSHOT_LIMITS, schemas and types for the admin list, the viewer content and the requests
  schemas.ts                    four new audit actions
  project-rules.ts, timeline.ts buildTree and timelineRange accept any item with the fields they read; fitTimeline
apps/api/src/
  config.ts                     PDF, PDF_URL, PDF_TIMEOUT_MS
  db/types.ts, scoped.ts, indexes.ts, unscoped.ts   four new collections, insertMany, findSnapshotByLinkId
  auth/lockout.ts               the counting algorithm, usable for users and for snapshots
  snapshots/freeze.ts           freezeRoadmap
  snapshots/store.ts            deleteSnapshots (shared by revoke and roadmap delete)
  snapshots/routes.ts           admin: list, create, revoke
  snapshots/access.ts           viewer sessions, render tokens, snapshotAccess
  snapshots/public-routes.ts    viewer: status, unlock, content, an item's notes, pdf
  snapshots/pdf-renderer.ts     PdfRenderer, HttpPdfRenderer, FakePdfRenderer, createPdfRenderer
  members/routes.ts             roadmap delete calls deleteSnapshots
  logging.ts                    link ids shortened in request logs
apps/pdf/                       new package @roadmap/pdf
  src/server.ts, app.ts         POST /render, GET /health
  src/limiter.ts                at most N renders at once
  src/chromium.ts               the Playwright adapter
  Dockerfile
apps/web/src/
  snapshots/useSnapshots.ts     admin queries and mutations
  snapshots/SnapshotsPage.tsx, CreateSnapshotDialog.tsx
  viewer/useSnapshot.ts         viewer queries, unlock, pdf
  viewer/SnapshotGate.tsx       password page and the not-found, expired and locked states
  viewer/SnapshotLayout.tsx     header, tabs, Download PDF
  viewer/SnapshotList.tsx, SnapshotItemDetails.tsx, SnapshotNotes.tsx
  viewer/SnapshotTimeline.tsx
  viewer/PrintPage.tsx          /s/:linkId/print/:view
  projects/timelineParts.tsx    Track moved here from TimelineView.tsx; TimelineAxis takes a marker label
  roadmaps/RoadmapLayout.tsx    "Snapshots" tab for Owners and Admins
  audit/describe.ts, AuditPage.tsx   the four new actions
deploy/poc/                     pdf service, internal listener in the Caddyfile, env example
```

## UI/UX plan

References looked at (Mobbin, web):

- One dialog that sets a link's name, password and expiry, then shows the link to copy: [Dropbox](https://mobbin.com/screens/2c727400-dc3c-4d94-b213-8001b2c90909?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp) (a name "only visible to you", an expiry date behind a checkbox), [Salesforce](https://mobbin.com/screens/8c241c5c-9ef5-4174-89ea-d867c43f2d56?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp) (the link in a field with a copy button and "Link copied"), [Adobe Express](https://mobbin.com/screens/b0227a7b-07f8-4caf-8704-5888aac497c9?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp) (the password rule stated under the field, with show and hide).
- The password page is one short heading, one field and one button, with nothing else on it: [Tally](https://mobbin.com/screens/8a8bee17-6687-49dd-b1ec-ccbca852de49?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Synthesia](https://mobbin.com/screens/a6255932-24b6-4dd6-8b93-e1409f8884ac?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). A line telling people without the password whom to ask: [Frame.io](https://mobbin.com/screens/42c974a5-ae70-4dfd-922a-9952279e3022?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).
- A plain list of links with dates and one action to end each: [Slack](https://mobbin.com/screens/46611543-dd57-487d-8bf2-8024a08ff7ab?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Grok](https://mobbin.com/screens/7bd7b8f5-bed2-4f09-823f-bec32fa74043?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp) (a view count on each row). The confirmation says what happens to people who have the link: [Proton](https://mobbin.com/screens/0e684d51-d002-42eb-8149-2058cdadc7e8?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

**Admin: the Snapshots tab** (`/r/:roadmapId/snapshots`, shown to Owners and Admins after "Members"). A heading, one sentence, a "Create snapshot" button, then a list with one card per snapshot, newest first. A card shows the name, a status badge, four lines of facts, and three actions with 44 px targets. "Open" is a link to `/s/{linkId}` in a new tab.

**Admin: the create dialog.** One form in the existing dialog style: Name, As of (a date input, today by default, no later than today), Password with a "Show password" checkbox, "Link expires" as two radios with a date input that appears for "On a date", and an "Include" group of two checkboxes, both off by default. On success the same dialog changes to its second state: the link in a read-only field with "Copy link", and "Done". Focus moves to the dialog's heading when the state changes.

**Viewer: the password page** (`/s/:linkId`). No app header, no navigation, no roadmap name. A centred card with the heading, one line, the password field and the button. The not-found and expired states are the same card with a heading and one line and no field.

**Viewer: the snapshot** (`/s/:linkId/list` and `/s/:linkId/timeline`). A header with the roadmap's name as the `h1`, "As of {date}" under it, two tabs and "Download PDF". The page title is "{roadmap name}: snapshot".

- *List.* A table: Name, Status, Dates, Priority, and "Assigned to" when names are included. Items are nested and collapsible with the same chevron as the app's List. The title is a button with `aria-expanded` that opens a details row under the item: Description, Milestones, Tags, Links, Blocked by, and Notes when included. Each part is shown only when it has something in it. Notes load when the details open. Below 600 px the table becomes stacked cards, as the app's List does.
- *Timeline.* The app's Timeline without its controls: the name column, the axis, the bars and milestones, and a Zoom select. The line that marks today in the app sits on the "as of" date here and is labelled "As of".
- *Download PDF* downloads the PDF of the view being looked at. While it is being made the button is disabled and a polite status says so.

**Print pages** (`/s/:linkId/print/list`, `/s/:linkId/print/timeline`). What Chromium turns into the PDF: the header, then the list with every item open and every note written out, or the timeline scaled to the page width. No buttons, tabs or chevrons. Each page's footer reads "{roadmap name} · As of {date} · Page {n} of {total}".

Copy (exact):

| Where | Text |
| --- | --- |
| Tab, page heading | "Snapshots" |
| Under the heading | "A snapshot is a frozen copy of this roadmap. People without an account open it with a link and a password." |
| No snapshots | "No snapshots yet." |
| Create button, dialog submit | "Create snapshot" |
| Dialog heading | "Create a snapshot" |
| Name field, hint | "Name" / "Only your team sees this name." |
| As of field, hint | "As of" / "The date shown at the top. The snapshot holds the roadmap as it is right now." |
| Password field, hint | "Password" / "At least 10 characters. Send it separately from the link." |
| Show password | "Show password" |
| Expiry group, options | "Link expires" / "Never" / "On a date" |
| Expiry date field, hint | "Expiry date" / "The link stops working at the end of this day." |
| Include group, options | "Include" / "Notes" / "Assignee names" |
| Hint under "Notes" | "Notes are shown with their authors' names. Files are never included." |
| Cancel | "Cancel" |
| Name empty | "Enter a name." |
| Password too short | "Use at least 10 characters." |
| As of in the future | "Choose today or an earlier date." |
| Expiry not in the future | "Choose a date after today." |
| Expiry too far | "Choose a date within two years." |
| Too many snapshots | "This roadmap already has 50 snapshots. Revoke one to create another." |
| Too many notes | "This roadmap has more than 5,000 notes. Create the snapshot without notes." |
| Second state heading | "Snapshot created" |
| Second state text | "Send this link to the people who should see it. Send the password separately." |
| Link field | "Link" |
| Copy control, status after | "Copy link" / "Link copied." |
| Copy failed | "Couldn't copy the link. Select it and copy it yourself." |
| Close second state | "Done" |
| Card badges | "Active", "Expired", "Locked until {time}" |
| Card line 1 | "As of {date}" |
| Card line 2 | "Created by {person} on {date}" |
| Card line 3 | "Expires {date}" or "No expiry" |
| Card line 4 | "Opened {n} times, last on {date}" (or "Opened once, on {date}") or "Not opened yet" |
| Card line 5, when anything is included | "Shows notes and assignee names." / "Shows notes." / "Shows assignee names." |
| Card actions | "Copy link", "Open", "Revoke"; accessible names "Copy link to {name}", "Open {name}", "Revoke {name}" |
| Revoke dialog | "Revoke {name}?" / "The link stops working for everyone and the snapshot is deleted. This can't be undone." / "Revoke snapshot" / "Cancel" |
| List failed to load | "Couldn't load snapshots. Try again." with a "Try again" button |
| Audit log | "{who} created a snapshot.", "{who} revoked a snapshot.", "A snapshot was opened.", "A snapshot link was locked after too many wrong passwords."; filter labels "Snapshot created", "Snapshot revoked", "Snapshot opened", "Snapshot link locked" |
| Password page heading | "This snapshot is password protected" |
| Password page text | "Enter the password you were given." |
| Field, button | "Password" / "View snapshot" |
| Under the button | "If you don't have the password, ask the person who sent you the link." |
| Wrong password | "That password isn't right." |
| Locked | "Too many wrong passwords. Try again in 15 minutes." |
| Rate limited | "Too many attempts. Wait a minute and try again." |
| Session ended while viewing | "Enter the password again to keep viewing." |
| Link not found | "This link doesn't work" / "The snapshot may have been removed. Ask the person who sent it for a new link." |
| Link expired | "This link has expired" / "Ask the person who sent it for a new link." |
| Header | "{roadmap name}" / "As of {date}" |
| Tabs | "List", "Timeline" |
| PDF control | "Download PDF" |
| PDF being made | "Preparing the PDF…" |
| PDF failed | "Couldn't create the PDF. Try again." |
| PDF busy | "Other PDFs are being prepared. Try again in a minute." |
| No items | "This snapshot has no items." |
| Columns | "Name", "Status", "Dates", "Priority", "Assigned to" |
| Title button, accessible name | "Details for {title}" |
| Details headings | "Description", "Milestones", "Tags", "Links", "Blocked by", "Notes" |
| No notes on an item | "No notes." |
| Notes failed to load | "Couldn't load notes. Try again." with a "Try again" button |
| Note marks | "Edited", "This note was deleted.", "Former member" (as in the app) |
| Timeline marker | "As of" |
| Zoom | "Zoom" with "Weeks", "Months", "Quarters", as in the app |
| PDF footer | "{roadmap name} · As of {date} · Page {n} of {total}" |
| PDF time note, list PDF with notes | "Times are in UTC." |

Accessibility: errors are `role="alert"`; "Link copied.", "Preparing the PDF…" are polite statuses; the status badge is text, not colour alone; after a revoke, focus moves to the next card's "Copy link", else the previous one's, else "Create snapshot"; the password field has `autocomplete="off"` on the create dialog and `autocomplete="current-password"` on the viewer page; when the snapshot loads after a correct password, focus moves to the `h1`.

---

### Task 1: Shared rules for snapshots

**Files:**
- Create: `packages/shared/src/snapshots.ts`, `packages/shared/src/snapshots.test.ts`
- Modify: `packages/shared/src/index.ts`, `schemas.ts` (audit actions), `project-rules.ts`, `timeline.ts` and their tests

**Interfaces:**
- Consumes: `calendarDateSchema`, `milestoneSchema`, `linkSchema`, `PROJECT_STATUSES`, `PRIORITY_LABELS`, `Project`, `timelineRange`, `TimelineRange`, `TimelineZoom`.
- Produces:

```ts
export const SNAPSHOT_LIMITS = { name: 80, passwordMin: 10, passwordMax: 128, perRoadmap: 50, notes: 5000, maxExpiryDays: 730 } as const;
export const SNAPSHOT_VIEWS = ['list', 'timeline'] as const;
export type SnapshotView = (typeof SNAPSHOT_VIEWS)[number];

export const snapshotIncludeSchema = z.object({ notes: z.boolean(), assignees: z.boolean() });
export const createSnapshotRequestSchema = z.object({
  name: z.string().trim().min(1).max(SNAPSHOT_LIMITS.name),
  asOf: calendarDateSchema,
  password: z.string().min(SNAPSHOT_LIMITS.passwordMin).max(SNAPSHOT_LIMITS.passwordMax),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  include: snapshotIncludeSchema,
});
export const createSnapshotResponseSchema = z.object({ id: z.string(), linkId: z.string() });

// Admin list
export const snapshotSummarySchema = z.object({
  id: z.string(), linkId: z.string(), name: z.string(), asOf: calendarDateSchema,
  createdAt: z.string(), createdByName: z.string().nullable(), expiresAt: z.string().nullable(),
  include: snapshotIncludeSchema, itemCount: z.number().int(), noteCount: z.number().int(),
  lockedUntil: z.string().nullable(), openCount: z.number().int(), lastOpenedAt: z.string().nullable(),
});
export const snapshotListSchema = z.object({ snapshots: z.array(snapshotSummarySchema) });

// Viewer
export const snapshotItemSchema = z.object({
  id: z.string(), parentId: z.string().nullable(), depth: z.number().int().min(1).max(4),
  title: z.string(), description: z.string(), status: z.enum(PROJECT_STATUSES),
  startDate: calendarDateSchema.nullable(), endDate: calendarDateSchema.nullable(),
  milestones: z.array(milestoneSchema), tags: z.array(z.string()), links: z.array(linkSchema),
  blockedBy: z.array(z.string()), priorityLabel: z.enum(PRIORITY_LABELS).nullable(), rank: z.number().int(),
  assignees: z.array(z.string()).optional(),   // names; absent when not included
  noteCount: z.number().int().optional(),      // absent when notes are not included
});
export const snapshotNoteSchema = z.object({
  id: z.string(), itemId: z.string(), parentId: z.string().nullable(), authorName: z.string().nullable(),
  body: z.string(), mentions: z.array(z.string()), createdAt: z.string(), edited: z.boolean(), deleted: z.boolean(),
});
export const snapshotContentSchema = z.object({
  roadmapName: z.string(), asOf: calendarDateSchema, frozenAt: z.string(), include: snapshotIncludeSchema,
  items: z.array(snapshotItemSchema),
  notes: z.array(snapshotNoteSchema).optional(), // only when asked for with ?notes=all
});
export const snapshotNotesSchema = z.object({ notes: z.array(snapshotNoteSchema) });
export const snapshotStatusSchema = z.object({ unlocked: z.boolean() });
export const unlockRequestSchema = z.object({ password: z.string().min(1).max(SNAPSHOT_LIMITS.passwordMax) });
export const snapshotPdfRequestSchema = z.object({ view: z.enum(SNAPSHOT_VIEWS) });
// plus the inferred types: CreateSnapshotRequest, SnapshotSummary, SnapshotItem, SnapshotNote, SnapshotContent

/** 'expired' once `expiresAt` has passed. */
export function snapshotState(s: { expiresAt: string | null }, now: Date): 'active' | 'expired';

// project-rules.ts: generic over what it reads
export interface TreeNode<T = Project> { item: T; children: TreeNode<T>[]; position: number }
export function buildTree<T extends { id: string; parentId: string | null; rank: number }>(items: readonly T[]): TreeNode<T>[];
// timeline.ts
export function timelineRange(items: readonly Pick<Project, 'startDate' | 'endDate' | 'milestones'>[], today: string, zoom: TimelineZoom): TimelineRange;
/** The whole range scaled to exactly `width` px. Zoom by span: up to 120 days 'weeks', up to 1,100 'months', else 'quarters'. */
export function fitTimeline(items: readonly Pick<Project, 'startDate' | 'endDate' | 'milestones'>[], today: string, width: number): { range: TimelineRange; zoom: TimelineZoom };
```

- Audit actions added to `AUDIT_ACTIONS`: `'snapshot.create'`, `'snapshot.revoke'`, `'snapshot.access'`, `'snapshot.locked'`.

- [ ] **Step 1: Write the failing tests** in `snapshots.test.ts` and `timeline.test.ts`:

```ts
test('FR-3.2: a snapshot request needs a name, a real date, and a password of 10 to 128 characters', () => {
  const ok = { name: ' Board review ', asOf: '2026-03-12', password: 'correct-horse', expiresAt: null, include: { notes: false, assignees: false } };
  expect(createSnapshotRequestSchema.parse(ok).name).toBe('Board review');
  expect(createSnapshotRequestSchema.safeParse({ ...ok, password: 'ninechars' }).success).toBe(false);
  expect(createSnapshotRequestSchema.safeParse({ ...ok, password: 'x'.repeat(129) }).success).toBe(false);
  expect(createSnapshotRequestSchema.safeParse({ ...ok, name: '   ' }).success).toBe(false);
  expect(createSnapshotRequestSchema.safeParse({ ...ok, asOf: '2026-02-30' }).success).toBe(false);
  expect(createSnapshotRequestSchema.safeParse({ ...ok, expiresAt: '2026-04-01' }).success).toBe(false);
  expect(createSnapshotRequestSchema.safeParse({ ...ok, expiresAt: '2026-04-01T21:59:59.999Z' }).success).toBe(true);
});
test('FR-3.2: a snapshot is expired from the instant its expiry passes', () => {
  const at = new Date('2026-04-01T00:00:00.000Z');
  expect(snapshotState({ expiresAt: null }, at)).toBe('active');
  expect(snapshotState({ expiresAt: '2026-04-01T00:00:00.001Z' }, at)).toBe('active');
  expect(snapshotState({ expiresAt: '2026-04-01T00:00:00.000Z' }, at)).toBe('expired');
});
test('FR-3.4: fitTimeline scales the whole range to the width and picks the zoom by span', () => {
  const item = (startDate: string, endDate: string) => ({ startDate, endDate, milestones: [] });
  const short = fitTimeline([item('2026-03-10', '2026-03-20')], '2026-03-15', 700);
  expect(short.zoom).toBe('weeks');
  expect(short.range.days).toBe(timelineRange([item('2026-03-10', '2026-03-20')], '2026-03-15', 'weeks').days);
  expect(short.range.width).toBeCloseTo(700, 3);
  expect(short.range.width).toBeLessThanOrEqual(700);
  expect(fitTimeline([item('2026-01-01', '2026-12-31')], '2026-06-01', 700).zoom).toBe('months');
  expect(fitTimeline([item('2026-01-01', '2030-12-31')], '2026-06-01', 700).zoom).toBe('quarters');
});
test('FR-3.3: buildTree nests any item that has id, parentId and rank', () => {
  const tree = buildTree([{ id: 'b', parentId: 'a', rank: 0 }, { id: 'a', parentId: null, rank: 0 }]);
  expect(tree.map((n) => n.item.id)).toEqual(['a']);
  expect(tree[0]!.children.map((n) => n.item.id)).toEqual(['b']);
});
```

- [ ] **Step 2: Run them and see them fail.** `pnpm --filter @roadmap/shared test` → the new tests fail on missing exports.
- [ ] **Step 3: Implement.** `fitTimeline` calls `timelineRange` with the chosen zoom, then replaces `dayWidth` with `Math.floor((width / days) * 1e6) / 1e6` and `width` with `days * dayWidth`. The two widened signatures change no behaviour; the existing tests must pass untouched.
- [ ] **Step 4: Run** `pnpm --filter @roadmap/shared test` and `pnpm typecheck` → all pass (the web and API packages still compile against the widened types).
- [ ] **Step 5: Commit** `feat(shared): snapshot schemas, limits and a timeline that fits a width (FR-3)`.

### Task 2: API: freezing, listing and revoking (FR-3.1, FR-3.2, FR-3.5)

**Files:**
- Create: `apps/api/src/snapshots/freeze.ts`, `store.ts`, `routes.ts`; `apps/api/test/snapshots/admin.test.ts`, `freeze.test.ts`
- Modify: `apps/api/src/db/types.ts`, `scoped.ts`, `indexes.ts`, `unscoped.ts`, `app.ts`, `members/routes.ts` (roadmap delete)

**Interfaces:**
- Consumes: Task 1's schemas; `hashPassword`; `createAuditLog`; `ObjectStore`; `deleteStoredFiles`.
- Produces:

```ts
// db/types.ts
export interface SnapshotDoc {
  _id: string; tenantId: string; roadmapId: string;
  linkId: string; name: string; asOf: string; roadmapName: string;
  include: { notes: boolean; assignees: boolean };
  passwordHash: string; expiresAt: Date | null;
  itemCount: number; noteCount: number;
  failedUnlocks: number; lockedUntil: Date | null;
  openCount: number; lastOpenedAt: Date | null;
  /** Object-store keys of the PDFs made so far. */
  pdfs: { list?: string; timeline?: string };
  createdBy: string; createdAt: Date;
}
export interface SnapshotItemDoc { _id: string; tenantId: string; roadmapId: string; snapshotId: string; itemId: string; /* then the SnapshotItem fields except id */ }
export interface SnapshotNoteDoc { _id: string; tenantId: string; roadmapId: string; snapshotId: string; itemId: string; noteId: string; parentId: string | null; authorName: string | null; body: string; mentions: string[]; createdAt: Date; edited: boolean; deleted: boolean }
export interface SnapshotSessionDoc { _id: string; tenantId: string; snapshotId: string; tokenHash: string; kind: 'viewer' | 'render'; expiresAt: Date }

// db/scoped.ts: collections 'snapshots' | 'snapshotItems' | 'snapshotNotes' | 'snapshotSessions', and on every collection:
insertMany(docs: Array<Omit<T, 'tenantId'>>): Promise<void>;   // no-op for an empty array
// db/unscoped.ts
findSnapshotByLinkId(linkId: string): Promise<SnapshotDoc | null>;

// snapshots/freeze.ts — call inside a transaction
export async function freezeRoadmap(s: ScopedDb, input: { roadmapId: string; snapshotId: string; include: { notes: boolean; assignees: boolean }; maxNotes: number }): Promise<{ itemCount: number; noteCount: number }>;  // throws HttpError(422, 'too_many_notes')
// snapshots/store.ts — call inside a transaction; returns the PDF keys to delete from the object store afterwards
export async function deleteSnapshots(s: ScopedDb, filter: { roadmapId: string; snapshotId?: string }): Promise<{ deleted: number; keys: string[] }>;
// snapshots/routes.ts
export function registerSnapshotRoutes(app: FastifyInstance, deps: { now: () => Date; objectStore: ObjectStore; maxSnapshots?: number; maxNotes?: number }): void;
```

- Indexes: `snapshots`: `{ linkId: 1 }` unique, `{ tenantId: 1, roadmapId: 1, createdAt: -1 }`; `snapshotItems`: `{ tenantId: 1, snapshotId: 1 }`; `snapshotNotes`: `{ tenantId: 1, snapshotId: 1, itemId: 1, createdAt: 1 }`; `snapshotSessions`: `{ tokenHash: 1 }` unique, `{ tenantId: 1, snapshotId: 1 }`, `{ expiresAt: 1 }` with `expireAfterSeconds: 0`.
- Routes, all `config.auth: { level: 'full', action: 'snapshot.create' }`:
  - `GET /api/roadmaps/:roadmapId/snapshots` → 200 `snapshotListSchema`, newest first. `createdByName` is null when the user is gone.
  - `POST /api/roadmaps/:roadmapId/snapshots` (body `createSnapshotRequestSchema`) → 201 `createSnapshotResponseSchema`. 422 `as_of_in_future` when `asOf` is more than one day after the UTC date of `now()`; 422 `expiry_in_past`; 422 `expiry_too_far` (more than 730 days); 422 `too_many_snapshots`; 422 `too_many_notes`. One transaction: count, insert the snapshot, `freezeRoadmap`, set the counts, audit `snapshot.create` with `after: { name, asOf, include, expiresAt }`.
  - `DELETE /api/roadmaps/:roadmapId/snapshots/:snapshotId` → 204; 404 `not_found` for an id not in this roadmap. One transaction: `deleteSnapshots`, audit `snapshot.revoke` with `before: { name }`; then `deleteStoredFiles` for the keys.
- `freezeRoadmap` reads the roadmap's projects, drops every item that is archived or has an archived id in its `path`, filters each `blockedBy` to kept ids, resolves assignee names from `users` only when `include.assignees`, and reads notes only when `include.notes`. A note's `mentions` become the mentioned names. A deleted placeholder keeps `body: ''`, `authorName: null`, `deleted: true`. `linkId` is `randomBytes(24).toString('base64url')`.

- [ ] **Step 1: Write the failing tests.** Names and what each asserts:
  - `FR-3.1: a snapshot copies every live item and leaves out archived items and everything under them` — three levels with one archived branch; the `snapshotItems` rows are exactly the live ones, and a `blockedBy` that pointed at the archived item is empty.
  - `FR-3.1: later edits do not change a snapshot` — after creating: rename an item, change its dates, archive one, delete one, edit a note, delete a note, remove the assignee from the roadmap; the `snapshotItems` and `snapshotNotes` rows are deep-equal to what they were.
  - `FR-3.5: a snapshot made without notes or assignee names holds neither` — `snapshotNotes` has 0 rows for it, no item row has an `assignees` or `noteCount` key, and `JSON.stringify` of all its rows contains neither the note's text nor the assignee's name.
  - `FR-3.5: a snapshot made with both holds note text, author names, mentioned names and assignee names, and no user id or email` — the stringified rows contain none of the tenant's user ids or emails.
  - `FR-3.5: a deleted top note with replies is copied as a placeholder with its replies`.
  - `FR-3.2: the password is stored only as an argon2 hash` — `passwordHash` starts with `$argon2`, and the password appears nowhere in the snapshot row or in the audit event.
  - `FR-3.2: the list never returns the password hash`.
  - `FR-3.1: asOf may be today or earlier, and tomorrow by UTC, but not later` (clock fixed with `deps.now`).
  - `FR-3.2: an expiry in the past or more than 730 days away is refused`.
  - `FR-3.1: the 51st snapshot is refused` (with `maxSnapshots: 2`) and `FR-3.5: more notes than the limit is refused unless notes are left out` (with `maxNotes: 3`); after either refusal no snapshot, item or note row was written.
  - `FR-3.2: revoking deletes the snapshot, its items, notes and sessions, and its stored PDFs` (seed a `pdfs.list` key and an object in a `MemoryObjectStore`).
  - `FR-3.2: deleting the roadmap deletes its snapshots and their stored PDFs`.
  - `FR-3.1: a Contributor can't list, create or revoke snapshots` → 403 each.
  - `Tenant isolation: another tenant's Admin can't list, create in, or revoke from this roadmap` → 404 each, and nothing changed.
  - `FR-3.1: an item edited at the same moment as the freeze is copied whole, old or new` — `Promise.all` of a create and an item edit, 20 rounds; each frozen item equals either the before or the after document, never a mix.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test -- snapshots` → they fail (routes missing).
- [ ] **Step 3: Implement** types, collections, `insertMany`, indexes, `findSnapshotByLinkId`, `freezeRoadmap`, `deleteSnapshots`, the three routes, the registration in `app.ts`, and the call in roadmap delete.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → all pass.
- [ ] **Step 5: Commit** `feat(api): create, list and revoke snapshots (FR-3.1, FR-3.2, FR-3.5)`.

### Task 3: API: opening a snapshot with its password (FR-3.2, FR-3.3, FR-3.6)

**Files:**
- Create: `apps/api/src/snapshots/access.ts`, `public-routes.ts`; `apps/api/test/snapshots/viewer.test.ts`
- Modify: `apps/api/src/auth/lockout.ts` (and its callers), `app.ts` (rate-limit list, registration), `logging.ts`

**Interfaces:**
- Consumes: Task 2's documents and `findSnapshotByLinkId`; `verifyPassword`; `newToken`, `hashToken`; `MAX_FAILURES`, `LOCK_MS`.
- Produces:

```ts
// auth/lockout.ts — one algorithm, two homes. The existing exports keep their names and behaviour for users.
export function createLockout<N extends 'users' | 'snapshots'>(collection: N, countField: N extends 'users' ? 'failedLogins' : 'failedUnlocks'): {
  recordFailure(s: ScopedDb, id: string, now?: Date): Promise<{ lockedNow: boolean }>;
  assertNotLocked(s: ScopedDb, id: string, now: Date): Promise<boolean>;
  recordSuccess(s: ScopedDb, id: string): Promise<void>;
};

// snapshots/access.ts
export const SNAPSHOT_COOKIE = '__Secure-snap';
export const VIEWER_SESSION_MS = 12 * 60 * 60_000;
export const RENDER_TOKEN_MS = 2 * 60_000;
export const RENDER_HEADER = 'x-snapshot-render';
export async function createSnapshotSession(s: ScopedDb, snapshotId: string, kind: 'viewer' | 'render', now: Date): Promise<string>; // the token
/** Finds the snapshot for the link and checks the cookie or the render header. Throws 404 not_found, 410 snapshot_expired, 401 password_required. */
export async function snapshotAccess(req: FastifyRequest, db: Db, now: Date): Promise<{ snapshot: SnapshotDoc; db: ScopedDb; via: 'viewer' | 'render' }>;
// snapshots/public-routes.ts
export function registerSnapshotPublicRoutes(app: FastifyInstance, deps: { db: Db; now: () => Date }): void;
```

- Routes, all `config.auth: { level: 'public' }` and all answered with `Cache-Control: no-store`:
  - `GET /api/snapshots/:linkId` → 200 `{ unlocked }`; 404 `not_found`; 410 `snapshot_expired`.
  - `POST /api/snapshots/:linkId/unlock` (body `unlockRequestSchema`) → 204 and the cookie; 401 `wrong_password`; 423 `snapshot_locked`; 404; 410. On success: reset the count, add 1 to `openCount`, set `lastOpenedAt`, audit `snapshot.access` (actor `system`, target the snapshot, the request's IP). When a failure trips the lock: audit `snapshot.locked`.
  - `GET /api/snapshots/:linkId/content` → 200 `snapshotContentSchema`. `?notes=all` adds every note, and is answered only when the snapshot includes notes (otherwise the field is absent).
  - `GET /api/snapshots/:linkId/items/:itemId/notes` → 200 `snapshotNotesSchema`, oldest first; 404 when the snapshot has no notes or no such item.
- Unlock runs exactly one argon2 verification on every call, as sign-in does: against the stored hash when the link exists, is not expired and is not locked, otherwise against a dummy hash made once at start-up, as the sign-in route does with its own. After a correct password it checks `assertNotLocked` again before issuing the cookie.
- The rate limiter's allow-list in `app.ts` also limits the route whose pattern is `/api/snapshots/:linkId/unlock`.
- `serializeRequest` in `logging.ts` writes `/api/snapshots/{first 6 characters}…` in place of the full link id.

- [ ] **Step 1: Write the failing tests:**
  - `FR-3.2: the right password opens the snapshot for 12 hours` — the `Set-Cookie` has `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/snapshots/{linkId}`, `Max-Age=43200`; content is 200 with the cookie, and 401 `password_required` one millisecond after 12 hours (clock moved with `deps.now`).
  - `FR-3.2: without the cookie, content and notes answer 401 and say nothing about the roadmap` — the body is exactly `{ error: 'password_required' }`.
  - `FR-3.3: content has the roadmap's name, the as-of date and every frozen item in order`.
  - `FR-3.5: content and the notes route give no notes when the snapshot has none, even with ?notes=all`.
  - `FR-3.5: an item's notes come oldest first with author names and no ids of people`.
  - `FR-3.6: the fifth wrong password locks the link for 15 minutes, and the right password is refused until then` — four 401s, then 423 on the fifth; the right password is 423 at 14 min 59 s and 204 at 15 min; an audit event `snapshot.locked` exists.
  - `FR-3.6: twenty wrong passwords at once leave the link locked` — `Promise.all`; afterwards `lockedUntil` is set and the right password is 423.
  - `FR-3.6: a right password resets the count` — four wrong, one right, four wrong: still not locked.
  - `FR-3.6: the unlock route is rate-limited per IP` — with `authRateLimitPerMin: 3`, the fourth call in a minute is 429 `rate_limited`, and `GET /api/snapshots/:linkId/content` is not limited.
  - `FR-3.2: an unknown link is 404 and an expired one is 410, with or without a session` — a session earned before the expiry stops working after it.
  - `FR-3.2: a revoked snapshot's session stops working` → 404.
  - `FR-3.2: a session for one snapshot does not open another` — the cookie value from A, sent on B's path, is 401.
  - `FR-3.2: a successful unlock is recorded in the audit log, without the password or the link`.
  - `Tenant isolation: a snapshot in another tenant is reached only through its own link, and its rows are never read through another link`.
  - `FR-3.6: sign-in lockout still behaves as before` (the existing lockout tests pass unchanged after the refactor).
- [ ] **Step 2: Run** them → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → all pass.
- [ ] **Step 5: Commit** `feat(api): open a snapshot with its password, with lockout (FR-3.2, FR-3.3, FR-3.6)`.

### Task 4: The PDF service (FR-3.4)

**Files:**
- Create: `apps/pdf/package.json` (`@roadmap/pdf`), `tsconfig.json`, `vitest.config.ts`, `src/app.ts`, `src/server.ts`, `src/limiter.ts`, `src/chromium.ts`, `test/app.test.ts`, `test/limiter.test.ts`, `test/chromium.test.ts`, `Dockerfile`
- Modify: `.github/workflows/ci.yml` (`e2e` job runs the gated tests). The root `lint`, `typecheck` and `test` scripts already cover every workspace package; the new one needs its own `typecheck` and `test` scripts.

**Interfaces:**
- Produces:

```ts
// src/limiter.ts
export function createLimiter(max: number): { run<T>(fn: () => Promise<T>): Promise<T> };  // rejects with BusyError at once when `max` are running
export class BusyError extends Error {}
// src/app.ts
export interface Render { (input: { url: string; token: string; timeoutMs: number }): Promise<Buffer> }
export const RENDER_PATH = /^\/s\/[A-Za-z0-9_-]{20,64}\/print\/(list|timeline)$/;
export function buildPdfApp(deps: { render: Render; renderOrigin: string; maxRenders: number; timeoutMs: number }): FastifyInstance;
// src/chromium.ts
export async function createChromiumRender(opts: { renderOrigin: string }): Promise<{ render: Render; close(): Promise<void> }>;
```

- HTTP: `GET /health` → 200 `{ status: 'ok' }`. `POST /render` with JSON `{ path, token }` → 200 `application/pdf`; 400 `bad_path` when `path` does not match `RENDER_PATH`; 503 `busy`; 504 `timeout`; 502 `render_failed`.
- Environment: `PORT` (3200), `RENDER_ORIGIN` (required, an `http:` or `https:` origin), `MAX_RENDERS` (2), `RENDER_TIMEOUT_MS` (45000).
- `createChromiumRender` launches one headless Chromium at start. Each render uses a new browser context that is closed afterwards whatever happens. The context sends the token in the `x-snapshot-render` header, and a route handler aborts every request whose origin is not `renderOrigin`. It goes to `renderOrigin + path`, waits for `html[data-print="ready"]` (a `data-print="error"` or the timeout fails the render), then calls `page.pdf` with A4, landscape, `printBackground: true`, 12 mm margins and the footer template from the page's `<meta name="pdf-footer">` content, with Chromium's `pageNumber` and `totalPages` classes for the page numbers.
- `playwright-core` is pinned to the same version as `@playwright/test` in `apps/web`, so both use one browser download.
- The Dockerfile follows `apps/api/Dockerfile`'s shape on a Debian base, installs only Chromium's headless shell and its system packages, and runs as a non-root user. Read Playwright's Docker guidance first. Keep Chromium's sandbox on if it can run in the container as configured in Task 9; if it cannot, `--no-sandbox` is allowed only with the Task 9 limits in place, and that is recorded as a ruling.

- [ ] **Step 1: Write the failing tests.** `test/app.test.ts` and `test/limiter.test.ts` use a stub `Render`; `test/chromium.test.ts` is skipped unless `TEST_PDF=chromium` and serves fixture pages from a local `node:http` server.
  - `FR-3.4: only snapshot print paths are rendered` — `/s/AAAAAAAAAAAAAAAAAAAAAAAA/print/list` reaches the stub with `url` equal to the origin plus that path; `/`, `/s/x/print/list`, `/s/AAAAAAAAAAAAAAAAAAAAAAAA/print/list?next=//evil.example`, `//evil.example/s/AAAAAAAAAAAAAAAAAAAAAAAA/print/list` and `/s/AAAAAAAAAAAAAAAAAAAAAAAA/print/board` are 400 and never reach it.
  - `FR-3.4: a third render while two are running is refused at once, and a slot frees when a render ends or fails`.
  - `FR-3.4: a render that throws is 502, and one that times out is 504`.
  - (gated) `FR-3.4: a ready page becomes a PDF with its text and a page-numbered footer` — the bytes start with `%PDF-`; `pdfjs-dist` reads the fixture's heading and "Page 1 of 1" from page 1.
  - (gated) `FR-3.4: the token is sent to the page's origin and no other origin is requested` — the fixture page tries to load an image and a script from a second local server; the first server saw the `x-snapshot-render` header, the second saw no request at all.
  - (gated) `FR-3.4: a page that reports an error, or never becomes ready, fails the render and leaves no context open` — after each, `browser.contexts()` is empty.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/pdf test` → fail. Run `TEST_PDF=chromium pnpm --filter @roadmap/pdf test` locally too (the Mac has Playwright's Chromium from the E2E suite).
- [ ] **Step 3: Implement.** Coverage for this package excludes `src/chromium.ts` and `src/server.ts`; the gated tests are what prove the adapter.
- [ ] **Step 4: Run** both commands again → pass. Add to the `e2e` job, after the Playwright install: `TEST_PDF=chromium pnpm --filter @roadmap/pdf test`.
- [ ] **Step 5: Commit** `feat(pdf): a service that prints snapshot pages with headless Chromium (FR-3.4)`.

### Task 5: API: making and keeping PDFs (FR-3.4)

**Files:**
- Create: `apps/api/src/snapshots/pdf-renderer.ts`; `apps/api/test/snapshots/pdf.test.ts`
- Modify: `apps/api/src/config.ts` and its test, `app.ts` (`AppDeps.pdfRenderer`, `AppDeps.maxPdfRenders`), `snapshots/public-routes.ts`, `snapshots/access.ts`

**Interfaces:**
- Consumes: Task 3's `snapshotAccess`, `createSnapshotSession`, `RENDER_HEADER`; `ObjectStore.put` and `signedGetUrl`; `DOWNLOAD_SECONDS`; `cleanFileName`.
- Produces:

```ts
// snapshots/pdf-renderer.ts
export interface PdfRenderer { render(input: { path: string; token: string }): Promise<Buffer> }
export class PdfBusyError extends Error {}
export class PdfFailedError extends Error {}
export class HttpPdfRenderer implements PdfRenderer { constructor(opts: { url: string; timeoutMs: number; fetch?: typeof fetch }) }  // 503 → PdfBusyError; anything else that is not a 200 PDF → PdfFailedError
export class FakePdfRenderer implements PdfRenderer { readonly calls: Array<{ path: string; token: string }> }  // returns a small valid PDF
export function createPdfRenderer(config: Config): PdfRenderer;
// config.ts
pdf: 'service' | 'fake';  pdfUrl?: string;  pdfTimeoutMs: number;   // PDF (default 'fake'), PDF_URL (required when PDF=service), PDF_TIMEOUT_MS (default 60000)
```

- Route: `POST /api/snapshots/:linkId/pdf` (`public`; body `snapshotPdfRequestSchema`; needs the viewer cookie, and refuses a render token with 401) → 200 `downloadLinkSchema`; 503 `pdf_busy`; 502 `pdf_failed`.
  - When `snapshot.pdfs[view]` is set: return `signedGetUrl(key, { fileName, expiresSeconds: DOWNLOAD_SECONDS })`.
  - Otherwise, inside the API's own limit of 2 at once (`deps.maxPdfRenders`): create a `render` session, call `renderer.render({ path: '/s/{linkId}/print/{view}', token })`, check the bytes start with `%PDF-`, `put` them at `{tenantId}/{roadmapId}/snapshots/{snapshotId}/{view}.pdf`, set `pdfs.{view}` with an update that matches the snapshot still existing, delete the render session, and return the link. If the snapshot was revoked meanwhile, delete the object and answer 404.
  - `fileName` is `cleanFileName('{roadmapName} {view} {asOf}.pdf')`.
- A render token opens `GET …/content` (with or without `?notes=all`) for its own snapshot only, for two minutes, and nothing else.

- [ ] **Step 1: Write the failing tests** (with `FakePdfRenderer` and `MemoryObjectStore`):
  - `FR-3.4: the first request makes the PDF, stores it and returns a download link; the second returns a link without rendering again` — `calls` has length 1 after two requests; the stored object starts with `%PDF-`.
  - `FR-3.4: the renderer is given the print path and a token that opens this snapshot's content, and only for two minutes` — inside a renderer stub, `GET content` with the header is 200; after the route returns, and after 2 minutes on the clock, the same token is 401; the token on another snapshot's content is 401; the token on `POST …/pdf` and on `POST …/unlock` earns nothing.
  - `FR-3.4: list and timeline are two PDFs with their own keys and file names`.
  - `FR-3.4: a third PDF while two are being made is refused with pdf_busy, and the count goes back down after a failure` (with `maxPdfRenders: 2` and a renderer that waits on a promise the test resolves).
  - `FR-3.4: a renderer that fails, is busy, or returns something that is not a PDF stores nothing and marks nothing` — 502 or 503; the store is empty; `pdfs` is `{}`; the next request renders again.
  - `FR-3.4: a PDF finished after the snapshot was revoked is not kept` — the store is empty afterwards.
  - `FR-3.4: a PDF needs the viewer's cookie` — none is 401; an expired snapshot is 410.
  - `FR-3.4: HttpPdfRenderer posts the path and token, and maps 503 to busy and other failures to failed` (stub `fetch`), including a timeout after `timeoutMs`.
  - `Config: production needs PDF=service, and PDF=service needs PDF_URL`.
- [ ] **Step 2: Run** them → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → all pass.
- [ ] **Step 5: Commit** `feat(api): make each snapshot PDF once and serve it by signed link (FR-3.4)`.

### Task 6: Web: the Snapshots tab (FR-3.1, FR-3.2, FR-3.5)

**Files:**
- Create: `apps/web/src/snapshots/useSnapshots.ts`, `SnapshotsPage.tsx`, `CreateSnapshotDialog.tsx`, their `.test.tsx` files; `apps/web/e2e/snapshots.spec.ts`
- Modify: `apps/web/src/App.tsx` (route), `roadmaps/RoadmapLayout.tsx` (tab), `api/errors.ts` (new codes), `audit/describe.ts`, `audit/AuditPage.tsx`, `styles.css`

**Interfaces:**
- Consumes: Task 1's types; Task 2's routes; `api`, `messageFor`, `ConfirmDialog`, `Field`, `Button`, `Alert`, `can`, `useRoadmap`, `formatDay`.
- Produces: `SNAPSHOTS_KEY(roadmapId)`, `useSnapshots(roadmapId)`, `useCreateSnapshot(roadmapId)`, `useRevokeSnapshot(roadmapId)`, `snapshotUrl(linkId): string` (`{window.location.origin}/s/{linkId}`), `endOfLocalDay(date: string): string` (the ISO instant of 23:59:59.999 that day in the browser's zone), `<SnapshotsPage />`.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-3.2: endOfLocalDay gives the last millisecond of that day in the local zone` (run with `TZ` fixed in the test).
  - `FR-3.1: the form refuses an empty name, a short password, a future as-of date and an expiry that is not after today, each with its message, and sends nothing`.
  - `FR-3.5: both Include boxes start unticked and the request carries what was ticked`.
  - `FR-3.2: after creating, the dialog shows the link and never shows the password again`; "Copy link" writes `snapshotUrl(linkId)` to the clipboard and says "Link copied."; a clipboard that throws shows the fallback line.
  - `FR-3.2: a card shows Active, Expired or Locked until {time}, and its opened line in each of its three forms`.
  - `FR-3.5: a card's last line says what the snapshot shows, and is absent when it shows nothing extra`.
  - `FR-3.1: too_many_snapshots and too_many_notes show their own messages in the dialog and keep what was typed`.
- [ ] **Step 2: Write the failing E2E** in `snapshots.spec.ts` (each calls `useCspGuard()`, desktop and mobile):
  - `FR-3.1: an Owner creates a snapshot and it appears in the list as Active`, with axe on the empty page, the dialog, the created state and the list.
  - `FR-3.2: revoking asks first, removes the card and moves focus to the next card's Copy link`.
  - `FR-3.1: a Contributor has no Snapshots tab, and the Snapshots address shows them what the Audit log address shows a Contributor`.
  - `FR-3.1: the audit log shows "created a snapshot." and "revoked a snapshot."`.
- [ ] **Step 3: Run** `pnpm --filter @roadmap/web test` and the new spec → fail.
- [ ] **Step 4: Implement.** The password input is `type="password"` until "Show password" is ticked. The page uses the copy table word for word.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → all pass.
- [ ] **Step 6: Commit** `feat(web): create, copy and revoke snapshots (FR-3.1, FR-3.2, FR-3.5)`.

### Task 7: Web: the viewer (FR-3.2, FR-3.3, FR-3.5, FR-3.6)

**Files:**
- Create: `apps/web/src/viewer/useSnapshot.ts`, `SnapshotGate.tsx`, `SnapshotLayout.tsx`, `SnapshotList.tsx`, `SnapshotItemDetails.tsx`, `SnapshotNotes.tsx`, `SnapshotTimeline.tsx`, their `.test.tsx` files; `apps/web/src/projects/timelineParts.tsx`; `apps/web/e2e/snapshot-viewer.spec.ts`
- Modify: `apps/web/src/App.tsx` (routes outside `RequireAuth`), `projects/TimelineView.tsx` and `TimelineAxis.tsx` (use the moved `Track`; marker label), `api/errors.ts`, `styles.css`; `apps/web/e2e/fixtures.ts` (a helper that creates a snapshot through the API)

**Interfaces:**
- Consumes: Task 1's types, `buildTree`, `timelineRange`; Task 3's routes; `Markdown`; `Chevron`; `statusName`, `levelName`, `formatDates`, `formatDay`, `formatMilestone`; `api` with `quiet: true` on every call (a 401 here must never send anyone to the sign-in page).
- Produces:

```ts
// projects/timelineParts.tsx
export function Track(props: { item: Pick<Project, 'status' | 'startDate' | 'endDate' | 'milestones'>; range: TimelineRange; today: string }): ReactNode;
// TimelineAxis gains: markerLabel?: string  (default 'Today')
// viewer/useSnapshot.ts
export function useSnapshotStatus(linkId: string);
export function useUnlock(linkId: string);
export function useSnapshotContent(linkId: string, opts?: { allNotes?: boolean });
export function useSnapshotNotes(linkId: string, itemId: string, enabled: boolean);
// routes
/s/:linkId            SnapshotGate: the password page, or a redirect to /s/:linkId/list when already unlocked
/s/:linkId/list       SnapshotLayout + SnapshotList
/s/:linkId/timeline   SnapshotLayout + SnapshotTimeline
```

- A frozen note's `mentions` are names; pass them to `Markdown` as `{ userId: name, name }`.
- A 401 from any viewer call while a snapshot is showing returns the person to `/s/:linkId` with "Enter the password again to keep viewing.".

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-3.2: the gate shows the password page for a locked link, and the not-found and expired cards for 404 and 410, with no field on those`.
  - `FR-3.6: wrong_password, snapshot_locked and rate_limited each show their own message, and the field keeps focus`.
  - `FR-3.3: the header shows the roadmap name and "As of 12 Mar 2026", and the page title is "{roadmap name}: snapshot"` (dates use `formatDay`, which writes "12 Mar 2026").
  - `FR-3.3: the list nests items, collapses a branch with its chevron, and shows status, dates and priority as text`.
  - `FR-3.5: the "Assigned to" column and the Notes part exist only when the snapshot includes them`.
  - `FR-3.5: opening an item's details loads its notes once, shows replies under their note, "Edited", the deleted placeholder and "Former member"`; a failed load shows the message and "Try again" loads them.
  - `FR-3.3: details show only the parts that have content, and "Blocked by" lists the blockers' titles`.
  - `FR-3.3: note text and descriptions with <script> or an <img onerror> show as text`.
  - `FR-3.3: the timeline puts the marker on the as-of date and labels it "As of"`; the app's Timeline still says "Today" (existing tests unchanged).
  - `FR-3.3: a snapshot with no items says so in both views`.
- [ ] **Step 2: Write the failing E2E** in `snapshot-viewer.spec.ts`, in a browser context with no account cookies (desktop and mobile, `useCspGuard()`):
  - `FR-3.2: a stakeholder opens the link, enters the password and reads the list and the timeline` — axe on the password page, the list, an open details row with notes, and the timeline; no sideways page scroll at 375 px.
  - `FR-3.1: a title changed after the snapshot was made still shows the old title`.
  - `FR-3.5: a snapshot made without notes or names shows neither anywhere on the page` (`page.content()` contains neither string).
  - `FR-3.6: five wrong passwords lock the link, and the right one then shows the locked message`.
  - `FR-3.2: a revoked link shows "This link doesn't work"`, including for a tab that had it open and reloads.
  - `FR-3.2: reloading keeps the snapshot open, and a new browser context is asked for the password`.
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.** Viewer pages render no app header and make no call to `/api/me`.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → all pass.
- [ ] **Step 6: Commit** `feat(web): read a snapshot as a list or a timeline (FR-3.2, FR-3.3, FR-3.5, FR-3.6)`.

### Task 8: Web: print pages and Download PDF (FR-3.4)

**Files:**
- Create: `apps/web/src/viewer/PrintPage.tsx`, `PrintPage.test.tsx`; `apps/web/e2e/snapshot-pdf.spec.ts`
- Modify: `apps/web/src/App.tsx` (route `/s/:linkId/print/:view`), `viewer/SnapshotLayout.tsx` (the button), `viewer/useSnapshot.ts` (`useSnapshotPdf`), `styles.css` (`@media print` and the print page's rules), `apps/web/e2e/global-setup.ts` (start the PDF service; `PDF=service`, `PDF_URL`), `apps/web/package.json` (`pdfjs-dist` as a dev dependency)

**Interfaces:**
- Consumes: Task 4's service contract (`html[data-print]`, `<meta name="pdf-footer">`); Task 5's route; Task 7's components; `fitTimeline`.
- Produces: `useSnapshotPdf(linkId)` (posts the view, then `window.location.assign(url)` for an `http:` or `https:` link, as attachment downloads do); `PRINT_TIMELINE_WIDTH = 760` (px left for the schedule on A4 landscape beside a 240 px name column); `<PrintPage />`.

- `PrintPage` loads content with `?notes=all` when the view is `list`, renders with everything open, then sets `document.documentElement.dataset.print` to `'ready'` in an effect after the content is on the page, or to `'error'` when loading fails. It sets `<meta name="pdf-footer" content="{roadmap name} · As of {date}">`.
- Print rules: table header rows repeat on each page; a table row, a note and a details block are not split across pages when they fit on one; link addresses are written out after link text; status is text.
- The E2E global setup starts `apps/pdf` on port 3200 with `RENDER_ORIGIN=http://localhost:5173` and waits for `/health`, the same way it starts the API.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-3.4: the list print page writes out every item's details and notes with nothing collapsed and no buttons`.
  - `FR-3.4: the timeline print page is exactly 760 px of schedule, whatever the range` (ranges of 3 months and of 10 years).
  - `FR-3.4: the page marks itself ready only after the content is rendered, and marks an error when loading fails`.
  - `FR-3.4: Download PDF is disabled with "Preparing the PDF…" while it is being made, and shows its message for pdf_failed and pdf_busy`.
- [ ] **Step 2: Write the failing E2E** in `snapshot-pdf.spec.ts` (desktop project only; one PDF layout serves every device):
  - `FR-3.4: Download PDF on the list gives a PDF with the roadmap name, the as-of date, every item title and the notes` — take the Playwright download, read it with `pdfjs-dist`, and assert the strings; the footer reads "Page 1 of".
  - `FR-3.4: Download PDF on the timeline gives a one-page-wide PDF with every item title and the "As of" marker`.
  - `FR-3.5: the PDF of a snapshot made without notes or names contains neither`.
  - `FR-3.4: asking again downloads the same stored PDF` (the two downloads are byte-equal).
  - `FR-3.4: 200 items with long titles and 300 notes still make a PDF of more than one page` — seeded through the API; the test's own timeout is raised for this case only, and no wall-clock assertion is made.
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm run test --coverage && pnpm test:e2e` (twice) → all pass.
- [ ] **Step 6: Commit** `feat(web): print pages and Download PDF for snapshots (FR-3.4)`.

### Task 9: Deployment: the PDF service in the stack

**Files:**
- Modify: `deploy/poc/docker-compose.yml`, `docker-compose.smoke.yml`, `Caddyfile`, `.env.example`, `scripts/smoke.sh`, `.github/workflows/ci.yml`, the deployment notes that list services and memory

**Interfaces:**
- Consumes: Task 4's image and environment; Task 5's `PDF`, `PDF_URL`.
- Produces: service `pdf` (image `roadmap-pdf:poc`); an internal Caddy listener on port 8080.

- Compose: `pdf` is built from `apps/pdf/Dockerfile`, with `RENDER_ORIGIN: http://caddy:8080`, `read_only: true`, `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: 1g`, a health check on `/health`, and no published port. It sits on two networks marked `internal: true`: one shared only with `api`, one shared only with `caddy`. The API gets `PDF: service` and `PDF_URL: http://pdf:3200` in `environment`, beside `FILES` and `SCANNER`, and waits for `pdf` to be healthy.
- Caddyfile: the handlers move into a snippet that both the public site and a new `http://:8080` site import. Port 8080 is not published. Both send `X-Robots-Tag: noindex, nofollow` for `/s/*` and `/api/snapshots/*`. The `auth` rate-limit zone also matches the unlock route (`path_regexp ^/api/snapshots/[^/]+/unlock$` if a `path` matcher can't express it).
- CI `deploy-smoke`: build three images; the blocking vulnerability scan covers `roadmap-pdf:poc` too.
- `scripts/smoke.sh`, inside the `SMOKE_WRITES=yes` part: create a snapshot of the roadmap it made, check `GET /api/snapshots/{linkId}/content` is 401 without a cookie, unlock it, ask for the list PDF, follow the link and check the first five bytes are `%PDF-`; check port 8080 is not reachable from the host; revoke the snapshot and check the link is 404.

- [ ] **Step 1:** Extend `scripts/smoke.sh` with the checks above and run it against the current stack on the devbox to see the new checks fail (`roadmap-` project name, ports 18080 and 18443 only, as `task-9-report.md` of the last plan did).
- [ ] **Step 2:** Change the Compose files, the Caddyfile and `.env.example`.
- [ ] **Step 3:** On the devbox: build, `up --wait`, bootstrap, run the smoke script with `SMOKE_WRITES=yes` → every check passes. Record peak memory of the `pdf` container during a render (`docker stats --no-stream`). Then `down -v` and check that no `roadmap-smoke*` container or volume is left.
- [ ] **Step 4:** Update `ci.yml` (third build, third scan). If the scan finds fixable HIGH or CRITICAL findings in the Chromium image's system packages, upgrade them in the Dockerfile; do not lower the gate.
- [ ] **Step 5: Commit** `feat(deploy): the PDF service, an internal listener for it, and smoke checks (FR-3.4)`.

---

## Risks to watch

- **Memory on the POC server.** ClamAV may use 3 GB and Chromium up to 1 GB while a PDF is made, beside MongoDB, the API and Caddy. A 4 GB server is no longer enough; Task 9 records the measured peak, and the infrastructure plan should size for 8 GB.
- **Chromium's sandbox in a locked-down container.** If it can't stay on, Task 4 records that as a ruling with the limits that stand in for it.
- **The Chromium image and the blocking scan.** A browser image carries many system packages; expect to pin and upgrade some to keep the gate green.
- **A link can be locked by anyone who has it.** Five wrong guesses lock it for everyone for 15 minutes. That is what FR-3.6 asks for; the cost is recorded here.

## Next plans (v1)

1. Notifications (FR-5): reads the mentions stored on notes; per-user instant, digest or off.
2. Calendar feed (FR-4).
3. POC infrastructure (S3 bucket, KMS key, roles, server size, the queue for PDFs), then release hardening.

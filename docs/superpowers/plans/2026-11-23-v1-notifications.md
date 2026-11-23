# v1 Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People hear about the things that concern them (being assigned, dates moving on their items, being @mentioned, and dates coming up) by email at once or in a daily digest, as each person chooses, and in an in-app list with an unread count.

**Architecture:** A change that should notify someone writes one row per recipient to a new `notifications` collection, inside the same transaction as the change (an outbox). The in-app list reads that collection. A new worker process, built from the API's own code and image and run as its own container, sends instant emails, builds the daily digests at 8 am in each person's time zone, and writes the "due soon" reminders. It claims rows before sending, so two workers never send the same email. SQS can replace the polling later without changing the rows.

**Tech Stack:** As the earlier plans. No new libraries. Time-zone arithmetic uses `Intl.DateTimeFormat` with `timeZone`, as the web app already does.

**Spec:** `docs/prd.md`. Sections this plan implements: FR-5.1 (the v1 events), FR-5.2, FR-5.3, the User entity's "notification preferences", and "the background worker handles … sending email digests".

**Builds on:** branch `v1-snapshots` (PR `ltrainsb1/roadmap#5`). Start branch `v1-notifications` from it, or from whichever earlier branch it has been merged into. Earlier decisions are in the five follow-ups documents in `docs/superpowers/plans/`.

**Not in this plan:** The two idea events of FR-5.1 (ideas arrive in v2; the event types are added with them). Browser push (v2). A one-click unsubscribe link that works without signing in. Bounce and complaint handling for SES (the infrastructure plan). Changing one's time zone (it is set at sign-up and shown on the settings page). Live updates of the list without polling.

## Global Constraints

Every constraint in the five earlier plans' Global Constraints sections still binds. The ones this plan leans on, and the new ones:

- Every query in the API goes through `scoped()`. The worker's few cross-tenant reads (rows due for sending, people whose digest is due, items with dates coming up) go through one new module, `apps/api/src/worker/worker-db.ts`, beside `unscoped()`; everything it does for one tenant after that goes through `scoped()`.
- A notification row is written in the same transaction as the change that caused it. If the change rolls back, no row exists.
- Nobody is notified of their own action. Nobody is notified about a roadmap they are not a member of, at the time the row is written and again at the time it is sent.
- Notification rows and emails carry names, item titles and short note excerpts only. No email address of anyone but the recipient appears in an email. Emails are built with the existing `escapeHtml` and `oneLine` helpers; note excerpts are plain text, never rendered Markdown.
- Notes are untrusted text: an excerpt is at most 200 characters, cut on a character boundary, with line breaks turned into spaces.
- Every new route has `config.auth` (`level: 'full'`, no action: a person reads and changes only their own notifications and preferences, enforced by a `userId` filter). Changing preferences writes an audit event; reading and marking read do not.
- The page's content policy stays as it is. Every new E2E spec calls `useCspGuard()`.
- Definition of done for every task: unit tests for pure code, API tests for routes (including one "Tenant isolation: …" test), worker tests on a fixed clock with `MemoryMailer`, E2E for screens, coverage at 80% or more in every package (`pnpm run test --coverage` from the repo root), axe passes on each new screen state, each screen works from 375 px wide with no sideways page scroll, and the FR id appears in the test name.
- All tests run as GitHub Actions in the existing jobs. Check the CI result after every push. No test retries, no fixed waits, no wall-clock limits under 5 seconds.
- Docker runs on the devbox through the SSH tunnel, never on the Mac, under the same rules as before: only containers, images, volumes and networks whose names start with `roadmap-`; never a prune; never ports 80 or 443; remove what you started.
- On-screen copy and email copy follow the `mobbin:plain-writing` rules and the exact text in the UI/UX plan below. Tests assert it word for word.
- Commit trailers name the model that wrote the commit.
- **Plan decisions where the PRD is silent** (the first four are the user's choices; change any of them here and every task follows):
  - *Where the work runs* (user's choice). A `worker` container from the API image runs `node dist/worker.js`. It wakes every `WORKER_INTERVAL_MS` (default 30,000; 500 in E2E) and runs three steps in order: instant sends, due-soon reminders, digests. Running two workers at once sends nothing twice.
  - *Due soon* (user's choice). An item's end date and each of its milestone dates, 3 days ahead: a reminder is written for each person assigned to the item on the first worker pass when the date is between today and 3 days from today in that person's time zone. One reminder per person, item, date kind (end or milestone id) and date; a date that moves gets a new reminder. Items that are archived, done or cancelled get none. A date already past gets none.
  - *Defaults* (user's choice). Assigned to you: instantly. Mentions: instantly. Dates changed on your items: daily digest. Due soon: daily digest. The in-app list shows every notification whatever the email setting.
  - *Digest time* (user's choice). 8 am in the person's own time zone (`UserDoc.timezone`), on days with at least one notification waiting for it. A worker that was down at 8 am sends the digest on its next pass that day.
  - *The events.* "Assigned": someone else adds you to an item's assignees (removal notifies nobody). "Dates changed": someone else changes the start date, the end date, or a milestone's date or adds or removes a milestone on an item you are assigned to; one row per change, carrying the old and new dates. "Mentioned": someone else saves a note that mentions you, or edits one so that it newly mentions you. "Due soon": as above, written by the worker, with no actor.
  - *When the setting is read.* The email setting is read when the email would go out, not when the row is written: a person who turns an event off stops getting those emails at once, and one who switches to the digest gets pending ones in the next digest.
  - *Retries.* A failed send is tried again after 1, 5, 15 and 60 minutes, then marked failed. A digest that fails is retried the same way; its rows stay pending until it succeeds.
  - *Keeping rows.* Notifications are kept 90 days (a TTL index), read or not. Deleting an item deletes its notifications and those of everything under it; deleting a roadmap deletes all of its notifications; removing a member deletes that person's notifications for that roadmap.
  - *Links.* Emails and the in-app list link to the item's panel in the List view: `/r/{roadmapId}/projects/{projectId}`. An item since deleted shows the app's existing not-found message.
  - *Unread count* is polled every 60 seconds and when the window regains focus, and shows "99+" above 99.

## Review Focus

- The same change saved twice at the same moment, a change that fails and rolls back, and two workers running at once: no row without its change, no duplicate email, no lost email. (Tasks 2 and 4)
- A person assigned and then removed from the roadmap before the worker runs, a mention of someone who leaves the roadmap, and a digest whose items were all deleted: nothing is sent to someone who can no longer see the roadmap, and an empty digest is never sent. (Tasks 2 and 4)
- Time zones far from UTC (`Pacific/Kiritimati` at +14, `Pacific/Pago_Pago` at −11), a daylight-saving changeover day, and the worker down over 8 am: one digest per person per local day, never two, and the due-soon window counts days in the person's own zone. (Task 4)
- A note that is 5,000 characters of Markdown with HTML, a title with `<script>` and line breaks, and a name with quotes: the email's subject is one line, the HTML is escaped, and the excerpt is 200 plain characters. (Tasks 1 and 4)
- Another tenant's notification id sent to "mark as read", a cursor from another person's list, and a member of one roadmap reading notifications: each sees and changes only their own. (Task 3)

---

## File Structure

```
packages/shared/src/
  notifications.ts              NOTIFICATION_TYPES, EMAIL_MODES, DEFAULT_PREFS, schemas, notificationSentence, noteExcerpt
  schemas.ts                    audit action 'user.notification_prefs'
apps/api/src/
  db/types.ts, scoped.ts, indexes.ts   NotificationDoc; UserDoc.notificationPrefs, digestSentOn; the collection and indexes
  notifications/outbox.ts       notifyAssigned, notifyDatesChanged, notifyMentioned (called inside the transactions)
  notifications/routes.ts       list, unread count, mark read, mark all read, preferences
  projects/routes.ts, assign-routes.ts, notes/routes.ts   call the outbox
  projects/content.ts, members/routes.ts   cascades
  worker/worker-db.ts           the worker's cross-tenant reads
  worker/local-time.ts          localDate, localHour, addDays
  worker/instant.ts, digest.ts, due-soon.ts, run.ts   the three steps and the loop
  worker/emails.ts              instant and digest email content
  worker.ts                     process entry: config, MongoDB, the loop, a heartbeat file, shutdown
  config.ts                     WORKER_INTERVAL_MS
apps/web/src/
  notifications/useNotifications.ts, NotificationsPage.tsx, NotificationBell.tsx
  settings/NotificationSettingsPage.tsx, useNotificationPrefs.ts
  ui/Layout.tsx                 the bell in the header
  audit/describe.ts, AuditPage.tsx   the new audit action
deploy/poc/                     worker service, smoke checks
```

## UI/UX plan

References looked at (Mobbin, web):

- The list as one page with the newest first, an unread marker on the right and "Mark all as read" at the top: [Homerun](https://mobbin.com/screens/0894ba96-084e-4505-94d1-272aa3f64cfb?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Todoist](https://mobbin.com/screens/c6a5fe74-6389-4d7e-8e85-980cb1010b9b?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). Each row is one sentence naming who did what to which item, then where and when on a second line: [folk](https://mobbin.com/screens/53204879-6a32-4f5d-ad5f-2adef77f8dc6?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). A link from the list to the email settings: [Asana](https://mobbin.com/screens/54ed06f0-2faa-4968-a687-8e9ac3b26abb?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp) ("Manage notifications").
- Settings as a table with one row per event and a short description under each name: [Assembly](https://mobbin.com/screens/c2d30c9b-c5a1-4e49-9bf6-fe253d5b5410?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [AirOps](https://mobbin.com/screens/a33cf381-5620-42a5-8533-afa05089d716?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). The digest as a choice beside individual emails: [Behance](https://mobbin.com/screens/3848741d-8dc7-4fdb-af36-8bae11795e33?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp). A Save button under the form: [Wrike](https://mobbin.com/screens/d34a917a-aedb-460f-ad60-c4e589c463a2?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

**Header.** A "Notifications" link with a bell icon sits before "Security" in the account navigation on every signed-in screen. When there are unread notifications a badge shows the count. Its accessible name is "Notifications, {n} unread" or "Notifications". Below 600 px only the icon and badge show.

**The list** (`/notifications`). A heading, "Mark all as read" (shown only when something is unread), then the rows, newest first, 30 at a time with "Show more" at the bottom. A row is a link to the item: the sentence, then "{roadmap name} · {date and time}" in the person's time zone, with a dot and hidden text "Unread" on unread rows. A mention row adds the note excerpt in quotes on its own line. Opening a row marks it read. At the bottom, "Change which emails you get" links to the settings page.

**Settings** (`/settings/notifications`). A heading, one sentence, then a table: one row per event with its name and description, and three radio buttons per row (Instantly, Daily digest, Off). Below 600 px each row becomes a fieldset with its radios stacked. Then the digest line, "Save changes" and a polite status.

Copy (exact):

| Where | Text |
| --- | --- |
| Header link | "Notifications"; accessible name "Notifications, {n} unread" when n > 0; badge "{n}" or "99+" |
| List heading | "Notifications" |
| Mark all | "Mark all as read" |
| Empty | "No notifications yet." |
| More | "Show more" |
| Load failed | "Couldn't load notifications. Try again." with a "Try again" button |
| Mark failed | "Couldn't mark notifications as read. Try again." |
| Unread marker (hidden text) | "Unread" |
| Row, assigned | "{actor} assigned you to {title}." |
| Row, dates changed | "{actor} changed the dates on {title}." then "{old dates} → {new dates}" on the second line before the roadmap name |
| Row, milestone changed | "{actor} moved the milestone {milestone} on {title} to {date}." / "{actor} added the milestone {milestone} on {title}." / "{actor} removed the milestone {milestone} on {title}." |
| Row, mentioned | "{actor} mentioned you on {title}." then the excerpt as "“{excerpt}”" |
| Row, due soon (end date) | "{title} is due {date}." |
| Row, due soon (milestone) | "The milestone {milestone} on {title} is on {date}." |
| Actor whose account is gone | "A former member" (sentence start) |
| Second line | "{roadmap name} · {date and time}" |
| Link to settings | "Change which emails you get" |
| Settings heading | "Email notifications" |
| Settings text | "Choose how you hear about each kind of notification. Every notification also appears in the app." |
| Column headings | "Notification", "Instantly", "Daily digest", "Off" |
| Row names and descriptions | "Assigned to you" / "Someone adds you to an item." · "Mentions" / "Someone mentions you in a note." · "Dates changed on your items" / "Someone changes the dates or milestones of an item you're assigned to." · "Due soon" / "An end date or milestone of an item you're assigned to is 3 days away." |
| Digest line | "The daily digest arrives at 8 am in your time zone ({time zone}), on days with something in it." |
| Save, saved, failed | "Save changes" / "Saved." / "Couldn't save your settings. Try again." |
| Email subject, assigned | "{actor} assigned you to {title}" |
| Email subject, dates | "{actor} changed the dates on {title}" (milestone forms as in the rows, without the full stop) |
| Email subject, mention | "{actor} mentioned you on {title}" |
| Email subject, due soon | "{title} is due {date}" / "The milestone {milestone} on {title} is on {date}" |
| Email body | the row sentence, the second-line facts, "Open the item: {url}", then the footer |
| Digest subject | "Your roadmap updates for {date}" |
| Digest body | "Here's what happened since your last digest." then one section per roadmap, its name as the heading, one line per notification with its link, then the footer |
| Email footer | "You get this email because of your notification settings. Change them: {origin}/settings/notifications" |
| Audit log | "{who} changed their email notification settings."; filter label "Notification settings changed" |

Dates in sentences use `formatDay` ("3 Mar 2027"); "{old dates} → {new dates}" uses `formatDates`. Times in the list use the person's time zone, as the audit log does; in emails, dates only.

Accessibility: the badge is part of the link's accessible name, not separate; "Mark all as read" moves focus to the list heading; after "Show more", focus moves to the first new row; the settings table has a caption-less `<table>` with `<th scope="row">` names and radio groups named by their row; errors are `role="alert"`; "Saved." is a polite status.

---

### Task 1: Shared rules for notifications

**Files:**
- Create: `packages/shared/src/notifications.ts`; `packages/shared/test/notifications.test.ts`
- Modify: `packages/shared/src/index.ts`, `schemas.ts` (audit action)

**Interfaces:**
- Consumes: `formatDay`-equivalent date formatting must live in shared for the email; add `formatDayUtc(date: string): string` here ("3 Mar 2027", fixed English month names, as `timeline.ts` does) and use it from the web's `formatDay` so both agree.
- Produces:

```ts
export const NOTIFICATION_TYPES = ['assigned', 'mentioned', 'dates_changed', 'due_soon'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const EMAIL_MODES = ['instant', 'digest', 'off'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export type NotificationPrefs = Record<NotificationType, EmailMode>;
export const DEFAULT_PREFS: NotificationPrefs = { assigned: 'instant', mentioned: 'instant', dates_changed: 'digest', due_soon: 'digest' };
export const NOTIFICATION_LIMITS = { excerpt: 200, pageSize: 30, keepDays: 90, dueSoonDays: 3, digestHour: 8 } as const;

export type NotificationDetail =
  | { kind: 'assigned' }
  | { kind: 'mentioned'; excerpt: string }
  | { kind: 'dates'; before: { startDate: string | null; endDate: string | null }; after: { startDate: string | null; endDate: string | null } }
  | { kind: 'milestone'; change: 'moved' | 'added' | 'removed'; name: string; date: string }
  | { kind: 'due_end'; date: string }
  | { kind: 'due_milestone'; name: string; date: string };

export const notificationSchema = z.object({
  id: z.string(), type: z.enum(NOTIFICATION_TYPES), roadmapId: z.string(), roadmapName: z.string(),
  projectId: z.string(), projectTitle: z.string(), actorName: z.string().nullable(), // null: no actor, or the account is gone
  hasActor: z.boolean(), detail: /* the union above as a zod discriminated union on `kind` */,
  createdAt: z.string(), read: z.boolean(),
});
export const notificationPageSchema = z.object({ items: z.array(notificationSchema), nextCursor: z.string().nullable(), unread: z.number().int() });
export const unreadCountSchema = z.object({ unread: z.number().int() });
export const notificationPrefsSchema = z.object({ assigned: z.enum(EMAIL_MODES), mentioned: z.enum(EMAIL_MODES), dates_changed: z.enum(EMAIL_MODES), due_soon: z.enum(EMAIL_MODES) });
export const prefsResponseSchema = z.object({ prefs: notificationPrefsSchema, timezone: z.string() });

/** The row and email sentence, exact copy from the plan, with no trailing full stop when `forSubject`. */
export function notificationSentence(n: Pick<Notification, 'projectTitle' | 'actorName' | 'hasActor' | 'detail'>, opts?: { forSubject?: boolean }): string;
/** Plain text, line breaks as spaces, trimmed, at most 200 characters without splitting a surrogate pair. */
export function noteExcerpt(body: string): string;
export function formatDayUtc(date: string): string;
```

- Audit action added: `'user.notification_prefs'`.

- [ ] **Step 1: Write the failing tests:**
  - `FR-5.1: each kind of notification has its exact sentence` — one assertion per row of the copy table, including the three milestone forms, both due-soon forms and the subject form without a full stop.
  - `FR-5.1: an actor whose account is gone is "A former member"` and `a due-soon notice names no actor`.
  - `FR-5.1: a note excerpt is plain text, one line, at most 200 characters, and never splits an emoji` — 5,000 characters of Markdown with HTML and line breaks; an emoji across the 200th character.
  - `FR-5.2: the defaults are instant for assigned and mentions, digest for dates changed and due soon`.
  - `FR-5.2: preferences accept only instant, digest or off for each of the four types`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test` → fail.
- [ ] **Step 3: Implement.** Make `apps/web/src/projects/names.ts`'s `formatDay` call `formatDayUtc` (its existing tests must pass unchanged).
- [ ] **Step 4: Run** `pnpm --filter @roadmap/shared test && pnpm typecheck && pnpm --filter @roadmap/web test` → pass.
- [ ] **Step 5: Commit** `feat(shared): notification types, preferences and sentences (FR-5)`.

### Task 2: API: writing notifications with the change (FR-5.1)

**Files:**
- Create: `apps/api/src/notifications/outbox.ts`; `apps/api/test/notifications/outbox.test.ts`
- Modify: `apps/api/src/db/types.ts`, `scoped.ts`, `indexes.ts`; `projects/routes.ts` (edit), `projects/assign-routes.ts`, `notes/routes.ts` (create, edit); `projects/content.ts` (`deleteContentOf`), `projects/lifecycle-routes.ts` (item delete), `members/routes.ts` (member removal, roadmap delete)

**Interfaces:**
- Consumes: Task 1's types; `ScopedDb`; the existing transactions in the four routes.
- Produces:

```ts
// db/types.ts
export interface NotificationDoc {
  _id: string; tenantId: string; roadmapId: string;
  userId: string;               // the recipient
  type: NotificationType;
  actorId: string | null;       // null for due soon
  projectId: string; projectTitle: string;  // the title when written
  detail: NotificationDetail;
  /** Due soon only: `due:{projectId}:{end|milestoneId}:{date}`; unique per tenant and recipient. */
  dedupeKey?: string;
  createdAt: Date; readAt: Date | null;
  email: { state: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed'; attempts: number; nextAttemptAt: Date; leaseUntil: Date | null; sentAt: Date | null };
}
// UserDoc gains: notificationPrefs?: Partial<NotificationPrefs>; digestSentOn?: string  // local YYYY-MM-DD
// notifications/outbox.ts — each runs inside the caller's transaction and writes nothing for the actor or a non-member
export async function notifyAssigned(s: ScopedDb, e: { roadmapId: string; item: ProjectDoc; actorId: string; addedUserIds: string[]; now: Date }): Promise<void>;
export async function notifyDatesChanged(s: ScopedDb, e: { roadmapId: string; before: ProjectDoc; after: ProjectDoc; actorId: string; now: Date }): Promise<void>;
export async function notifyMentioned(s: ScopedDb, e: { roadmapId: string; item: ProjectDoc; actorId: string; noteBody: string; userIds: string[]; now: Date }): Promise<void>;
```

- Indexes on `notifications`: `{ tenantId: 1, userId: 1, createdAt: -1 }`; `{ tenantId: 1, userId: 1, readAt: 1 }`; `{ tenantId: 1, roadmapId: 1, projectId: 1 }`; `{ 'email.state': 1, 'email.nextAttemptAt': 1 }` (the worker's cross-tenant scan); `{ tenantId: 1, userId: 1, dedupeKey: 1 }` unique, partial on `dedupeKey` existing; `{ createdAt: 1 }` with `expireAfterSeconds` 90 days.
- `notifyDatesChanged` writes one `dates` row when the start or end date changed, and one `milestone` row per milestone added, removed or re-dated (matched by milestone id); a name-only milestone change writes nothing. Recipients are the item's assignees after the change.
- `notifyMentioned` on edit receives only the user ids newly mentioned (the route already compares mention lists).
- A new row's `email` is `{ state: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null, sentAt: null }`.

- [ ] **Step 1: Write the failing tests** (through the real routes):
  - `FR-5.1: assigning two people writes one "assigned" row each, and none for the actor who assigned themselves`.
  - `FR-5.1: removing an assignee writes nothing, and re-saving the same assignees writes nothing`.
  - `FR-5.1: changing an item's end date notifies its assignees with the old and new dates, but not the person who changed it`.
  - `FR-5.1: adding, moving and removing milestones writes one row each; renaming one writes none; changing the title writes none`.
  - `FR-5.1: a note that mentions two members writes one "mentioned" row each, with a 200-character plain excerpt; mentioning yourself writes none`.
  - `FR-5.1: editing a note to add a mention notifies only the newly mentioned person`.
  - `FR-5.1: a change refused part-way (version conflict, date order) leaves no notification row`.
  - `FR-5.1: deleting an item deletes its notifications and those of everything under it; deleting the roadmap deletes all of its notifications; removing a member deletes that person's notifications for that roadmap only`.
  - `Tenant isolation: rows are written in the item's tenant only`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test -- notifications` → fail.
- [ ] **Step 3: Implement.** Call each `notify…` after the route's own write and before its audit record, inside the same transaction.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → pass.
- [ ] **Step 5: Commit** `feat(api): write a notification with each change that concerns someone (FR-5.1)`.

### Task 3: API: the list, read marks and preferences (FR-5.2, FR-5.3)

**Files:**
- Create: `apps/api/src/notifications/routes.ts`; `apps/api/test/notifications/routes.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: Task 1's schemas; Task 2's documents.
- Produces: `registerNotificationRoutes(app, deps: { now: () => Date })`, all `config.auth: { level: 'full' }`:
  - `GET /api/notifications?cursor=&limit=` → 200 `notificationPageSchema`, newest first (by `createdAt`, then `_id`), `limit` 1–50 (default 30), `cursor` opaque (base64url of the last row's `createdAt` and `_id`); 400 `bad_cursor` for one that doesn't decode. Rows for roadmaps the person no longer belongs to are left out. `roadmapName` is the roadmap's current name; `actorName` the actor's current name or null.
  - `GET /api/notifications/unread-count` → 200 `unreadCountSchema`.
  - `POST /api/notifications/:id/read` → 204; 404 `not_found` for an id that isn't the caller's.
  - `POST /api/notifications/read-all` → 204.
  - `GET /api/me/notification-prefs` → 200 `prefsResponseSchema` (stored values over `DEFAULT_PREFS`).
  - `PUT /api/me/notification-prefs` (body `notificationPrefsSchema`) → 200 `prefsResponseSchema`; audit `user.notification_prefs` with `before` and `after`.

- [ ] **Step 1: Write the failing tests:**
  - `FR-5.3: the list is newest first, 30 at a time, and the cursor continues where it stopped with nothing repeated or skipped` (65 rows, two with the same `createdAt`).
  - `FR-5.3: the unread count and the list's unread figure agree, and marking one or all as read lowers them`.
  - `FR-5.3: a roadmap's current name and an actor's current name are shown; a deleted actor is null`.
  - `FR-5.3: someone else's notification id, a made-up id and a cursor from another person's list change and reveal nothing` (404, 400 or an empty page).
  - `FR-5.2: preferences start at the defaults, save, and come back as saved; an unknown mode is 400`.
  - `FR-5.2: changing preferences writes an audit event with before and after`.
  - `Tenant isolation: another tenant's member sees none of these notifications and can't mark them read`.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → pass.
- [ ] **Step 5: Commit** `feat(api): list notifications, mark them read, and keep each person's email settings (FR-5.2, FR-5.3)`.

### Task 4: The worker: instant emails, due-soon reminders and digests (FR-5.1, FR-5.2)

**Files:**
- Create: `apps/api/src/worker/worker-db.ts`, `local-time.ts`, `instant.ts`, `due-soon.ts`, `digest.ts`, `emails.ts`, `run.ts`; `apps/api/src/worker.ts`; tests under `apps/api/test/worker/`
- Modify: `apps/api/src/config.ts` and its test (`WORKER_INTERVAL_MS`, default 30000, minimum 100), `apps/api/package.json` (`build:worker` bundles `src/worker.ts` to `dist/worker.js` and `build` runs it; `worker` script for local runs), `apps/api/vitest.config.ts` coverage exclude for `src/worker.ts` (process wiring only, like `server.ts`)

**Interfaces:**
- Consumes: Tasks 1–2; `Mailer`, `createMailer`; `escapeHtml`, `oneLine` and the layout in `mail/templates.ts` (export what you reuse); `scoped`.
- Produces:

```ts
// worker/local-time.ts
export function localDate(at: Date, timeZone: string): string;   // YYYY-MM-DD in that zone; an unknown zone falls back to UTC
export function localHour(at: Date, timeZone: string): number;   // 0–23
export function addDays(date: string, days: number): string;
// worker/run.ts
export interface WorkerDeps { db: Db; mailer: Mailer; now: () => Date; appOrigin: string; log: { info(o: object, msg: string): void; error(o: object, msg: string): void } }
/** One pass: instant sends, then due-soon reminders, then digests. Never throws: each step logs its own errors and the pass goes on. */
export async function runPass(deps: WorkerDeps): Promise<{ sent: number; reminders: number; digests: number; failed: number }>;
// worker/instant.ts, due-soon.ts, digest.ts each export one step function with the same deps
```

- **Claiming.** A row is claimed with one conditional update from `pending` (or `sending` whose `leaseUntil` has passed) to `sending` with `leaseUntil = now + 5 min`; only the claimant sends. After a send: `sent` and `sentAt`. After a failure: back to `pending`, `attempts + 1`, `nextAttemptAt` by the plan's retry steps; at the fifth failure, `failed`.
- **Instant step.** Due rows (`pending`, `nextAttemptAt <= now`) in batches of 100. For each: load the recipient and their preference for the row's type. Off → `skipped`. Digest → leave it. Instant → check the recipient is still a member of the roadmap (else `skipped`), claim, build the email, send.
- **Due-soon step.** For each tenant with items whose end date or a milestone date falls within the next 4 UTC days (the widest any zone can be ahead), and which are not archived, done or cancelled: for each assignee, if the date is between their local today and today + 3, insert a `due_soon` row with its `dedupeKey`; a duplicate-key error means it exists and is skipped silently. Items with no assignees write nothing.
- **Digest step.** For each person with `pending` rows whose preference for that type is `digest`, and whose local hour is 8 or later, and whose `digestSentOn` is not their local today: claim the day with one conditional update setting `digestSentOn`; drop rows for roadmaps they no longer belong to (`skipped`); if nothing is left, send nothing; otherwise send one email grouping the rows by roadmap and mark them `sent`. If the send fails, put `digestSentOn` back and leave the rows pending with the retry step applied.
- **Process** (`worker.ts`): loads config, connects to MongoDB, runs `runPass` every `WORKER_INTERVAL_MS` (never two passes at once), touches `/tmp/worker-heartbeat` after each pass, stops after the current pass on SIGTERM or SIGINT, and logs counts as JSON lines (no email addresses, no note text).

- [ ] **Step 1: Write the failing tests** (fixed clock, `MemoryMailer`, real MongoDB as the API tests use):
  - `FR-5.1: an instant notification is emailed once, to the recipient only, with the exact subject, the item link and the settings footer`.
  - `FR-5.2: an "off" preference skips the email, a "digest" preference waits for the digest, and a change of preference before sending is honoured`.
  - `FR-5.1: a recipient removed from the roadmap before sending gets no email`.
  - `FR-5.1: two passes running at once send each email once` (`Promise.all`, 20 rounds, 50 rows).
  - `FR-5.1: a failed send is retried after 1, 5, 15 and 60 minutes and then marked failed; a lease left by a crashed pass is taken over after 5 minutes`.
  - `FR-5.1: due soon writes one reminder per assignee for an end date and for each milestone 3 days ahead, none for done, cancelled or archived items, and a new one when the date moves`.
  - `FR-5.1: due soon counts days in each person's time zone` (the same item and instant: a person in `Pacific/Kiritimati` is reminded, one in `Pacific/Pago_Pago` not yet).
  - `FR-5.2: the digest goes out at 8 am local time, once per local day, grouped by roadmap, and not on a day with nothing in it` (people in UTC, `America/New_York` on a changeover day, and `Pacific/Kiritimati`; passes at 07:59, 08:00, 08:30 and the next day).
  - `FR-5.2: a worker down over 8 am sends the digest on its next pass that day`.
  - `FR-5.2: a digest whose rows all belong to a roadmap the person left is not sent`.
  - `FR-5.1: email HTML escapes titles, names and excerpts; the subject is one line` (a `<script>` title with line breaks, a name with quotes, a 5,000-character note).
  - `FR-5.1: one failing step doesn't stop the others in the same pass`.
  - `Tenant isolation: a pass across two tenants sends each person only their own tenant's notifications, and the digest links point at their own roadmaps`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test -- worker` → fail.
- [ ] **Step 3: Implement.** Read the MongoDB driver's current docs (context7) for duplicate-key errors in transactions before writing the due-soon insert.
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm run test --coverage` → pass; `pnpm --filter @roadmap/api build` produces `dist/worker.js`.
- [ ] **Step 5: Commit** `feat(api): a worker that sends instant emails, daily digests and due-soon reminders (FR-5.1, FR-5.2)`.

### Task 5: Web: the bell and the notifications list (FR-5.3)

**Files:**
- Create: `apps/web/src/notifications/useNotifications.ts`, `NotificationsPage.tsx`, `NotificationBell.tsx`, their tests; `apps/web/e2e/notifications.spec.ts`
- Modify: `apps/web/src/ui/Layout.tsx`, `App.tsx` (route `/notifications` inside `RequireAuth`), `api/errors.ts`, `styles.css`; `apps/web/e2e/global-setup.ts` (start the worker with `WORKER_INTERVAL_MS=500` and the same `MAIL_OUTBOX_FILE` as the API, stop it on teardown)

**Interfaces:**
- Consumes: Tasks 1 and 3; `notificationSentence`; `useMe` (time zone); the audit page's date-time formatting.
- Produces: `UNREAD_KEY`, `NOTIFICATIONS_KEY`, `useUnreadCount()` (refetch every 60 s and on window focus), `useNotifications()` (infinite query by cursor), `useMarkRead()`, `useMarkAllRead()`; `<NotificationBell />`; `<NotificationsPage />`.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-5.3: the bell shows no badge at 0, the count up to 99, then "99+", and its accessible name says how many are unread`.
  - `FR-5.3: each kind of row shows its exact sentence, the roadmap and the time, and "Unread" only on unread rows`.
  - `FR-5.3: opening a row marks it read and goes to the item`.
  - `FR-5.3: "Mark all as read" marks everything read, hides itself and moves focus to the heading; a failure shows its message`.
  - `FR-5.3: "Show more" loads the next 30 and moves focus to the first new row`.
- [ ] **Step 2: Write the failing E2E** in `notifications.spec.ts` (desktop and mobile; `useCspGuard()`):
  - `FR-5.1: an Admin assigns a Contributor, who sees the bell count go up, opens the list and the item, and receives the email` (read the outbox file for the Contributor's address and assert the subject).
  - `FR-5.1: a mention in a note shows in the list with its excerpt`.
  - `FR-5.3: the list and the empty state pass axe; at 375 px there is no sideways scroll`.
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → pass.
- [ ] **Step 6: Commit** `feat(web): a notifications list with an unread count in the header (FR-5.3)`.

### Task 6: Web: email settings (FR-5.2)

**Files:**
- Create: `apps/web/src/settings/NotificationSettingsPage.tsx`, `useNotificationPrefs.ts`, their tests; `apps/web/e2e/notification-settings.spec.ts`
- Modify: `apps/web/src/App.tsx` (route `/settings/notifications`), `audit/describe.ts`, `audit/AuditPage.tsx`, `styles.css`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces: `PREFS_KEY`, `useNotificationPrefs()`, `useSaveNotificationPrefs()`; `<NotificationSettingsPage />`.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-5.2: the page shows the four rows with their descriptions, checked at the saved values, and the person's time zone in the digest line`.
  - `FR-5.2: "Save changes" sends all four values and says "Saved."; a failure says so and keeps the choices`.
  - `FR-5.2: leaving with unsaved changes asks first, as the item form does`.
- [ ] **Step 2: Write the failing E2E:**
  - `FR-5.2: a person turns "Assigned to you" off, is assigned, sees it in the list and gets no email` (the outbox file gains no line for them after two worker intervals; wait on the in-app row, then on the worker heartbeat advancing, not on a fixed time).
  - `FR-5.2: the settings page passes axe; at 375 px each row stacks with no sideways scroll`.
  - `FR-5.2: the audit log shows "changed their email notification settings."`.
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → pass.
- [ ] **Step 6: Commit** `feat(web): choose instant, digest or off for each kind of notification (FR-5.2)`.

### Task 7: Deployment: the worker in the stack

**Files:**
- Modify: `deploy/poc/docker-compose.yml`, `docker-compose.smoke.yml` (if the worker needs the MinIO-free settings), `.env.example`, `scripts/smoke.sh`, `.github/workflows/ci.yml` (`deploy-smoke` only if needed), `apps/api/Dockerfile` (only if `dist/worker.js` needs anything beyond the existing build)

**Interfaces:**
- Consumes: Task 4's `dist/worker.js` and `WORKER_INTERVAL_MS`.
- Produces: service `worker`.

- Compose: `worker` uses the `roadmap-api:poc` image with `command: ["node", "dist/worker.js"]`, the same `env_file` and production settings as `api` (it loads the same config), the `default` network only (MongoDB and outbound email), `read_only: true`, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, `mem_limit: 256m`, `restart: unless-stopped`, no published port, and a health check that the heartbeat file is newer than three intervals (a `node -e` one-liner reading its mtime). It starts after `mongo` is healthy; nothing depends on it.
- Smoke, inside `SMOKE_WRITES=yes` and only when the new `SMOKE_COMPOSE` variable holds the Compose command (CI sets it to `$COMPOSE`; without it the script prints one line saying these checks were skipped): invite a second person by API, read the invite link from the API container's outbox file (`$SMOKE_COMPOSE exec -T api cat /tmp/outbox.jsonl`), accept it, assign them to the item the script made, then wait (bounded by `SMOKE_WAIT_SECONDS`, polling, no fixed sleep) for a line addressed to them in the worker's own outbox file with the subject "{name} assigned you to {title}"; check the worker is healthy.

- [ ] **Step 1:** Extend `scripts/smoke.sh` and run it against the current stack on the devbox to see the new checks fail.
- [ ] **Step 2:** Change the Compose file and `.env.example` (the worker's memory and that it shares the API's settings).
- [ ] **Step 3:** On the devbox: build, `up --wait`, bootstrap, run the smoke script with `SMOKE_WRITES=yes` → all pass; stop the worker and show the API and site still work; record the worker's memory; `down -v` and check that nothing named `roadmap-smoke*` is left.
- [ ] **Step 4: Commit** `feat(deploy): the notification worker, and a smoke check that an assignment is emailed (FR-5.1)`.

---

## Risks to watch

- **Email reputation.** Instant emails to a whole team on busy days, with no one-click unsubscribe and no bounce handling, can hurt the sending domain in SES. The infrastructure plan should add SES bounce and complaint handling and decide on one-click unsubscribe.
- **Time zones set to UTC.** People created by the bootstrap command have UTC; their digest arrives at 8 am UTC. Changing one's time zone is not in this plan.
- **One worker for every tenant.** A pass walks every tenant's due rows and dates. Fine at POC scale; the SQS design replaces the walk later.

## Next plans (v1)

1. Calendar feed (FR-4).
2. POC infrastructure (server size, S3, KMS, SES with bounce handling, the queue for PDFs and email), then release hardening.

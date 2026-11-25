# v1 Calendar Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person can subscribe to their roadmap dates in Google Calendar, Apple Calendar or Outlook through one private feed URL, choose what it shows, revoke or replace the URL, and download a single item's dates as an .ics file.

**Architecture:** Each person has at most one feed: a row in a new `calendarFeeds` collection holding their choices and a SHA-256 hash of the URL's token. The feed URL is public (calendar apps can't sign in): the API finds the feed by the token's hash, checks the person's current memberships, reads the items, and writes the iCalendar text on each fetch, with an ETag so an unchanged feed costs a 304. One small iCalendar writer serves the feed and the single-item download; its output is checked by parsing it back with `ical.js` in tests.

**Tech Stack:** As the earlier plans, plus `ical.js` (dev dependency of the API, tests only). No new runtime library: the writer is about 100 lines. Before using `ical.js`, read its current docs (context7).

**Spec:** `docs/prd.md`. Sections this plan implements: FR-4.1 to FR-4.5, the Calendar feed entity, "feed tokens are stored only as hashes", the Contract test layer's "iCalendar feed is valid", and the risk row "Calendar apps refresh subscribed feeds slowly".

**Builds on:** branch `v1-notifications` (PR `ltrainsb1/roadmap#6`). Start branch `v1-calendar` from it, or from whichever earlier branch it has been merged into. Earlier decisions are in the six follow-ups documents in `docs/superpowers/plans/`.

**Not in this plan:** Several feeds per person (the user's choice was one). Feeds for people without an account. Writing back from a calendar into the app. Time-of-day events (the app's dates have no times). Building feeds in the worker (the user's choice was on each fetch; the worker or SQS can take it over later behind the same URL).

## Global Constraints

Every constraint in the six earlier plans' Global Constraints sections still binds. The ones this plan leans on, and the new ones:

- Every query goes through `scoped()`, except the one lookup of a feed by its token hash, added to `unscoped()` beside the other lookups by secret hash. Every route has `config.auth`; the feed route is `public` and finds its tenant from the feed.
- The token is 32 random bytes as base64url (the existing `newToken()`); only its SHA-256 hash is stored (`hashToken()`). The token is shown once, when the link is made; it is never logged, never returned again, and never written to the audit log. Request logs shorten it as they shorten snapshot link ids.
- A feed shows only items in roadmaps the person belongs to at the moment of the fetch.
- Entries carry titles, dates and a link back to the app; no descriptions, notes, tags, assignees or files (FR-4.4).
- Untrusted text (titles, milestone names, roadmap names) is escaped as iCalendar TEXT (backslash, semicolon, comma, line breaks) and lines are folded at 75 octets without splitting a UTF-8 character; CRLF line ends throughout.
- Creating a feed, making a new link, turning the feed off and changing its choices write an account-level audit event (`user.calendar_feed`, like `user.notification_prefs`: recorded, not listed on a roadmap's audit page). Fetches are not audited; the feed keeps `lastFetchedAt`.
- The page's content policy stays as it is. Every new E2E spec calls `useCspGuard()`.
- Definition of done for every task: unit tests for pure code, API tests for routes (including one "Tenant isolation: …" test), E2E for screens, coverage at 80% or more in every package (`pnpm run test --coverage` from the repo root), axe passes on each new screen state, each screen works from 375 px wide with no sideways page scroll, and the FR id appears in the test name.
- All tests run as GitHub Actions in the existing jobs. Check the CI result after every push. No test retries, no fixed waits, no wall-clock limits under 5 seconds.
- Docker runs on the devbox through the SSH tunnel, never on the Mac: only containers, images, volumes and networks whose names start with `roadmap-`; never a prune; never ports 80 or 443; never mount the Docker socket into a container; remove what you started.
- On-screen copy follows the `mobbin:plain-writing` rules and the exact text in the UI/UX plan below. Tests assert it word for word.
- Commit trailers name the model that wrote the commit.
- **Plan decisions where the PRD is silent** (the first three are the user's choices; change any of them here and every task follows):
  - *One feed per person* (user's choice). One URL, one set of choices. Changing the choices changes what the same URL shows.
  - *How items appear* (user's choice). An item with both dates is one all-day event from its start date to its end date. An item with one date is a one-day event on that date. Each milestone is its own one-day event titled "{milestone} · {item title}".
  - *Built on each fetch* (user's choice). No stored copies.
  - *The choices.* Roadmaps: "All my roadmaps" (the default; includes roadmaps joined later) or a chosen list. Item dates: on by default. Milestones: on by default. Only items assigned to me: off by default. At least one of item dates and milestones must be on.
  - *Which items.* Items that are archived, have an archived ancestor, or are cancelled are left out. Done items stay (they are history). Items with no dates and no milestones have nothing to show.
  - *The URL* is `{APP_ORIGIN}/api/calendar/{token}.ics`. Because only the hash is kept, the link can't be shown again later: the screen offers "Get a new link", which replaces the old one (the old URL stops working at once), and "Turn off the feed", which deletes it.
  - *Stable ids* (FR-4.3). An item's event UID is `item-{itemId}@{host}`; a milestone's is `milestone-{milestoneId}@{host}`, where `{host}` is `APP_ORIGIN`'s host. `SEQUENCE` is the item's `version`; `DTSTAMP` and `LAST-MODIFIED` are the item's `updatedAt`.
  - *Refresh hints.* The feed sends `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H`; apps may still refresh less often (Google can take hours), which the screen says.
  - *Caching.* `Cache-Control: private, max-age=300`, an `ETag` that is a hash of the body, and 304 for a matching `If-None-Match`. `Content-Type: text/calendar; charset=utf-8`; `X-Robots-Tag: noindex, nofollow`.
  - *Limits.* A feed holds at most 5,000 events (items and milestones together). Past that it keeps upcoming dates first, soonest first, then the most recent past ones, and says so in the calendar's name ("… (nearest 5,000 dates)"). *Changed after the run; see the follow-ups, C13.* Feeds are rate limited at 60 fetches per minute per token.
  - *One-off download* (FR-4.5). "Add to calendar" on an item downloads `{item title}.ics` with the item's event and its milestones' events, using the same UIDs, so subscribing later doesn't duplicate them. It needs the person to be able to see the item. It is offered only for items that have a date or a milestone.
  - *Roadmap deleted, member removed.* A deleted roadmap's id is removed from every feed's chosen list. A removed member's feed simply stops showing that roadmap (membership is checked on each fetch). A chosen list that becomes empty shows an empty calendar; the screen says so.

## Review Focus

- A title or milestone name with `;`, `,`, `\`, line breaks, emoji at the 75-octet fold, and 200 characters of CJK text: `ical.js` parses the feed back to exactly the same strings. (Tasks 2 and 3)
- A feed token from another tenant, a token after "Get a new link", after "Turn off the feed", and a token with one character changed: each is refused with the same 404 and reveals nothing. (Task 3)
- A person removed from a roadmap, a roadmap deleted, an item archived, cancelled, deleted or moved under an archived parent: none of it shows on the next fetch, and the feed never shows an item from a roadmap the person can't see. (Task 3)
- An item whose dates change: the next fetch has the same UID with a higher `SEQUENCE`, so calendar apps update the event instead of adding one; the single-item download uses the same UID. (Tasks 2, 3 and 4)
- A feed with 2,000 items and 5,000 milestones: it answers within the test timeout, stops at 5,000 events with the name saying so, and a second fetch with the ETag gets a 304. (Task 3)

---

## File Structure

```
packages/shared/src/
  calendar.ts                   CALENDAR_LIMITS, feed settings and response schemas
  schemas.ts                    audit action 'user.calendar_feed'
apps/api/src/
  calendar/ics.ts               icsEscape, foldLine, icsCalendar, eventsFor (pure)
  calendar/feed-routes.ts       the person's feed: read, create, change choices, new link, turn off
  calendar/public-routes.ts     GET /api/calendar/:token.ics
  calendar/item-routes.ts       GET …/projects/:projectId/calendar.ics
  db/types.ts, scoped.ts, indexes.ts, unscoped.ts   CalendarFeedDoc, the collection, findCalendarFeedByTokenHash
  members/routes.ts             roadmap delete removes its id from feeds
  logging.ts                    tokens shortened in request logs
apps/web/src/
  settings/CalendarSettingsPage.tsx, useCalendarFeed.ts
  settings/SettingsTabs.tsx     "Security", "Email notifications", "Calendar feed" on the three settings pages
  projects/useItemActions.tsx   "Add to calendar" in an item's Actions menu
  projects/ProjectPanel.tsx     "Add to calendar" in the panel
deploy/poc/Caddyfile            X-Robots-Tag on the feed path
scripts/smoke.sh                a feed check
```

## UI/UX plan

References looked at (Mobbin, web):

- The feed link in a read-only field with a "Copy link" button inside it, and one line naming the calendar apps it works with: [Navan](https://mobbin.com/screens/7b1f181a-96d6-4d53-b7db-03bc1c657694?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Wrangle](https://mobbin.com/screens/e90b2556-b340-490e-a0d7-7277e7fd9415?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).
- Calendar choices as a short form of checkboxes and radios with a Save button under it: [Preply](https://mobbin.com/screens/faf4349d-894f-4477-9780-e3dbbb51459d?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).
- Settings pages share a list of their sections: [Lyssna](https://mobbin.com/screens/2431c154-de1e-4b3e-99c5-38de9f0263a0?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Preply](https://mobbin.com/screens/faf4349d-894f-4477-9780-e3dbbb51459d?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

**Settings tabs.** The Security, Email notifications and Calendar feed pages share a row of tabs at the top: "Security", "Email notifications", "Calendar feed", with the current one marked (`aria-current="page"`).

**Calendar feed page** (`/settings/calendar`). A heading and one sentence. Then one of two states:
- *No feed:* "Create calendar link" button.
- *A feed:* the link section, then the choices form, then "Get a new link" and "Turn off the feed".

The link section shows the URL in a read-only field with "Copy link" only right after the link was made (create or new link), with the three short instructions. On later visits it says the link is active, when it was made, when a calendar app last checked it, and that it can't be shown again.

The choices form: "Roadmaps" as two radios ("All my roadmaps", "Only these") with a checkbox per roadmap under the second, shown when it is chosen; "Show" with two checkboxes ("Item dates", "Milestones"); one checkbox "Only items assigned to me"; "Save changes" and a polite status. Unsaved changes ask before leaving, as the email settings page does.

**Add to calendar.** In an item's Actions menu on the List, Timeline and Board, and as a link-styled button in the item panel under the dates, for items with a date or a milestone. It downloads the file.

Copy (exact):

| Where | Text |
| --- | --- |
| Settings tabs | "Security", "Email notifications", "Calendar feed" |
| Page heading | "Calendar feed" |
| Under the heading | "See your roadmap dates in Google Calendar, Apple Calendar or Outlook. The calendar updates on its own when dates change." |
| No feed | "Create calendar link" |
| Link just made, heading | "Your calendar link" |
| Link field label | "Calendar link" |
| Copy control, status, failure | "Copy link" / "Link copied." / "Couldn't copy the link. Select it and copy it yourself." |
| Link warning | "Anyone with this link can see the dates it shows. Copy it now: for your safety it can't be shown again." |
| Instructions heading | "Add it to your calendar" |
| Instructions | "Google Calendar: Other calendars, +, From URL, then paste the link." · "Apple Calendar: File, New Calendar Subscription, then paste the link." · "Outlook: Add calendar, Subscribe from web, then paste the link." |
| Delay note | "Calendar apps check for changes every few hours, and Google can take longer. To add one item right away, use Add to calendar on the item. It will then show twice, and the added copy won't update when the item changes." |
| Link active (later visits) | "Your calendar link is active. It was made on {date}." then "A calendar app last checked it on {date and time}." or "No calendar app has checked it yet." then "For your safety the link can't be shown again. If you've lost it, get a new link." |
| Form legends and options | "Roadmaps": "All my roadmaps", "Only these" · "Show": "Item dates", "Milestones" · "Only items assigned to me" |
| Hint under "Show" | "Item dates show as one entry from the start date to the end date." |
| No roadmap chosen | "Choose at least one roadmap." |
| Nothing to show | "Choose item dates, milestones or both." |
| Save, saved, failed | "Save changes" / "Saved." / "Couldn't save your choices. Try again." |
| New link | "Get a new link"; dialog "Get a new calendar link?" / "The current link stops working, and calendars that use it stop updating. You'll need to add the new link to them." / "Get new link" / "Cancel" |
| Turn off | "Turn off the feed"; dialog "Turn off your calendar feed?" / "The link stops working and calendars that use it stop updating. Your roadmap dates stay in the app." / "Turn off" / "Cancel" |
| Load failed | "Couldn't load your calendar feed. Try again." with a "Try again" button |
| Action failed | "Something went wrong. Try again." |
| Item menu and panel | "Add to calendar" |
| Download failed | "Couldn't download the calendar file. Try again." |
| Calendar name in the feed | "Roadmap dates" (or "Roadmap dates (nearest 5,000 dates)") |
| Milestone event title | "{milestone} · {item title}" |
| Event description | "Open in Roadmap: {url}" |
| Audit log | "{who} changed their calendar feed." (account-level, as `user.notification_prefs`) |

Dates on the page use `formatDayUtc`; date and time as the notifications list does ("3 Sep 2026 at 14:05").

Accessibility: after "Create calendar link" or "Get new link", focus moves to the "Your calendar link" heading; after "Turn off", to "Create calendar link"; errors are `role="alert"`; "Link copied." and "Saved." are polite statuses; the roadmap checkboxes are a group named "Only these" and are disabled, not hidden, when "All my roadmaps" is chosen, so the layout doesn't jump.

---

### Task 1: Shared rules for the calendar feed

**Files:**
- Create: `packages/shared/src/calendar.ts`; `packages/shared/test/calendar.test.ts`
- Modify: `packages/shared/src/index.ts`, `schemas.ts` (audit action)

**Interfaces:**
- Produces:

```ts
export const CALENDAR_LIMITS = { events: 5000, roadmaps: 100, fetchesPerMinute: 60, maxAgeSeconds: 300 } as const;
export const feedChoicesSchema = z.object({
  roadmaps: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(CALENDAR_LIMITS.roadmaps)]),
  itemDates: z.boolean(), milestones: z.boolean(), onlyMine: z.boolean(),
}).refine((c) => c.itemDates || c.milestones, { message: 'nothing_to_show', path: ['itemDates'] });
export type FeedChoices = z.infer<typeof feedChoicesSchema>;
export const DEFAULT_FEED_CHOICES: FeedChoices = { roadmaps: 'all', itemDates: true, milestones: true, onlyMine: false };
export const feedStateSchema = z.object({
  feed: z.object({ choices: feedChoicesSchema, createdAt: z.string(), lastFetchedAt: z.string().nullable() }).nullable(),
});
/** Only from create and new-link: the one time the URL is ever returned. */
export const feedLinkSchema = feedStateSchema.extend({ url: z.string() });
```

- Audit action added: `'user.calendar_feed'`.

- [ ] **Step 1: Write the failing tests:**
  - `FR-4.2: the default choices are all roadmaps, item dates and milestones, not only mine`.
  - `FR-4.2: choices need item dates or milestones, and a chosen list of at least one roadmap`.
  - `FR-4.2: a list of more than 100 roadmaps is refused`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test` → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @roadmap/shared test && pnpm typecheck` → pass.
- [ ] **Step 5: Commit** `feat(shared): calendar feed choices and limits (FR-4)`.

### Task 2: API: the iCalendar writer (FR-4.3, FR-4.4)

**Files:**
- Create: `apps/api/src/calendar/ics.ts`; `apps/api/test/calendar/ics.test.ts`
- Modify: `apps/api/package.json` (dev dependency `ical.js`)

**Interfaces:**
- Consumes: `ProjectDoc` (`_id`, `title`, `startDate`, `endDate`, `milestones`, `version`, `updatedAt`).
- Produces:

```ts
export function icsEscape(text: string): string;                 // \\ ; , and line breaks as \n
export function foldLine(line: string): string;                  // CRLF + space every 75 octets, never inside a UTF-8 character
export interface IcsEvent { uid: string; summary: string; start: string; end: string; sequence: number; stamp: Date; url: string }  // start, end: YYYY-MM-DD, end inclusive
export function eventsFor(item: Pick<ProjectDoc, '_id' | 'roadmapId' | 'title' | 'startDate' | 'endDate' | 'milestones' | 'version' | 'updatedAt'>, opts: { origin: string; itemDates: boolean; milestones: boolean }): IcsEvent[];
export function icsCalendar(opts: { name: string; events: IcsEvent[] }): string;  // VCALENDAR with PRODID "-//Roadmap//Calendar feed//EN", VERSION 2.0, CALSCALE GREGORIAN, METHOD PUBLISH, X-WR-CALNAME, REFRESH-INTERVAL, X-PUBLISHED-TTL
```

- Each event: `UID`, `DTSTAMP` (UTC, `YYYYMMDDTHHMMSSZ`), `LAST-MODIFIED`, `SEQUENCE`, `DTSTART;VALUE=DATE`, `DTEND;VALUE=DATE` (the day after the inclusive end, as iCalendar requires), `SUMMARY`, `URL`, `DESCRIPTION` ("Open in Roadmap: {url}"), `TRANSP:TRANSPARENT` (dates don't block time).
- The item URL is `{origin}/r/{roadmapId}/projects/{itemId}`.

- [ ] **Step 1: Write the failing tests** (parse every output back with `ical.js`):
  - `FR-4.3: an item with both dates is one all-day event from start to end inclusive, with a stable UID and its version as SEQUENCE`.
  - `FR-4.3: an item with only a start or only an end date is a one-day event on that date`.
  - `FR-4.3: each milestone is a one-day event titled "{milestone} · {item title}" with its own stable UID`.
  - `FR-4.3: changing an item's dates keeps the UID and raises SEQUENCE`.
  - `FR-4.4: an event carries the title, the dates and the link back, and nothing else from the item` (assert the property list).
  - `FR-4.1: titles with ; , \ and line breaks, emoji across the fold, and 200 characters of CJK parse back exactly, and no line is longer than 75 octets`.
  - `FR-4.1: the calendar has its name, refresh hints and CRLF line ends`.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test -- calendar` → pass.
- [ ] **Step 5: Commit** `feat(api): an iCalendar writer for roadmap dates (FR-4.3, FR-4.4)`.

### Task 3: API: the feed and its settings (FR-4.1, FR-4.2, FR-4.3, FR-4.4)

**Files:**
- Create: `apps/api/src/calendar/feed-routes.ts`, `public-routes.ts`; `apps/api/test/calendar/feed.test.ts`, `public.test.ts`
- Modify: `apps/api/src/db/types.ts`, `scoped.ts`, `indexes.ts`, `unscoped.ts`; `app.ts`; `members/routes.ts` (roadmap delete); `logging.ts`

**Interfaces:**
- Consumes: Task 1's schemas; Task 2's writer; `newToken`, `hashToken`; `createAuditLog`.
- Produces:

```ts
export interface CalendarFeedDoc { _id: string; tenantId: string; userId: string; tokenHash: string; choices: FeedChoices; createdAt: Date; lastFetchedAt: Date | null }
// unscoped(): findCalendarFeedByTokenHash(hash: string): Promise<CalendarFeedDoc | null>
export function registerCalendarFeedRoutes(app: FastifyInstance, deps: { now: () => Date }): void;
export function registerCalendarPublicRoutes(app: FastifyInstance, deps: { db: Db; now: () => Date; origin: string }): void;
```

- Indexes: `calendarFeeds`: `{ tokenHash: 1 }` unique; `{ tenantId: 1, userId: 1 }` unique.
- Routes for the signed-in person (`config.auth: { level: 'full' }`, CSRF on writes):
  - `GET /api/me/calendar-feed` → 200 `feedStateSchema`.
  - `POST /api/me/calendar-feed` → 201 `feedLinkSchema` with the defaults; 409 `feed_exists` if one exists.
  - `PUT /api/me/calendar-feed/choices` (body `feedChoicesSchema`) → 200 `feedStateSchema`; 404 `not_found` with no feed; 422 `unknown_roadmap` for a roadmap the person doesn't belong to.
  - `POST /api/me/calendar-feed/new-link` → 200 `feedLinkSchema`; 404 with no feed. The old hash is replaced in one update.
  - `DELETE /api/me/calendar-feed` → 204; 404 with no feed.
  - Each write records `user.calendar_feed` with `before`/`after` of the choices and what happened (`created`, `choices`, `new_link`, `turned_off`); never the token or its hash.
- The public route (`config.auth: { level: 'public' }`): `GET /api/calendar/:token.ics`
  - Finds the feed by `hashToken(token)`; unknown → 404 with an empty body (the same for a malformed token).
  - Reads the person's current memberships, narrows to the chosen roadmaps, reads the items (archived, under an archived ancestor, or cancelled left out; `onlyMine` filters by `assigneeIds`), builds events, sorts by end date then UID, cuts at 5,000.
  - Answers 200 `text/calendar; charset=utf-8` with the headers in the plan decisions, or 304 for a matching `If-None-Match`.
  - Updates `lastFetchedAt` only when it is null or more than 10 minutes old.
  - Rate limited per token at 60 a minute (the existing rate-limit plugin with a per-route key).
- Roadmap delete removes the roadmap's id from every feed's chosen list in its transaction (`$pull`); a list left empty stays empty.
- `serializeRequest` shortens `/api/calendar/{token}.ics` as it does snapshot links.

- [ ] **Step 1: Write the failing tests:**
  - `FR-4.1: creating a feed returns its URL once; reading it afterwards never returns the URL or the token`.
  - `FR-4.1: only the token's SHA-256 hash is stored, and the audit event holds neither`.
  - `FR-4.4: "new link" makes the old URL answer 404 at once and the new one work; "turn off" makes it 404`.
  - `FR-4.4: a token with one character changed, a malformed token and another tenant's token are all the same 404 with an empty body`.
  - `FR-4.2: the feed shows only the chosen roadmaps, only item dates or only milestones as chosen, and only the person's items when asked`.
  - `FR-4.2: a roadmap the person was removed from, a deleted roadmap, and archived, cancelled or deleted items never show; done items do`.
  - `FR-4.2: choosing a roadmap the person isn't a member of is refused`.
  - `FR-4.3: after an item's dates change, the next fetch has the same UID with a higher SEQUENCE and a new ETag`.
  - `FR-4.1: an unchanged feed fetched with its ETag answers 304 with no body`.
  - `FR-4.1: 2,000 items with 5,000 milestones stop at 5,000 events and the calendar name says so`.
  - `FR-4.1: lastFetchedAt is written on the first fetch and at most every 10 minutes`.
  - `FR-4.1: the 61st fetch in a minute for one token is 429`.
  - `FR-4.1: request logs don't contain the token`.
  - `Tenant isolation: a feed never shows another tenant's items, and the settings routes can't reach another person's feed`.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → pass.
- [ ] **Step 5: Commit** `feat(api): a private calendar feed per person, built on each fetch (FR-4.1, FR-4.2, FR-4.3, FR-4.4)`.

### Task 4: API: one item's calendar file (FR-4.5)

**Files:**
- Create: `apps/api/src/calendar/item-routes.ts`; `apps/api/test/calendar/item.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: Task 2's writer; `loadProject`; `cleanFileName`.
- Produces: `GET /api/roadmaps/:roadmapId/projects/:projectId/calendar.ics`, `config.auth: { level: 'full', action: 'roadmap.view' }`, answering `text/calendar; charset=utf-8` with `Content-Disposition: attachment; filename="{cleanFileName(title)}.ics"` (and the RFC 5987 `filename*` form, as `contentDisposition` in `files/object-store.ts` does), `Cache-Control: no-store`; 404 for an unknown or archived item; 422 `no_dates` for an item with no dates and no milestones.

- [ ] **Step 1: Write the failing tests:**
  - `FR-4.5: an item's file holds its event and its milestones, with the same UIDs the feed uses`.
  - `FR-4.5: the file name is the item's title, cleaned, and works with a title in another script`.
  - `FR-4.5: an item with no dates is 422, and an archived or unknown item is 404`.
  - `Tenant isolation: another roadmap's member and another tenant get 404`.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/api test` → pass.
- [ ] **Step 5: Commit** `feat(api): download one item's dates as a calendar file (FR-4.5)`.

### Task 5: Web: the calendar feed page (FR-4.1, FR-4.2, FR-4.4)

**Files:**
- Create: `apps/web/src/settings/CalendarSettingsPage.tsx`, `useCalendarFeed.ts`, `SettingsTabs.tsx`, their tests; `apps/web/e2e/calendar.spec.ts`
- Modify: `apps/web/src/App.tsx` (route `/settings/calendar`), `settings/SecurityPage.tsx` and `settings/NotificationSettingsPage.tsx` (the tabs), `api/errors.ts`, `audit/describe.ts`, `styles.css`

**Interfaces:**
- Consumes: Tasks 1 and 3; `useMe` (memberships for the roadmap list); the "Copy link" hook from `snapshots/CreateSnapshotDialog.tsx` (move it to `ui/` if reused); the unsaved-changes guard from `NotificationSettingsPage.tsx` (share it rather than copy it); `formatDayUtc` and the notifications list's "{day} at {HH:MM}" helper.
- Produces: `CALENDAR_FEED_KEY`, `useCalendarFeed()`, `useCreateFeed()`, `useSaveFeedChoices()`, `useNewFeedLink()`, `useTurnOffFeed()`; `<CalendarSettingsPage />`; `<SettingsTabs current="security" | "notifications" | "calendar" />`.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-4.1: with no feed the page offers "Create calendar link"; creating shows the link, "Copy link", the warning, the instructions and the delay note, and moves focus to "Your calendar link"`.
  - `FR-4.1: on a later visit the link is not shown, and the page says when it was made and when it was last checked (or that it hasn't been)`.
  - `FR-4.2: the choices load, "Only these" enables the roadmap checkboxes, and "Save changes" sends exactly what is ticked; an empty list and nothing to show are refused with their messages`.
  - `FR-4.4: "Get a new link" and "Turn off the feed" ask first, then act; focus moves as the accessibility notes say`.
  - `FR-4.2: leaving with unsaved choices asks first`.
  - `the three settings pages show the tabs with the current one marked`.
- [ ] **Step 2: Write the failing E2E** in `calendar.spec.ts` (desktop and mobile; `useCspGuard()`):
  - `FR-4.1: a person creates a feed, copies the link, and fetching it returns a calendar with their item's dates` (fetch the copied URL through the API request context with no cookies; parse it with `ical.js`).
  - `FR-4.4: after "Get a new link" the old link is 404 and the new one works`.
  - `FR-4.1: the page passes axe with no feed, just after creating, and on a later visit; at 375 px there is no sideways scroll`.
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → pass.
- [ ] **Step 6: Commit** `feat(web): a calendar feed page with a private link and its choices (FR-4.1, FR-4.2, FR-4.4)`.

### Task 6: Web: "Add to calendar" on an item (FR-4.5)

**Files:**
- Modify: `apps/web/src/projects/useItemActions.tsx` (`menuFor`), `projects/ProjectPanel.tsx`, `api/errors.ts`, their tests; `apps/web/e2e/calendar.spec.ts`

**Interfaces:**
- Consumes: Task 4's route.
- Produces: an "Add to calendar" menu entry and panel button for items with a date or a milestone.

The download uses `fetch` (same origin, so the session cookie goes with it) and saves the answer through a Blob URL and a temporary `<a download="{title}.ics">`, revoking the Blob URL afterwards. A plain link would leave the person on an error page when the route refuses; with `fetch`, any failure shows "Couldn't download the calendar file. Try again." and the page stays put.

- [ ] **Step 1: Write the failing unit tests:**
  - `FR-4.5: the Actions menu and the panel offer "Add to calendar" only for items with a date or a milestone`.
  - `FR-4.5: a failed download shows its message`.
- [ ] **Step 2: Write the failing E2E:**
  - `FR-4.5: "Add to calendar" on an item downloads "{title}.ics", which parses to the item's event and its milestones with the feed's UIDs` (Playwright `download` event; parse with `ical.js`).
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm --filter @roadmap/web test && pnpm test:e2e` → pass.
- [ ] **Step 6: Commit** `feat(web): add one item's dates to a calendar (FR-4.5)`.

### Task 7: Deployment: the feed through Caddy

**Files:**
- Modify: `deploy/poc/Caddyfile`, `scripts/smoke.sh`

- Caddyfile: `X-Robots-Tag: noindex, nofollow` on `/api/calendar/*`. The public site's `api` rate-limit zone (100 a minute per address) stays; calendar services fetch from shared addresses, so give `/api/calendar/*` its own zone at 600 a minute per address, with a comment that the API's per-token limit is the real guard.
- Smoke, inside `SMOKE_WRITES=yes`: create a feed, give the item made earlier dates, fetch the feed URL with no cookie and check `BEGIN:VCALENDAR`, the item's title and `Content-Type: text/calendar`; fetch again with the ETag and check 304; turn the feed off and check 404.

- [ ] **Step 1:** Extend `scripts/smoke.sh` and run it against the current stack on the devbox to see the new checks fail (project name starting `roadmap-smoke`, ports 18080, 18443 and 19000 only, never 80 or 443, never mount the Docker socket, run the script from the Mac against the devbox's address).
- [ ] **Step 2:** Change the Caddyfile.
- [ ] **Step 3:** On the devbox: build, `up --wait`, bootstrap, run the smoke script with `SMOKE_WRITES=yes` → all pass; check the headers through Caddy; `down -v` and check nothing named `roadmap-smoke*` is left.
- [ ] **Step 4: Commit** `feat(deploy): the calendar feed through the proxy, and a smoke check (FR-4.1)`.

---

## Risks to watch

- **Calendar apps refresh slowly.** Google can take 12 hours or more. The page says so and offers the single-item download (the PRD's own mitigation).
- **A feed URL is a secret in someone's calendar.** Anyone it's shared with sees the titles and dates. The page says so; "Get a new link" is the remedy.
- **Shared fetch addresses.** Google and Microsoft fetch from a few addresses for everyone; the per-address proxy limit for feeds is loose on purpose, and the per-token limit in the API does the guarding.

## Next plans (v1)

1. POC infrastructure (server size, S3, KMS, SES with bounce handling and unsubscribe, the queue for PDFs and email).
2. Release hardening.

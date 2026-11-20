# v1 Timeline and Board Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every member can look at a roadmap's items as a Timeline (bars and milestones on a time axis) and as a Board (one column per status), beside the existing List, with the same search, filters and item panel in all three.

**Architecture:** No API change. The three views are routes under the Projects tab that share one page frame: the toolbar, the filters, the item panel and the dialogs. The row actions move out of `ProjectsPage.tsx` into one hook that all three views call. The Timeline's layout maths (date range, bar positions, axis ticks) are pure functions in `packages/shared`, because the snapshot plan (FR-3.3) draws the same timeline later. The Board changes status through the existing edit route with the item's `version`.

**Tech Stack:** As the earlier plans (React 19, React Router 7, TanStack Query, `@dnd-kit/core`, Vitest, Playwright, axe). No new dependency.

**Spec:** `docs/prd.md`. Sections this plan implements: FR-1.7 (Timeline and Board), FR-1.9 ("the timeline scrolls sideways", and both views from 375 px), FR-1.8 as it applies to the two new views, and the Dependencies rule that "blocked by" conflicts are flagged on screen.

**Builds on:** branch `v1-foundation` (PR `ltrainsb1/roadmap#1`). Start branch `v1-views` from it, or from `main` once that PR is merged. Earlier decisions are in the two follow-ups documents in `docs/superpowers/plans/`.

**Not in this plan:** Changing dates by dragging bars (you chose view only). Dependency arrows on the Timeline (the PRD rules out Gantt-style scheduling). Adding items from the Timeline or Board. Reordering cards within a column. Notes, attachments, snapshots.

## Global Constraints

Every constraint in the two earlier plans' Global Constraints sections still binds. The ones this plan leans on, and the new ones:

- **No API change.** If a task seems to need a new route, field or error code, stop and report it; do not add one.
- The page's style policy is `style-src 'self'`. Positions and sizes are set through React's `style` prop, which uses the DOM style API and is allowed. No `<style>` element and no HTML string with a `style` attribute. Every new E2E spec calls `useCspGuard()`.
- Authorization on screen comes from `can()` in `@roadmap/shared`; the server still decides. A control the person may not use is not rendered.
- Definition of done for every task: unit tests for pure code, E2E for screens, coverage at 80% or more in every package (`pnpm run test --coverage` from the repo root), axe passes on each new screen, each screen works from 375 px wide with no sideways page scroll, and the FR id appears in the test name.
- All tests run as GitHub Actions in the existing jobs. Check the CI result after every push. No test retries and no fixed waits.
- Docker runs on the devbox through the SSH tunnel; run the E2E suite once per task with `TEST_MONGO=container`.
- On-screen copy follows the `mobbin:plain-writing` rules and the exact text in the UI/UX plan below. E2E tests assert that text word for word.
- Commit trailers name the model that wrote the commit.
- **Plan decisions where the PRD is silent** (change them here and every task follows):
  - The views are "List", "Timeline" and "Board", in that order, chosen with a switcher inside the Projects tab. Addresses: `/r/:roadmapId/projects`, `/r/:roadmapId/timeline` and `/r/:roadmapId/board`, each with an optional `/:projectId` that opens the panel.
  - Search and filters live in the query string and are kept when the view changes. Two more query values are kept the same way: `zoom` (Timeline) and `level` (Board).
  - The Timeline is view only. Choosing a row opens the panel, where dates are edited.
  - Timeline rows are the same nested, collapsible tree as the List, in the same order, sharing its collapsed state.
  - An item with both dates is a bar from start to end, both days included. An item with only a start or only an end is a one-day marker at that date. An item with no dates has no bar and reads "No dates". Milestones are diamonds on their item's row.
  - Zoom is "Weeks" (24 px a day), "Months" (6 px a day, the default) or "Quarters" (2 px a day).
  - The axis runs from the first day of the month before the earliest date shown to the last day of the month after the latest, and always includes today. It is never wider than 24,000 px: beyond that, days get narrower.
  - "Today" is the calendar date in the signed-in person's time zone (the `timezone` on their account).
  - The Board shows one level at a time, chosen with a "Level" control that starts on Projects. Cards in a column are in the List's order.
  - Moving a card to another column changes its status. It can be dragged with a pointer or by touch, and every card also has the status menu, which is the keyboard path. The card moves at once and goes back if the save is refused.
  - While filters are on, the Board shows only matching items at the chosen level. Archived items appear only with "Show archived", carry the word "Archived" and can't be moved.
  - Timeline rows and Board cards have an "Actions" menu with "Open", "Archive" or "Unarchive", and "Delete". Adding items, "Move up" and "Move down" stay on the List, and so does the "New project" button.

## Review Focus

1. **Dates very far apart.** One item in 1900 and another in 2200 must not produce a page millions of pixels wide: the axis stays at 24,000 px or less and every bar is still at least 8 px wide. Tests in Task 3 and Task 5.
2. **Items with one date or none.** Start only, end only and no dates each draw as the decisions say, and none of them breaks the range calculation. Tests in Task 3 and Task 4.
3. **Moving a card someone else just changed.** The save gets `409 conflict`: the card goes back to its column, the existing conflict message shows, and the list is refetched. Test in Task 7.
4. **A person who may not change the item.** A Contributor who is not assigned sees no drag handle and no status menu. One whose assignment was removed a moment ago gets the read-only message and the card goes back. Tests in Task 6 and Task 7.
5. **Unsaved edits in the panel.** Switching view with unsaved text asks before discarding. Moving the card of the item that is open in the panel updates the panel's Status, and its Save afterwards does not conflict. Tests in Task 4 and Task 7.

---

## File Structure

```
packages/shared/src/
  timeline.ts              pure functions: dayNumber, timelineRange, barFor, xOf, timelineTicks
  project-rules.ts         adds treeOrder
packages/shared/test/      timeline.test.ts; project-rules.test.ts gains treeOrder cases
apps/web/e2e/
  fixtures.ts              signed-in fixtures that set up accounts through the API
  timeline.spec.ts, board.spec.ts
apps/web/src/projects/
  useItemActions.tsx       every action on an item, the unsaved-edits guard, the Delete and Discard dialogs
  ProjectsPage.tsx         the page frame: heading, toolbar, filters, the chosen view, the panel
  ViewSwitcher.tsx         List, Timeline, Board
  StatusMenu.tsx           the status pill and its menu, moved out of ProjectTree.tsx
  TimelineView.tsx         rows, bars, milestones, the today line
  TimelineAxis.tsx         the two header rows of ticks
  BoardView.tsx            columns, the Level control, drag between columns
  BoardCard.tsx            one card
  today.ts                 todayIn(timeZone)
  filters.ts               adds the zoom and level query values
  names.ts                 adds levelPlural and formatMilestone
```

---

## UI/UX plan

This section and all on-screen copy follow the `mobbin:plain-writing` rules. The earlier plans' layout rules still apply: one primary button per screen, 44 px controls, labels above fields, a red button and a confirm dialog for anything destructive.

I looked at 17 screens on Mobbin for timelines and boards, on web and on iOS. The choices below name the screens they follow. Where no reference is named, the choice is my opinion.

**Choosing a view**

A switcher with "List", "Timeline" and "Board" sits in the toolbar, to the right of the search field and the Filters button. The current view is marked.
References: [Programa](https://mobbin.com/screens/b0713e1b-1097-4828-bd2a-841bf0ff9bec?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Motion](https://mobbin.com/screens/0cd73569-44d4-4f20-98b9-21fa5e8f814c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Wrike](https://mobbin.com/screens/c434841e-d302-4ebd-a376-a1b3973c40da?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

The switcher is three links, not buttons, because each view has its own address. The "Projects" tab stays marked in all three views. My opinion.

**Timeline**

Item names are in a column at the left. The bars are in a wide area at the right that scrolls sideways under a header of dates, while the names stay in place.
References: [Confluence](https://mobbin.com/screens/2a2a4efd-a15f-4faa-a8a9-65381ae9de0c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Zoom](https://mobbin.com/screens/fbc19955-5b88-4102-b1d8-db0523682199?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Rows nest and collapse with a chevron, as in the List. A warning icon sits beside the name of an item with a date warning.
References: [Confluence](https://mobbin.com/screens/2a2a4efd-a15f-4faa-a8a9-65381ae9de0c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

A vertical line marks today, and a "Today" button scrolls it into view. A "Zoom" control offers Weeks, Months and Quarters.
References: [Confluence](https://mobbin.com/screens/2a2a4efd-a15f-4faa-a8a9-65381ae9de0c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Motion](https://mobbin.com/screens/0cd73569-44d4-4f20-98b9-21fa5e8f814c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Airtable](https://mobbin.com/screens/508b5288-9eee-43db-bf2a-7164a55a7ef4?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

The header has two rows: months over weeks, or years over months or quarters.
References: [Zoom](https://mobbin.com/screens/fbc19955-5b88-4102-b1d8-db0523682199?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Motion](https://mobbin.com/screens/0cd73569-44d4-4f20-98b9-21fa5e8f814c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

The Timeline is a table for assistive technology: each row has the item's name, its status and its dates as text, so nothing is carried by position or colour alone. Milestones are listed by name and date. My opinion; the references can't show this.

The status is the same pill as in the List, beside the name, from 600 px wide. Bars are tinted by status, and the pill is what says it in words. My opinion.

At 375 px the name column is 140 px wide and shows only the name; the bar area scrolls sideways inside its own frame and the page does not. My opinion; the references are desktop screens.

**Board**

Five columns, one per status, in the order Not started, In progress, Blocked, Done, Cancelled. Each heading shows the status and how many cards it holds.
References: [Wrike](https://mobbin.com/screens/c434841e-d302-4ebd-a376-a1b3973c40da?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Programa](https://mobbin.com/screens/b0713e1b-1097-4828-bd2a-841bf0ff9bec?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Asana](https://mobbin.com/screens/0a9f2bf5-409a-4af8-9493-531dd6868124?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

A card shows the title, then the assignees and the dates on one line below it.
References: [Wrike](https://mobbin.com/screens/c434841e-d302-4ebd-a376-a1b3973c40da?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Asana](https://mobbin.com/screens/0a9f2bf5-409a-4af8-9493-531dd6868124?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Slack](https://mobbin.com/screens/fd9a81ad-6a72-4916-8eed-5092bd02ad17?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

A card below the top level names the item it belongs to, as "In {parent title}". A "Level" control above the columns picks which level the board shows. My opinion: Wrike nests sub-items inside the card, which gets long at four levels.

A card that can be moved has a drag handle.
References: [Codecademy](https://mobbin.com/screens/a6a5ac0a-54fa-46b1-94f2-4e424621cefa?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Every card also has the status menu from the List, so status can be changed without dragging. My opinion; it is also what makes the board usable from a keyboard.

At 375 px the columns sit side by side and scroll sideways, one column filling most of the width with the next one showing at the edge.
References: [Jira Cloud](https://mobbin.com/screens/843320a5-d676-42a3-a2df-5b10ee793c7c?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Asana on iOS](https://mobbin.com/screens/e8502c9c-3cea-422b-8434-0e871f4c4d71?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Notion on iOS](https://mobbin.com/screens/71f9dba2-130f-406e-b4fe-781f227f51b8?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

The references put an "Add task" button in each column. This plan leaves adding to the List, so a new item's place in the nested order is always chosen where that order is visible. My opinion.

**Screens and copy**

| Where | On it | Messages |
| --- | --- | --- |
| View switcher | A group named "View" with links "List", "Timeline" and "Board". | |
| Timeline (`/r/:roadmapId/timeline`) | Heading "Projects". Search, Filters and the switcher as on the List. Control "Zoom" with "Weeks", "Months" and "Quarters". Button "Today". A table named "Timeline" with column headings "Name" and "Schedule". A line labelled "Today". | Empty: the List's "No projects yet." wording. No match: "No projects match these filters." with button "Clear filters". Items but no dates anywhere: "No items have dates yet. Open an item to add its dates." |
| Timeline row | Chevron "Collapse {title}" or "Expand {title}". Title, which opens the panel. Status pill. Warning icon "Has warnings". Menu button "Actions for {title}". In the schedule: the dates as the List writes them ("3 Mar to 28 Apr 2027", "From 3 Mar 2027", "Until 28 Apr 2027"), or "No dates". | Each milestone: "Milestone: {name}, 3 Mar 2027". Archived items, when shown, carry the word "Archived". |
| Board (`/r/:roadmapId/board`) | Heading "Projects". Search, Filters and the switcher. Control "Level" with "Projects", "Sub-projects", "Tasks" and "Sub-tasks". Five columns, each a region named "{Status}, {n} items" (or "1 item") with a visible heading "{Status}" and the count. | Empty column: "No items". Nothing at the level: "No sub-projects yet.", "No tasks yet.", "No sub-tasks yet." (Projects keeps the List's wording). No match: "No projects match these filters." with button "Clear filters". |
| Board card | Title, which opens the panel. "In {parent title}" below the top level. Assignee names, or "Unassigned". Dates as the List writes them. Priority label, if set. Status menu named "Status of {title}: {status}". Drag handle named "Move {title}". Menu button "Actions for {title}". | Archived items carry the word "Archived". |
| Moving a card | Said to screen readers: "Picked up {title}.", "{title} is over {status}.", "Moved {title} to {status}.", "Move cancelled." Instructions on the handle: "Drag this card to another column, or use its status menu." | A refused move shows the existing message for its error code. |
| Row and card menu | "Open", "Archive" or "Unarchive", "Delete". | The existing Delete dialog and "Archived {title}." notice. |

One element keeps one name everywhere, as before. New here: "view" for List, Timeline and Board; "level" for Projects, Sub-projects, Tasks and Sub-tasks; "card" for an item on the Board.

---

### Task 1: Signed-in E2E fixtures

The specs create each account by clicking through set-password and authenticator setup, about 70 times a run. This task does the same steps through the API.

**Files:**
- Create: `apps/web/e2e/fixtures.ts`, `apps/web/e2e/fixtures.spec.ts`
- Modify: every spec in `apps/web/e2e/` except `auth.spec.ts`; `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes from `helpers.ts`: `bootstrapUser`, `totpFor`, `readLastMail`, `uniqueEmail`, `PASSWORD`, `TestUser`, `apiAs`.
- Produces in `fixtures.ts`:
  - `signUpByApi(context: BrowserContext, label: string): Promise<TestUser>`. Runs `bootstrapUser`, then with `context.request`: `POST /api/auth/password-reset/confirm`, `POST /api/auth/login`, `POST /api/auth/totp/enroll/start`, `POST /api/auth/totp/enroll/confirm`, sending each response's `csrfToken` on the next call. The context ends fully signed in. The returned `secret` and `recoveryCodes` are real.
  - `joinByApi(browser: Browser, call: ApiCall, roadmapId: string, role: 'admin' | 'contributor', label: string): Promise<{ context: BrowserContext; page: Page; user: TestUser }>`. Invites through `call`, reads the token from the mail, and in a new context accepts with a name and password and enrolls, all through the API.
  - `type ApiCall = Awaited<ReturnType<typeof apiAs>>`.
  - `test`, extended from Playwright's with fixtures `owner: TestUser` (signed in on `page`), `call: ApiCall`, and `roadmap: { id: string; name: string }` (created with `POST /api/roadmaps`; the page is not navigated).
  - `expect`, re-exported.
- `createSignedInUser`, `createEnrolledUser` and `joinViaInvite` stay in `helpers.ts` for the specs whose subject is that flow.

- [ ] **Step 1: Write the failing spec** `apps/web/e2e/fixtures.spec.ts`:
  - `'the owner fixture is signed in without visiting the sign-in screens'`: `await page.goto('/')`; expect heading "Roadmaps"; expect `owner.recoveryCodes` to have length 10.
  - `'the roadmap fixture exists and joinByApi adds a member who can open it'`: join a contributor; on their page go to `/r/${roadmap.id}/projects`; expect heading "Projects".
  - `'a code from the fixture secret is accepted'`: sign out, then `signInWithTotp(page, owner.email, owner.secret)`; expect URL `/`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e fixtures`. Expected: FAIL, `fixtures.ts` does not exist.
- [ ] **Step 3: Implement `fixtures.ts`.**
- [ ] **Step 4: Move the specs over.** In `audit`, `members`, `projects`, `project-filters`, `project-order`, `project-panel`, `roadmaps` and `settings` specs, import `test` and `expect` from `./fixtures.ts` and use `owner`, `call`, `roadmap` and `joinByApi` wherever the sign-up or the invite is setup and not the thing under test. Keep the UI path in the tests that are about it (accepting an invite in the browser, the Security page's own prompts). After this, `createSignedInUser` is called only from `auth.spec.ts`.
- [ ] **Step 5: Run** `pnpm test:e2e` twice. Expected: PASS both times, with the run noticeably shorter than before. Put both durations in the commit message.
- [ ] **Step 6: Commit** `test(web): sign-in fixtures that set accounts up through the API`.

---

### Task 2: One hook for item actions

`ProjectsPage.tsx` holds every action on an item. The two new views need the same actions, so they move into a hook. Behaviour does not change; the existing E2E specs are the proof.

**Files:**
- Create: `apps/web/src/projects/useItemActions.tsx`, `apps/web/src/projects/StatusMenu.tsx`
- Modify: `apps/web/src/projects/ProjectsPage.tsx`, `apps/web/src/projects/ProjectTree.tsx`
- Test: `apps/web/src/projects/StatusMenu.test.tsx`

**Interfaces:**
- Produces in `useItemActions.tsx`:

```ts
export interface ItemActions {
  actionError: string | undefined;
  notice: string;
  setNotice(text: string): void;
  ownChange: OwnChange | undefined;
  /** Resolves true once saved; false when refused, or when the item already has that status. */
  changeStatus(item: Project, status: ProjectStatus): Promise<boolean>;
  toggleAssignee(itemId: string, userId: string, assigned: boolean): void;
  changePriorityLabel(itemId: string, label: PriorityLabel | null): void;
  reorderItems(parentId: string | null, orderedIds: string[], announce?: string): void;
  archiveItem(item: Project): void;
  unarchiveItem(item: Project): void;
  askDelete(item: Project): void;
  openItem(itemId: string): void;
  closePanel(): void;
  /** Runs `action` now, or after the person agrees to discard unsaved panel edits. */
  unlessDirty(action: () => void): void;
  onDirtyChange(dirty: boolean): void;
  reloadItem(): Promise<Project | undefined>;
  /** "Open", then "Archive" or "Unarchive" and "Delete" when the person may delete the item. */
  menuFor(item: Project): MenuItem[];
  /** The Delete and Discard dialogs. The page renders this once. */
  dialogs: ReactNode;
  /** Put on the page's h1: focus goes there when the item that held it is gone. */
  headingRef: RefObject<HTMLHeadingElement | null>;
}

export function useItemActions(opts: {
  roadmapId: string;
  role: Role;
  myId: string | undefined;
  /** The view's own address, such as `/r/abc/projects`; an item opens at `${basePath}/${id}`. */
  basePath: string;
  /** The query string to keep, with its leading "?" or empty. */
  search: string;
  projectId: string | undefined;
  projects: ReturnType<typeof useProjects>;
  members: ReturnType<typeof useMembers>;
}): ItemActions;
```

- Produces in `StatusMenu.tsx`: `StatusMenu({ item, editable, onChange }: { item: Project; editable: boolean; onChange: (status: ProjectStatus) => void })`. With `editable` it is the pill button named "Status of {title}: {status}" opening the five statuses; without, the plain pill. `ProjectTree.tsx` uses it in place of its inline menu.
- `ProjectsPage.tsx` keeps the filters, the add row, the layout and the panel, and calls the hook for the rest. `changeStatus` now returns a promise; the List ignores it.

- [ ] **Step 1: Write the failing test** `StatusMenu.test.tsx`:
  - `'an editable item shows a button named with the title and status, and choosing a status calls onChange'`: render with a "Launch site" item at `not_started`; click the button named "Status of Launch site: Not started"; click "Done"; expect `onChange` called once with `'done'`.
  - `'a read-only item shows the status as text with no button'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test StatusMenu`. Expected: FAIL.
- [ ] **Step 3: Implement** `StatusMenu.tsx` and `useItemActions.tsx`, and cut `ProjectsPage.tsx` and `ProjectTree.tsx` over to them. Move code; do not rewrite it. `ProjectsPage.tsx` should end under 250 lines.
- [ ] **Step 4: Run** `pnpm lint`, `pnpm typecheck`, `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS with no spec changed.
- [ ] **Step 5: Commit** `refactor(web): item actions in one hook, status menu in one component`.

---

### Task 3: Shared timeline maths

**Files:**
- Create: `packages/shared/src/timeline.ts`, `packages/shared/test/timeline.test.ts`
- Modify: `packages/shared/src/project-rules.ts`, `packages/shared/src/index.ts`, `packages/shared/test/project-rules.test.ts`

**Interfaces:**
- Produces in `timeline.ts`:

```ts
export const TIMELINE_ZOOMS = ['weeks', 'months', 'quarters'] as const;
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];
export const DAY_WIDTH: Record<TimelineZoom, number> = { weeks: 24, months: 6, quarters: 2 };
export const MAX_AXIS_WIDTH = 24000;
export const MIN_BAR_WIDTH = 8;

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number;

export interface TimelineRange {
  /** First day shown, always the 1st of a month. */
  start: string;
  /** Last day shown, always the last day of a month. */
  end: string;
  days: number;
  /** Pixels per day: the zoom's width, or less when that would pass MAX_AXIS_WIDTH. */
  dayWidth: number;
  /** days × dayWidth. */
  width: number;
}
export function timelineRange(items: readonly Project[], today: string, zoom: TimelineZoom): TimelineRange;

/** Pixels from the axis start to the left edge of `date`. */
export function xOf(date: string, range: TimelineRange): number;

export interface TimelineBar {
  left: number;
  width: number;
  /** 'range' has both dates; 'start' and 'end' are one-day markers for an item with only that date. */
  kind: 'range' | 'start' | 'end';
}
export function barFor(item: Pick<Project, 'startDate' | 'endDate'>, range: TimelineRange): TimelineBar | null;

export interface TimelineTick { date: string; left: number; width: number; label: string }
/** Upper and lower header rows. `minor` is empty when its ticks would average under 24 px wide. */
export function timelineTicks(range: TimelineRange, zoom: TimelineZoom): { major: TimelineTick[]; minor: TimelineTick[] };
```

- Range rule: take every `startDate`, `endDate` and milestone date of `items`, and `today`. `start` is the 1st of the month before the earliest; `end` is the last day of the month after the latest.
- Tick labels, formatted in `en-GB` at UTC. Weeks: major is the month ("March 2027"), minor is each Monday's day number ("1", "8"). Months: major is the year ("2027"), minor is the month ("Mar"). Quarters: major is the year, minor is "Q1" to "Q4". A tick cut by the range edge starts or ends at the edge.
- Produces in `project-rules.ts`: `treeOrder(items: readonly Project[]): Map<string, number>`, each item's index when the tree from `buildTree` is walked depth first. Items `buildTree` drops are absent.

- [ ] **Step 1: Write the failing tests** `timeline.test.ts`. One item, 2027-03-03 to 2027-04-28, today 2027-03-15 unless a test says otherwise:
  - `'dayNumber counts whole days'`: `dayNumber('1970-01-01')` is 0; `dayNumber('2027-03-03') - dayNumber('2027-02-01')` is 30.
  - `'the range runs from the month before the earliest date to the month after the latest'`: at `months`, expect `{ start: '2027-02-01', end: '2027-05-31', days: 120, dayWidth: 6, width: 720 }`.
  - `'today widens the range'`: today 2027-09-10 gives `end: '2027-10-31'`.
  - `'a milestone outside the item's dates widens the range'`: a milestone on 2026-12-20 gives `start: '2026-11-01'`.
  - `'with no dates anywhere the range is the three months around today'`: no items, today 2027-03-15: `start: '2027-02-01'`, `end: '2027-04-30'`.
  - `'Review focus 1: dates centuries apart keep the axis at 24,000 px'`: items in 1900-01-01 and 2200-12-31 at `weeks`: `width <= 24000`, `dayWidth < 24`, and `barFor` of a one-day item has `width` 8.
  - `'barFor places a range'`: `{ left: 180, width: 342, kind: 'range' }`.
  - `'Review focus 2: start only and end only are one-day markers, no dates is null'`: start only 2027-03-03 gives `{ left: 180, width: 8, kind: 'start' }`; end only 2027-04-28 gives `kind: 'end'` with `left` 516; neither date gives `null`.
  - `'ticks at months: years over months'`: major `[{ label: '2027', left: 0, width: 720 }]`; minor labels `['Feb', 'Mar', 'Apr', 'May']`, the first with `left: 0, width: 168`.
  - `'ticks at weeks: months over Mondays'`: major labels start `'February 2027'`; the first minor tick is `{ date: '2027-02-01', label: '1', left: 0, width: 168 }` (1 February 2027 is a Monday).
  - `'ticks at quarters'`: range Feb to May 2027 gives minor labels `['Q1', 'Q2']` with Q1 starting at `left: 0` and 59 days wide.
  - `'minor ticks are dropped when too narrow'`: the 1900 to 2200 range at `weeks` gives `minor: []`.
  - In `project-rules.test.ts`: `'treeOrder walks depth first by rank'`: A (rank 0) with children A1, A2, and B (rank 1) give A 0, A1 1, A2 2, B 3.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test`. Expected: FAIL.
- [ ] **Step 3: Implement.** All date arithmetic in UTC, from `dayNumber`; no `Date` in local time.
- [ ] **Step 4: Run** `pnpm run test --coverage`. Expected: PASS, shared coverage still above 80%.
- [ ] **Step 5: Commit** `feat(shared): timeline range, bars and ticks (FR-1.7)`.

---

### Task 4: Web: the view switcher and the Timeline (FR-1.7)

**Files:**
- Create: `apps/web/src/projects/ViewSwitcher.tsx`, `TimelineView.tsx`, `TimelineAxis.tsx`, `today.ts`, `today.test.ts`, `apps/web/e2e/timeline.spec.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/projects/ProjectsPage.tsx`, `filters.ts`, `filters.test.ts`, `names.ts`, `names.test.ts`, `apps/web/src/roadmaps/RoadmapLayout.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2's `useItemActions` and `StatusMenu`; Task 3's `timelineRange`, `barFor`, `xOf`, `timelineTicks`; `buildTree`, `projectWarnings`; the List's `useCollapsed` and `viewOf`.
- Produces: `type ProjectView = 'list' | 'timeline' | 'board'` and `viewPath(roadmapId: string, view: ProjectView): string` (`/r/{id}/projects`, `/timeline`, `/board`) in `ViewSwitcher.tsx`. `ViewSwitcher({ roadmapId, view, search, onNavigate, views })`: a `nav` named "View" with one link per entry of `views`, `aria-current="page"` on the current one; a plain click calls `onNavigate(path)` so the page can ask about unsaved edits. This task passes `views={['list', 'timeline']}`; Task 6 adds `'board'`.
- Produces: `ProjectsPage({ view }: { view: ProjectView })`. `App.tsx` adds route `timeline/:projectId?` rendering it with `view="timeline"`, keyed by roadmap as the List is. "New project" and the add row render only when `view === 'list'`.
- Produces in `filters.ts`: `viewOptionsFromSearch(params: URLSearchParams): { zoom: TimelineZoom; level: 1 | 2 | 3 | 4 }` (defaults `months` and 1; an unknown value falls back to the default) and `searchFor(filters: ProjectFilters, options: { zoom: TimelineZoom; level: 1 | 2 | 3 | 4 }): URLSearchParams`, which writes `zoom` and `level` only when they differ from the default. The page builds every query string with `searchFor`, so changing a filter keeps the zoom.
- Produces in `today.ts`: `todayIn(timeZone: string, now: Date = new Date()): string`, the `YYYY-MM-DD` date in that zone.
- Produces in `names.ts`: `formatMilestone(m: { name: string; date: string }): string` giving "Milestone: {name}, 3 Mar 2027".
- `RoadmapLayout.tsx`: the Projects tab is marked on all three view addresses, and switching roadmap keeps the view and drops the item id.
- `TimelineView` props: `roadmapId`, `role`, `myId`, `items`, `contextIds`, `expandAll`, `byId`, `today`, `zoom`, `selectedId`, `collapsed`, `onToggle`, `search`, `actions: ItemActions`. It renders a `table` named "Timeline": each row a `th` with chevron, title link, `StatusMenu`, warning icon and Actions menu, and a `td` holding the track. In the track: the bar (a `span` with class `bar status-{status} kind-{kind}`, positioned by `style`), a visually hidden text with `formatDates(...)`, each milestone as a diamond positioned at `xOf(date)` with visually hidden `formatMilestone` text, and the today line. The header row is `TimelineAxis`, hidden from assistive technology except the "Name" and "Schedule" headings.
- Zoom, the "Today" button and the small-screen layout are Task 5. This task renders at the default zoom with the track scrolling sideways.

- [ ] **Step 1: Write the failing unit tests.**
  - `today.test.ts`: `'todayIn gives the date in the person's zone'`: `todayIn('Pacific/Auckland', new Date('2027-03-15T12:00:00Z'))` is `'2027-03-16'`; with `'America/Los_Angeles'` and `2027-03-15T05:00:00Z` it is `'2027-03-14'`.
  - `filters.test.ts`: `'zoom and level are read with defaults and written only when not the default'`: `?zoom=weeks&level=3` reads `{ zoom: 'weeks', level: 3 }`; `?zoom=days&level=9` reads `{ zoom: 'months', level: 1 }`; `searchFor(NO_FILTERS, { zoom: 'months', level: 1 }).toString()` is `''`; with `zoom: 'quarters'` it is `'zoom=quarters'`.
  - `names.test.ts`: `formatMilestone({ name: 'Beta', date: '2027-03-03' })` is `'Milestone: Beta, 3 Mar 2027'`.
- [ ] **Step 2: Write the failing E2E** `timeline.spec.ts`, using the Task 1 fixtures, `useCspGuard()` and `page.clock.setFixedTime('2027-03-15T12:00:00Z')`. Seed through `call`: "Launch site" (3 Mar to 28 Apr 2027) with child "Design" (start 10 Mar 2027 only) and milestone "Beta" on 1 Apr 2027; "Hire" with no dates.
  - `'FR-1.7: the switcher opens the Timeline, keeps the filters, and marks the Projects tab'`: from `/r/{id}/projects?q=la`, click "Timeline"; expect URL `/r/{id}/timeline?q=la`, "Timeline" has `aria-current="page"`, and the "Projects" tab is current.
  - `'FR-1.7: each item is a row with its dates as text, and milestones are named'`: in the table "Timeline", the row "Launch site" contains "3 Mar to 28 Apr 2027" and "Milestone: Beta, 1 Apr 2027"; "Design" contains "From 10 Mar 2027"; "Hire" contains "No dates".
  - `'bars sit where the dates say'`: read the bounding boxes of the "Launch site" bar and the today line; the bar is 342 px wide and the today line is 72 px right of the bar's left edge (12 days at 6 px).
  - `'rows collapse and expand, and the List shows the same state'`.
  - `'choosing a row opens the panel beside the Timeline, and saving new dates moves the bar'`: open "Hire", set 1 Mar to 5 Mar 2027, Save; the row then contains "1 Mar to 5 Mar 2027".
  - `'the status pill and the Actions menu work on a row'`: set "Hire" to Done from its pill; archive it from its menu; expect notice "Archived Hire.".
  - `'Review focus 5: switching view with unsaved panel text asks first'`: type in Title, click "List"; expect the dialog "Discard your unsaved changes to Hire?"; "Keep editing" stays on the Timeline.
  - `'filters apply: a search shows the match and its greyed ancestor'`: `?q=design` shows "Design" and "Launch site" with "Shown for context", and not "Hire".
  - `'empty states'`: a roadmap with no items shows "No projects yet." and no "New project" button; one whose items have no dates shows "No items have dates yet. Open an item to add its dates.".
  - `'a Contributor who is not assigned sees plain status text and no Archive or Delete'`.
  - `expectNoA11yViolations` on the Timeline with rows, and with the panel open.
- [ ] **Step 3: Run** `pnpm --filter @roadmap/web test:e2e timeline`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): Timeline view and the view switcher (FR-1.7)`.

---

### Task 5: Web: Timeline zoom, Today and small screens (FR-1.7, FR-1.9)

**Files:**
- Modify: `apps/web/src/projects/ProjectsPage.tsx`, `TimelineView.tsx`, `TimelineAxis.tsx`, `apps/web/src/styles.css`, `apps/web/e2e/timeline.spec.ts`

**Interfaces:**
- Consumes: Task 4's `viewOptionsFromSearch`, `searchFor`, `TimelineView`; Task 3's `TIMELINE_ZOOMS`.
- Produces: a `SelectField` labelled "Zoom" (options "Weeks", "Months", "Quarters") and a button "Today" in the toolbar when `view === 'timeline'`. Changing zoom replaces the address with `zoom=` set.
- `TimelineView` gains prop `scrollToTodaySignal: number`; when it changes, the track scrolls so the today line is one third from the left. On first render the same scroll runs once.
- The track is one scroll container around the whole table body, so the header ticks and every row move together; the name column is `position: sticky` at the left. Below 600 px the name column is 140 px and the status pill and Actions menu are hidden in it (both are in the panel and the List).

- [ ] **Step 1: Write the failing E2E** (add to `timeline.spec.ts`):
  - `'Zoom changes the scale and is kept in the address'`: choose "Weeks"; URL has `zoom=weeks`; the "Launch site" bar is 1368 px wide (57 days at 24 px). Choose "Quarters": 114 px. Reload: "Quarters" is still chosen.
  - `'changing a filter keeps the zoom'`: with `zoom=weeks`, type in search; URL still has `zoom=weeks`.
  - `'the header shows the dates for the zoom'`: at Months the header contains "2027" and "Mar"; at Weeks "March 2027"; at Quarters "Q1".
  - `'the Timeline opens with today in view, and Today brings it back'`: the today line is inside the track's visible box on load; scroll the track to its far right, click "Today", and it is inside again.
  - `'Review focus 1: items in 1900 and 2200 give a track no wider than 24,000 px'`: seed both; the track's `scrollWidth` is at most 24,000 plus the name column; both rows have a bar at least 8 px wide.
  - `'FR-1.9: at 375 px the timeline scrolls sideways inside its frame and the page does not'`: `document.documentElement.scrollWidth` equals `clientWidth`; the track's `scrollWidth` is greater than its `clientWidth`; after scrolling the track right, the "Launch site" name is still visible.
  - `'the name column stays in place while the bars scroll'` at 1280 px.
  - `expectNoA11yViolations` at 375 px.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e timeline`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** The scroll container is focusable (`tabIndex={0}`) with the name "Schedule, scrolls sideways", so it can be scrolled from the keyboard.
- [ ] **Step 4: Run** `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Timeline zoom, Today and small screens (FR-1.7, FR-1.9)`.

---

### Task 6: Web: the Board (FR-1.7, FR-1.9)

**Files:**
- Create: `apps/web/src/projects/BoardView.tsx`, `BoardCard.tsx`, `apps/web/e2e/board.spec.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/projects/ProjectsPage.tsx`, `names.ts`, `names.test.ts`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2's `useItemActions`, `StatusMenu`; Task 3's `treeOrder`; Task 4's `ViewSwitcher`, `viewOptionsFromSearch`, `searchFor`; `filterProjects`, `PROJECT_STATUSES`.
- Produces: route `board/:projectId?` rendering `ProjectsPage` with `view="board"`; the switcher gets `views={['list', 'timeline', 'board']}`.
- Produces in `names.ts`: `levelPlural(depth: number): string` ("Projects", "Sub-projects", "Tasks", "Sub-tasks") and `itemCount(n: number): string` ("1 item", "3 items").
- Produces: a `SelectField` labelled "Level" in the toolbar when `view === 'board'`; changing it replaces the address with `level=` set.
- `BoardView` props: `role`, `myId`, `items` (every item of the roadmap), `filters` (with "me" already turned into the person's id), `level`, `byId`, `memberNames`, `selectedId`, `roadmapId`, `search`, `actions: ItemActions`. Cards are the items at `depth === level` that are not archived, or all at that depth with "Show archived"; while a search or filter narrows the list, only those in `filterProjects(...).matches`. Each column is a `section` named "{Status}, {itemCount}" holding a `ul` of cards sorted by `treeOrder`.
- `BoardCard` props: `item`, `parentTitle: string | undefined`, `assigneeNames: string[]`, `editable: boolean`, `selected: boolean`, `href: string`, `onOpen`, `onChangeStatus`, `menu: MenuItem[]`, `handle: ReactNode` (null in this task; Task 7 passes the drag handle).
- This task changes status through the card's `StatusMenu` only. Drag is Task 7.

- [ ] **Step 1: Write the failing unit tests** in `names.test.ts`: `levelPlural(1)` to `levelPlural(4)`; `itemCount(0)` is "0 items", `itemCount(1)` is "1 item".
- [ ] **Step 2: Write the failing E2E** `board.spec.ts`, with the Task 1 fixtures and `useCspGuard()`. Seed: projects "Launch site" (in progress, assigned to the owner, 3 Mar to 28 Apr 2027, label P1) and "Hire" (not started); under "Launch site" the sub-projects "Design" (done) and "Build" (not started).
  - `'FR-1.7: the Board has a column per status with its cards and counts'`: region "Not started, 1 item" contains "Hire"; "In progress, 1 item" contains "Launch site"; "Blocked, 0 items", "Done, 0 items" and "Cancelled, 0 items" each contain "No items".
  - `'a card shows assignees, dates and the priority label'`: the "Launch site" card contains the owner's name, "3 Mar to 28 Apr 2027" and "P1"; "Hire" contains "Unassigned" and "No dates".
  - `'Level shows another level, names each card's parent, and is kept in the address'`: choose "Sub-projects"; URL has `level=2`; "Done, 1 item" contains "Design" and "In Launch site"; reload keeps it. Choose "Tasks": "No tasks yet.".
  - `'cards are in the List's order'`: reorder "Hire" above another not-started project through `call`; the column lists them in that order.
  - `'the status menu on a card moves it to that column'`: choose "Blocked" on "Hire"; "Blocked, 1 item" contains "Hire".
  - `'choosing a card opens the panel, and the Actions menu archives and deletes'`.
  - `'filters apply and archived cards appear only with Show archived'`: `?status=done` at level 2 shows only "Design"; an archived card is absent, then present with "Archived" and no status menu when `archived=1`.
  - `'Review focus 4: a Contributor who is not assigned sees status as text and no Archive or Delete'`.
  - `'FR-1.9: at 375 px the columns scroll sideways inside the board and the page does not'`: the document does not scroll sideways; the board's `scrollWidth` exceeds its `clientWidth`; part of the second column is visible beside the first.
  - `expectNoA11yViolations` at 1280 px and at 375 px.
- [ ] **Step 3: Run** `pnpm --filter @roadmap/web test:e2e board`. Expected: FAIL.
- [ ] **Step 4: Implement.** From 900 px the five columns share the width equally; below that each column is 280 px with scroll snapping.
- [ ] **Step 5: Run** `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): Board view with a column per status (FR-1.7, FR-1.9)`.

---

### Task 7: Web: moving cards between columns (FR-1.7)

**Files:**
- Modify: `apps/web/src/projects/BoardView.tsx`, `BoardCard.tsx`, `apps/web/src/styles.css`, `apps/web/e2e/board.spec.ts`
- Test: `apps/web/src/projects/BoardView.test.tsx`

**Interfaces:**
- Consumes: `actions.changeStatus(item, status): Promise<boolean>` from Task 2; `@dnd-kit/core` (`DndContext`, `useDraggable`, `useDroppable`, `PointerSensor` with `distance: 5`, `TouchSensor` with `delay: 250, tolerance: 5`, `DragOverlay`).
- Each column is a droppable with the status as its id. A card is draggable by its handle only, and only when `editable` and not archived. The handle is a button named "Move {title}" described by "Drag this card to another column, or use its status menu."
- Produces in `BoardView.tsx`: `useBoardMoves(actions: Pick<ItemActions, 'changeStatus'>): { statusOf(item: Project): ProjectStatus; move(item: Project, status: ProjectStatus): void }`. `move` calls `changeStatus` and, until its promise settles, `statusOf` gives the target status; afterwards it gives `item.status` again, which by then is the saved one or the old one. The columns group cards by `statusOf`.
- Dropping on another column calls `move`. Dropping on the card's own column, or outside any column, does nothing.
- No keyboard sensor: the status menu is the keyboard path, and the handle's description says so.
- Announcements through dnd-kit's live region, placed in `document.body`: the four sentences in the UI/UX plan.

- [ ] **Step 1: Write the failing unit test** `BoardView.test.tsx`, with `renderHook` on `useBoardMoves` and a `changeStatus` whose promise the test settles:
  - `'a card shows in the target column while its move is being saved'`: after `move(hire, 'done')`, `statusOf(hire)` is `'done'` and `changeStatus` was called once with `(hire, 'done')`.
  - `'the card goes back when the save is refused'`: resolve the promise with `false`; `statusOf(hire)` is `'not_started'`.
  - `'a move to the status the card already has does nothing'`: `changeStatus` is not called.
- [ ] **Step 2: Write the failing E2E** (add to `board.spec.ts`; drags use `page.mouse` with intermediate moves, as `project-order.spec.ts` does):
  - `'FR-1.7: dragging a card to another column changes its status, and it is still there after a reload'`: drag "Hire" by "Move Hire" onto "Done"; "Done, 1 item" contains "Hire"; reload; still there.
  - `'dropping a card on its own column or outside the board changes nothing'`: no request to the projects route is sent (count with `page.on('request')`).
  - `'Review focus 3: a move that conflicts puts the card back and says why'`: change "Hire" through `call` so the page's copy is stale, then drag it to "Done"; expect the existing conflict message, and "Hire" in the column its new server status says.
  - `'Review focus 4: a Contributor whose assignment was just removed gets the read-only message and the card goes back'`: a contributor assigned to "Hire" opens the Board; the owner unassigns them through `call`; the contributor drags "Hire" to "Done"; expect "Only people assigned to this item, Owners and Admins can change it." and "Hire" under "Not started".
  - `'Review focus 5: moving the card of the open item updates the panel's Status, and Save then works'`: open "Hire", type a new title, drag its card to "In progress"; the panel's Status reads "In progress"; Save shows "Saved." and the title is kept.
  - `'cards that may not be moved have no handle'`: an archived card (with `archived=1`) and, for a Contributor, an unassigned item's card.
  - `'FR-1.9: a card can be moved by touch at 375 px'` (mobile project): long-press the handle, move to the next column, release; the status changed.
  - `'screen readers are told what happened'`: after a drag, the live region contains "Moved Hire to Done.".
  - `expectNoA11yViolations` with a card picked up.
- [ ] **Step 3: Run** `pnpm --filter @roadmap/web test:e2e board`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm lint`, `pnpm typecheck`, `pnpm run test --coverage` and `pnpm test:e2e` with `TEST_MONGO=container`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): move Board cards between columns (FR-1.7)`.

---

## Next plans (v1)

1. Notes, @mentions and attachments (FR-1.5 and the attachments part of FR-1.4), which needs S3.
2. Snapshots and PDF (FR-3), which reuses `packages/shared/src/timeline.ts`.
3. Calendar feed, notifications, POC infrastructure and release hardening, as listed in the Foundation plan.

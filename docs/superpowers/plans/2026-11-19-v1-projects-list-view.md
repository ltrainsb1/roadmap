# v1 Projects and List View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins build and maintain a roadmap of projects nested up to 4 levels, with status, dates, milestones, tags, links, "blocked by" dependencies, assignees and an official priority order, and every member works with it in a filterable List/tree view.

**Architecture:** One `projects` collection holds every level, each document carrying `parentId`, `depth` and `path` (its ancestor ids). Routes under `/api/roadmaps/:roadmapId/projects` use the existing auth hook; the Contributor "only assigned items" rule is a `ctx` function that reads the item's ancestor chain. The web app loads a roadmap's whole project list once and builds the tree, the warnings and the filters with pure functions in `packages/shared`, so the later Timeline and Board views reuse them.

**Tech Stack:** As the Foundation plan (Fastify 5, zod, MongoDB through `scoped()`, React 19, TanStack Query, Vitest, Playwright, axe). One new dependency: `@dnd-kit/core` and `@dnd-kit/sortable` for reordering by pointer, touch and keyboard.

**Spec:** `docs/prd.md`. Sections this plan implements: Data model (Project and Milestone entities, the Rules list), FR-1.2, FR-1.3, FR-1.4 (all but attachments), FR-1.6, FR-1.7 (List/tree view only), FR-1.8, FR-1.9, the "Create, edit or delete projects", "Set the official priority" and "Assign users" rows of the Permissions table, and the Audit log requirement to record every create, update and delete.

**Builds on:** branch `v1-foundation` (PR `ltrainsb1/roadmap#1`). Start branch `v1-projects` from it, or from `main` once that PR is merged. Decisions from the Foundation work are in `docs/superpowers/plans/2026-11-18-v1-foundation-followups.md`.

**Not in this plan:** Timeline and Board views (next plan). Notes, @mentions and attachments (the plan after). Vote counts (v2). Moving an item to a different parent.

## Global Constraints

Every constraint in the Foundation plan's Global Constraints section still binds (`docs/superpowers/plans/2026-11-18-v1-foundation.md`). The ones this plan leans on, and the new ones:

- Only `apps/api/src/db/**` imports `mongodb`. Every query goes through `scoped()`. Every new index starts with `tenantId`.
- Authorization lives in `packages/shared/src/policy.ts` and the auth hook. Route handlers never compare roles. Every route sets `config.auth`.
- Request validation uses zod schemas from `packages/shared/src/projects.ts`. Errors are `{ "error": "<snake_case_code>" }`.
- Every create, update and delete of a project writes an audit event with the roadmap id. `before` and `after` carry the item's `title`, so the audit log can name an item after it is deleted.
- Definition of done for every task: unit and functional tests, permission tests for each role touched plus a cross-tenant check, coverage at 80% or more in every package (run `pnpm run test --coverage` from the repo root, as CI does), axe passes on new screens, every screen works from 375 px wide, and the FR id appears in the test name.
- All tests run as GitHub Actions. New E2E specs run in the existing `e2e` job. Check the CI result after every push.
- Docker runs on the devbox through the SSH tunnel; run the API and E2E suites once per task with `TEST_MONGO=container`.
- On-screen copy follows the `mobbin:plain-writing` rules and the exact text in the UI/UX plan section below. E2E tests assert that text word for word.
- **Plan decisions where the PRD is silent** (change them here and every task follows):
  - Levels are named Project (depth 1), Sub-project (2), Task (3), Sub-task (4). The app calls any of them an "item" when the level doesn't matter.
  - Dates are calendar dates stored as `YYYY-MM-DD` strings with no time or zone. An end date before the start date is refused. A child outside its parent's dates, or an item that starts before something it is blocked by ends, produces a warning and is still saved.
  - Official priority is the order of items under one parent, stored as an integer `rank` starting at 0. A reorder sends the full ordered list of sibling ids. The P1 to P4 label is a separate optional field.
  - New items go last among their siblings.
  - Milestones are stored inside their item, each with its own id, not in a separate collection.
  - A Contributor may create under, edit, archive and delete any item they are assigned to or that sits under an item they are assigned to. They may not create top-level projects, change order or labels, or change assignees.
  - Assignees must be members of the roadmap. Removing a member from a roadmap removes them from every item's assignees there.
  - Archive hides an item and everything under it and can be undone. Delete removes an item and everything under it for good. Deleting a roadmap deletes its projects.
  - Deleting an item removes it from every other item's "blocked by" list.
  - "Blocked by" may name any item in the same roadmap except itself, its own ancestors and descendants, and anything that would make a cycle. At most 20 per item.
  - Limits: title 1 to 200 characters; description up to 5,000 characters of plain text; 10 tags of 1 to 30 characters, stored trimmed and lower case; 10 links, `http` or `https` only, label up to 80 characters; 20 milestones, name 1 to 80 characters; 2,000 items per roadmap.
  - Edits carry the `version` the client last saw. A stale version is refused with `409 conflict`, never silently overwritten.
  - The list endpoint returns every item in the roadmap in one response. Filtering and search happen in the browser.
  - Filters live in the URL query string, so a filtered view can be bookmarked and shared.

## Review Focus

1. **Two people edit the same item.** The second save must get `409 conflict` and change nothing. Tests in Task 4 and Task 10.
2. **Deleting or archiving an item that has children or that others are blocked by.** Everything under it goes with it, and no "blocked by" list is left pointing at a deleted item. Tests in Task 8.
3. **An assignee who stops being a member.** Removing them from the roadmap clears them from every item, and assigning a non-member is refused. Tests in Task 6.
4. **Bad dates.** `2026-02-30`, an end before the start, and a child outside its parent's dates each behave as the decisions above say: refused, refused, saved with a warning. Tests in Task 1, Task 2 and Task 4.
5. **Reordering against a stale list.** If a sibling was added or removed since the page loaded, the reorder is refused with `409 order_stale` and the stored order is unchanged. Tests in Task 7 and Task 11.

---

## File Structure

```
packages/shared/src/
  projects.ts            statuses, level names, limits, zod schemas and types for every project request and response
  project-rules.ts       pure functions: isCalendarDate, projectWarnings, wouldCycle, buildTree, filterProjects
packages/shared/test/    projects.test.ts, project-rules.test.ts
apps/api/src/projects/
  access.ts              loadProject, assignedCtx, parentAssignedCtx, toProjectDto
  routes.ts              create, list, update
  assign-routes.ts       set assignees
  priority-routes.ts     reorder siblings, set priority label
  lifecycle-routes.ts    archive, unarchive, delete
apps/api/test/projects/  one test file per route file, plus access.test.ts
apps/web/src/projects/
  useProjects.ts         queries and mutations
  ProjectsPage.tsx       toolbar, tree, panel outlet
  ProjectTree.tsx        the nested table and its rows
  AddItemRow.tsx         inline "add" row
  ProjectPanel.tsx       detail panel: core fields and Save
  PanelLists.tsx         assignees, tags, links, milestones, blocked by
  FiltersPanel.tsx       filter controls
  filters.ts             filters to and from the URL query string
  names.ts               status names, level names, warning sentences
apps/web/e2e/            projects.spec.ts, project-panel.spec.ts, project-order.spec.ts, project-filters.spec.ts
```

---

## UI/UX plan

This section and all on-screen copy follow the `mobbin:plain-writing` rules. The Foundation plan's layout rules still apply: one primary button per screen, 44 px controls, labels above fields, field errors under the field, a red button and a confirm dialog for anything destructive.

I looked at 18 web screens on Mobbin for nested task lists, filter bars and task detail panels. The choices below name the screens they follow. Where no reference is named, the choice is my opinion.

**The list**

The Projects tab shows one table. Each row is an item; children sit indented under their parent with a chevron to collapse them.
References: [Asana](https://mobbin.com/screens/b19c3efa-47d4-469c-8185-66263e3d8714?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Wrike](https://mobbin.com/screens/440921b1-4f8b-45d2-896a-da2e803e3565?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Columns are Name, Status, Assignees, Dates and Priority, in that order.
References: [Asana](https://mobbin.com/screens/b19c3efa-47d4-469c-8185-66263e3d8714?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [ClickUp](https://mobbin.com/screens/3a2c1ba3-57b4-4e04-8227-ff96c09d8153?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Status is a pill in the row that opens a menu of the five statuses and saves on choice.
References: [Qatalog](https://mobbin.com/screens/7c52b06d-ef8a-463f-825c-64dcc5551e7b?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

A new item is typed into a row in place, and Enter saves it.
References: [Asana](https://mobbin.com/screens/b19c3efa-47d4-469c-8185-66263e3d8714?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Qatalog](https://mobbin.com/screens/7c52b06d-ef8a-463f-825c-64dcc5551e7b?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).
My opinion is to make this the one exception to "labels above fields": the input has an accessible name and a visible hint, "Press Enter to save".

The Priority column shows the item's place among its siblings as a number, then the P label if it has one. My opinion is to show the number because the PRD's official priority is an order, and the references show only a label.

**The detail panel**

Choosing a row opens a panel at the right of the list. The list stays visible beside it.
References: [Asana](https://mobbin.com/screens/7bb086b8-b6de-4599-b2b1-6dce1283bf30?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Wrike](https://mobbin.com/screens/440921b1-4f8b-45d2-896a-da2e803e3565?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

Below 900 px the panel covers the screen and has a "Back to projects" link. My opinion; the references are desktop screens.

The panel stacks its fields in one column, each with its label.
References: [Qatalog](https://mobbin.com/screens/47e0f359-f8e2-48b0-be10-ca41228bf5f9?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [ClickUp](https://mobbin.com/screens/36758b9b-f6a3-4a8b-b4d2-91c373742924?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Programa](https://mobbin.com/screens/57b40a28-dc4b-4eb7-9f31-c51278809587?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

"Blocked by" is a field in the panel, next to the other fields.
References: [Qatalog](https://mobbin.com/screens/47e0f359-f8e2-48b0-be10-ca41228bf5f9?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Asana](https://mobbin.com/screens/7bb086b8-b6de-4599-b2b1-6dce1283bf30?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

The panel has one "Save" button for its text, date and list fields. My opinion is to save on a button here, not field by field, so a stale-version conflict has one clear place to appear.

**Filters and search**

A "Filters" button sits in the toolbar beside the search field and shows how many filters are on. It opens a panel with one control per field and a "Clear filters" button.
References: [Slack](https://mobbin.com/screens/d769f2d8-7730-46c9-b8b1-129d7edbc96e?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Relevance AI](https://mobbin.com/screens/7690aff3-4875-4930-9b99-52e52a7f0b07?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp), [Asana](https://mobbin.com/screens/b19c3efa-47d4-469c-8185-66263e3d8714?utm_source=claude-code&utm_medium=ai-assistant&utm_source_platform=mcp).

A filtered tree shows each matching item and its ancestors, with ancestors that don't match greyed. My opinion; none of the references filters a nested list.

**Reordering**

Each row has a drag handle for people who may set priority. The row menu also has "Move up" and "Move down", so the order can be changed without dragging. My opinion; the references don't show reordering.

**Small screens**

At 375 px the table shows Name and Status only. Assignees, dates and priority are in the panel. Indentation is 16 px a level, so a Sub-task's title still has room. My opinion.

**Screens and copy**

| Where | On it | Messages |
| --- | --- | --- |
| Tab | "Projects", first in the roadmap tabs. Opening a roadmap lands here. | |
| Projects page (`/r/:roadmapId/projects`) | Heading "Projects". Search field "Search projects". Button "Filters", or "Filters (2)" when two are on. Primary button "New project". Column headings "Name", "Status", "Assignees", "Dates", "Priority". | Empty, for Owners and Admins: "No projects yet." Empty, for Contributors: "No projects yet. An Admin adds the first one." No match: "No projects match these filters." with button "Clear filters". |
| Row | Chevron named "Collapse {title}" or "Expand {title}". Title, which opens the panel. Status pill. Assignee names, or "Unassigned". Dates as "3 Mar to 28 Apr 2027", "From 3 Mar 2027", "Until 28 Apr 2027" or "No dates". Priority as "2" or "2 · P1". Warning icon named "Has warnings". Drag handle named "Reorder {title}". Menu button named "Actions for {title}". | Archived items, when shown, carry the word "Archived". |
| Row menu | "Open", then "Add sub-project", "Add task" or "Add sub-task" by level (none on a Sub-task), "Move up", "Move down", "Archive" or "Unarchive", "Delete". | |
| Add row | Input named "Title of the new project" (or sub-project, task, sub-task). Hint "Press Enter to save". Escape cancels. | Empty: "Enter a title." |
| Statuses | "Not started", "In progress", "Blocked", "Done", "Cancelled". | |
| Panel (`/r/:roadmapId/projects/:projectId`) | Level and position as "Sub-project in {parent title}", or "Project". Fields "Title", "Description", "Status", "Start date", "End date", "Priority label" (None, P1, P2, P3, P4), "Assignees", "Tags", "Links", "Milestones", "Blocked by". Primary button "Save". Button "Close". Below 900 px, link "Back to projects". | After saving: "Saved." Warnings: "Dates fall outside {parent title}'s dates." and "Starts before {blocker title} ends." Read-only, for a Contributor not assigned: "Only people assigned to this item, Owners and Admins can change it." |
| Panel lists | Assignees: a checkbox per member. Tags: field "Add a tag", button "Add", each tag with a button named "Remove tag {tag}". Links: fields "Label" and "Address", button "Add link". Milestones: fields "Name" and "Date", button "Add milestone". Blocked by: a select "Add an item this is blocked by", each entry with a button named "Remove {title}". | "Enter a tag." "Enter an address that starts with http:// or https://." "Enter a name and a date." |
| Filters panel | Heading "Filters". Groups "Status" (a checkbox per status), "Assignee" (a checkbox per member, with "Assigned to me" first), "Tag" (a checkbox per tag in use), "Priority label" (P1 to P4 and "None"). Fields "From" and "To". Checkbox "Show archived". Buttons "Clear filters" and "Done". | |
| Delete dialog | "Delete {title}? This also deletes the {n} items under it. This can't be undone." With nothing under it: "Delete {title}? This can't be undone." Buttons "Delete" (red) and "Cancel". | |
| Archive | No dialog, because it can be undone. | Notice: "Archived {title}." |
| Errors | | `too_deep`: "A sub-task can't have items under it." `date_order`: "The end date is before the start date." `dependency_cycle`: "These items would end up blocked by each other." `order_stale`: "The list changed while you were reordering. Try again." `parent_archived`: "Unarchive the item above this one first." `too_many_items`: "This roadmap has reached 2,000 items." `conflict` and `not_a_member` keep their existing copy. |
| Audit log | New sentences: "{A} added {title}." "{A} changed {title}." "{A} deleted {title}." "{A} archived {title}." "{A} unarchived {title}." "{A} changed who is assigned to {title}." "{A} reordered the items under {parent title}." "{A} reordered the projects." "{A} set the priority label of {title} to P1." "{A} removed the priority label of {title}." | |

One element keeps one name everywhere: "item" for any level, "priority" for the order, "priority label" for P1 to P4, "blocked by", "archive" and "unarchive".

---

### Task 1: Shared project schemas and constants

**Files:**
- Create: `packages/shared/src/projects.ts`, `packages/shared/test/projects.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/schemas.ts` (`AUDIT_ACTIONS`)

**Interfaces:**
- Produces:
  ```ts
  export const PROJECT_STATUSES = ['not_started', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
  export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
  export const PRIORITY_LABELS = ['P1', 'P2', 'P3', 'P4'] as const;
  export type PriorityLabel = (typeof PRIORITY_LABELS)[number];
  export const MAX_DEPTH = 4;
  export const LIMITS = { title: 200, description: 5000, tags: 10, tagLength: 30, links: 10, linkLabel: 80, milestones: 20, milestoneName: 80, blockedBy: 20, itemsPerRoadmap: 2000 } as const;

  export const calendarDateSchema: z.ZodType<string>;        // 'YYYY-MM-DD' that is a real date
  export const tagSchema: z.ZodType<string>;                 // trim, lower case, 1..30
  export const linkSchema = z.object({ id: z.string(), label: z.string().trim().max(80), url: /* http(s) only */ });
  export const milestoneSchema = z.object({ id: z.string(), name: z.string().trim().min(1).max(80), date: calendarDateSchema });

  export const projectSchema = z.object({
    id: z.string(), parentId: z.string().nullable(), depth: z.number().int().min(1).max(4), path: z.array(z.string()),
    title: z.string(), description: z.string(), status: z.enum(PROJECT_STATUSES),
    startDate: calendarDateSchema.nullable(), endDate: calendarDateSchema.nullable(),
    milestones: z.array(milestoneSchema), tags: z.array(z.string()), links: z.array(linkSchema),
    blockedBy: z.array(z.string()), assigneeIds: z.array(z.string()),
    rank: z.number().int(), priorityLabel: z.enum(PRIORITY_LABELS).nullable(),
    archived: z.boolean(), version: z.number().int(), updatedAt: z.string(),
  });
  export type Project = z.infer<typeof projectSchema>;
  export const projectListSchema = z.object({ items: z.array(projectSchema) });

  export const createProjectRequestSchema = z.object({ parentId: z.string().nullable(), title: z.string().trim().min(1).max(200) });
  export const updateProjectRequestSchema;   // { version } plus optional title, description, status, startDate, endDate, milestones, tags, links, blockedBy; links and milestones may omit `id` for new entries
  export const setAssigneesRequestSchema = z.object({ userIds: z.array(z.string()).max(50) });
  export const reorderRequestSchema = z.object({ parentId: z.string().nullable(), orderedIds: z.array(z.string()).min(1).max(2000) });
  export const priorityLabelRequestSchema = z.object({ label: z.enum(PRIORITY_LABELS).nullable() });
  ```
- Produces in `AUDIT_ACTIONS`: `'project.create'`, `'project.update'`, `'project.delete'`, `'project.archive'`, `'project.unarchive'`, `'project.assign'`, `'project.reorder'`, `'project.priority_label'`.

- [ ] **Step 1: Write the failing tests** in `projects.test.ts`:
  - `'Review focus 4: calendarDateSchema accepts 2027-02-28 and rejects 2027-02-30, 2027-13-01, 27-02-28 and a date with a time'`.
  - `'tagSchema trims and lower-cases, and rejects an empty tag and a 31-character tag'`.
  - `'linkSchema accepts http and https and rejects javascript:, data: and a bare host'`.
  - `'updateProjectRequestSchema requires version and rejects an end date before the start date with date_order'` (the issue message is `date_order`; the rule applies only when both dates are in the request).
  - `'updateProjectRequestSchema rejects 11 tags, 11 links, 21 milestones and 21 blockedBy entries'`.
  - `'createProjectRequestSchema trims the title and rejects an empty or 201-character title'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test projects`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `projects.ts`** and export it from the index. Duplicate tags in one request are removed after normalising.
- [ ] **Step 4: Run** `pnpm --filter @roadmap/shared run test --coverage`. Expected: PASS with thresholds met.
- [ ] **Step 5: Commit** `feat(shared): project schemas and constants`.

---

### Task 2: Shared project rules (pure functions)

**Files:**
- Create: `packages/shared/src/project-rules.ts`, `packages/shared/test/project-rules.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectStatus`, `PriorityLabel` from Task 1.
- Produces:
  ```ts
  export type ProjectWarning =
    | { kind: 'outside_parent'; parentId: string }
    | { kind: 'blocked_by_later'; blockerId: string };
  /** Warnings for one item, given the whole roadmap's items by id. */
  export function projectWarnings(item: Project, byId: ReadonlyMap<string, Project>): ProjectWarning[];
  /** True if making `itemId` blocked by `blockerIds` would create a cycle, or names itself, an ancestor or a descendant. */
  export function wouldCycle(itemId: string, blockerIds: readonly string[], byId: ReadonlyMap<string, Project>): boolean;
  export interface TreeNode { item: Project; children: TreeNode[]; position: number /* 1-based place among siblings shown */ }
  /** Roots first, children nested, each level sorted by rank then id. Items whose parent is missing are dropped. */
  export function buildTree(items: readonly Project[]): TreeNode[];
  export interface ProjectFilters {
    text: string; statuses: ProjectStatus[]; assigneeIds: string[]; tags: string[];
    labels: Array<PriorityLabel | 'none'>; from: string | null; to: string | null; showArchived: boolean;
  }
  export const NO_FILTERS: ProjectFilters;
  export function activeFilterCount(f: ProjectFilters): number;   // showArchived and text do not count
  /** Ids that match, and ids to show only as context (ancestors of a match). */
  export function filterProjects(items: readonly Project[], f: ProjectFilters): { matches: Set<string>; context: Set<string> };
  ```
- Rules the tests pin:
  - `outside_parent`: the parent has at least one date, and the child's start is before the parent's start or the child's end is after the parent's end. A missing date on either side of a comparison makes no warning.
  - `blocked_by_later`: the item has a start date, the blocker has an end date, and the start is before or equal to the end. Archived or missing blockers make no warning.
  - Filters combine with AND across fields and OR within a field. Text matches title, description and tags, ignoring case. The date range matches an item whose dates overlap it; an item with no dates matches only when no range is set. With `showArchived` false, archived items never match.

- [ ] **Step 1: Write the failing tests** in `project-rules.test.ts`, each named for its rule:
  - `'Review focus 4: a child outside its parent's dates gets outside_parent; inside, or with dates missing, gets none'`.
  - `'blocked_by_later when an item starts on or before its blocker ends'`.
  - `'wouldCycle: itself, an ancestor, a descendant, a direct cycle and a three-step cycle are all true; an unrelated item is false'`.
  - `'buildTree nests four levels, sorts by rank, numbers positions from 1 and drops orphans'`.
  - `'FR-1.8 filterProjects: status, assignee, tag, label (including none), date overlap and text, alone and combined'`.
  - `'filterProjects returns the ancestors of a match as context and never as matches'`.
  - `'activeFilterCount counts each filtered field once and ignores text and showArchived'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/shared test project-rules`. Expected: FAIL.
- [ ] **Step 3: Implement.** `wouldCycle` walks `blockedBy` edges from each proposed blocker with a visited set.
- [ ] **Step 4: Run** `pnpm --filter @roadmap/shared run test --coverage`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): project warnings, cycle check, tree and filters`.

---

### Task 3: API data model, access rules, create and list (FR-1.2)

**Files:**
- Create: `apps/api/src/projects/access.ts`, `apps/api/src/projects/routes.ts`, `apps/api/test/projects/access.test.ts`, `apps/api/test/projects/projects.test.ts`
- Modify: `apps/api/src/db/types.ts`, `apps/api/src/db/scoped.ts` (collection name `projects`), `apps/api/src/db/indexes.ts`, `apps/api/src/app.ts`, `apps/api/test/helpers.ts` (`seed.project`)

**Interfaces:**
- Produces: `ProjectDoc = { _id, tenantId, roadmapId, parentId: string | null, depth: 1 | 2 | 3 | 4, path: string[], title, description, status: ProjectStatus, startDate: string | null, endDate: string | null, milestones: { id, name, date }[], tags: string[], links: { id, label, url }[], blockedBy: string[], assigneeIds: string[], rank: number, priorityLabel: PriorityLabel | null, archived: boolean, version: number, createdBy: string, createdAt: Date, updatedAt: Date }`.
- Produces indexes: `{ tenantId: 1, roadmapId: 1, parentId: 1, rank: 1 }`, `{ tenantId: 1, roadmapId: 1, path: 1 }`.
- Produces in `access.ts`:
  ```ts
  /** The item in this roadmap, or 404 not_found. Never returns another roadmap's or tenant's item. */
  export async function loadProject(db: ScopedDb, roadmapId: string, projectId: string): Promise<ProjectDoc>;
  /** True if the user is an assignee of the item or of any ancestor. */
  export async function isAssignedTo(db: ScopedDb, item: ProjectDoc, userId: string): Promise<boolean>;
  /** ctx for routes with :projectId. */
  export function assignedCtx(req: FastifyRequest): Promise<PolicyContext>;        // { isAssigned }
  /** ctx for create: assignment on the body's parentId chain; a null parentId gives { isAssigned: false }. */
  export function parentAssignedCtx(req: FastifyRequest): Promise<PolicyContext>;
  export function toProjectDto(doc: ProjectDoc): Project;
  ```
- Produces: `seed.project(tenantId, roadmapId, o?: { parentId?: string; title?: string; assigneeIds?: string[]; status?: ProjectStatus; startDate?: string; endDate?: string; archived?: boolean }): Promise<ProjectDoc>`. It computes `depth`, `path` and `rank` the same way the route does.
- Produces: `registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void` with `ProjectRouteDeps = { now: () => Date; maxItems: number }`. `AppDeps` gains `maxProjectItems?: number`, defaulting to `LIMITS.itemsPerRoadmap`, and `makeTestApp` passes it through. The later route files in this folder take the same `ProjectRouteDeps`.
- Produces routes:
  - `POST /api/roadmaps/:roadmapId/projects` with `createProjectRequestSchema` (`project.create`, `ctx: parentAssignedCtx`). The parent must exist in this roadmap (`404 not_found`), must not be archived (`409 parent_archived`), and must be at depth 3 or less (`422 too_deep`). A roadmap already holding `deps.maxItems` items refuses with `422 too_many_items`. The new item gets `depth`, `path`, `rank` = one more than the highest sibling rank, `status: 'not_started'`, `version: 1`. Returns `201 { id }`. Audit: `project.create` with `after: { title, parentId }`.
  - `GET /api/roadmaps/:roadmapId/projects` (`roadmap.view`) returns `projectListSchema`: every item in the roadmap, archived ones included.

- [ ] **Step 1: Write the failing tests.**
  - `access.test.ts`: `loadProject` returns 404 for another roadmap's item and another tenant's item; `isAssignedTo` is true for a direct assignee, true for an assignee of a grandparent, false for an assignee of a sibling or a child.
  - `projects.test.ts`:
    - `'FR-1.2: an Admin creates a project, a sub-project, a task and a sub-task, and the list returns all four with depth and path'`.
    - `'FR-1.2: the API rejects a fifth level with 422 too_deep'`.
    - `'new items go last among their siblings'` (ranks 0, 1, 2 under one parent).
    - `'Permissions (project.create)'`, table-driven: Owner and Admin may create anywhere; a Contributor gets 403 for a top-level project, 403 under an item they are not assigned to, 201 under an item they are assigned to, and 201 under a child of an item they are assigned to.
    - `'creating under an archived parent returns 409 parent_archived'`.
    - `'an item past the roadmap's limit returns 422 too_many_items'` (build the test app with `maxProjectItems: 3`).
    - `'Tenant isolation: tenant B gets 404 listing or creating in tenant A's roadmap, and a parentId from another roadmap is 404'`.
    - `'project.create is audited with the title'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test projects access`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create runs in one transaction: read the parent, count the roadmap's items, read the highest sibling rank, insert.
- [ ] **Step 4: Run** the full API suite with coverage, then once with `TEST_MONGO=container`. Expected: PASS. The OpenAPI test must list the two new routes without a change to it.
- [ ] **Step 5: Commit** `feat(api): projects collection, create and list (FR-1.2)`.

---

### Task 4: API update with versions, dates, milestones, tags and links (FR-1.4)

**Files:**
- Modify: `apps/api/src/projects/routes.ts`
- Test: `apps/api/test/projects/update.test.ts`

**Interfaces:**
- Consumes: `updateProjectRequestSchema`, `assignedCtx`, `loadProject`.
- Produces: `PATCH /api/roadmaps/:roadmapId/projects/:projectId` (`project.edit`, `ctx: assignedCtx`). It applies only the fields present. It writes with a filter on `{ _id, version }` and sets `version: version + 1` and `updatedAt`; no match gives `409 conflict`. New links and milestones get ids (UUID v7). If the request carries only one of the two dates, the other comes from the stored item, and an end before the start gives `422 date_order`. Returns `200` with the updated `projectSchema`. Audit: `project.update` with `before` and `after` holding `title` and only the fields that changed. A request that changes nothing returns the item and writes no audit event. This task applies every field except `blockedBy`. A request that carries `blockedBy` returns `422 not_supported` until Task 5 replaces that branch, so the field is never silently dropped.

- [ ] **Step 1: Write the failing tests** in `update.test.ts`:
  - `'FR-1.4: an Admin sets title, description, status, dates, tags, links and milestones, and the list returns them'`.
  - `'Review focus 1: a stale version returns 409 conflict and the stored item is unchanged'`, and `'two concurrent PATCHes with the same version: exactly one returns 200'` (`Promise.all`).
  - `'Review focus 4: an end date before the stored start date returns 422 date_order'`, and the same with both dates in the request.
  - `'a child outside its parent's dates is saved'` (the warning itself is Task 2's; here assert 200).
  - `'tags are stored trimmed, lower case and without duplicates'`.
  - `'a link with a javascript: address returns 400'`.
  - `'Permissions (project.edit)'`, table-driven: Owner and Admin 200; Contributor 403 when not assigned, 200 when assigned to the item, 200 when assigned to its parent.
  - `'a Contributor cannot change rank, priorityLabel or assigneeIds through PATCH'` (the schema strips unknown keys; assert the stored values are unchanged).
  - `'Tenant isolation: another tenant, and another roadmap in the same tenant, get 404'`.
  - `'project.update is audited with before and after, and an unchanged PATCH writes nothing'`.
  - `'a request carrying blockedBy returns 422 not_supported'` (Task 5 deletes this test).
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test update`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full API suite with coverage. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): edit projects with version checks (FR-1.4)`.

---

### Task 5: API "blocked by" dependencies (FR-1.4)

**Files:**
- Modify: `apps/api/src/projects/routes.ts`
- Test: `apps/api/test/projects/dependencies.test.ts`

**Interfaces:**
- Consumes: `wouldCycle` from Task 2, the PATCH route from Task 4.
- Produces: `blockedBy` handling in the PATCH route, replacing the `422 not_supported` branch and its test from Task 4. Every id must be an item in the same roadmap (`422 unknown_item` otherwise). `wouldCycle` true gives `422 dependency_cycle`. The check and the write happen in one transaction that reads the roadmap's items, so two requests cannot create a cycle between them.

- [ ] **Step 1: Write the failing tests** in `dependencies.test.ts`:
  - `'FR-1.4: an item can be blocked by two other items in the same roadmap'`.
  - `'blocked by itself, by its parent and by its child each return 422 dependency_cycle'`.
  - `'A blocked by B, then B blocked by A returns 422 dependency_cycle'`, and a three-item cycle.
  - `'two concurrent requests that would form a cycle together: exactly one succeeds'`.
  - `'an id from another roadmap or tenant returns 422 unknown_item'`.
  - `'21 blockers return 400'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test dependencies`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full API suite with coverage. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): blocked-by dependencies with cycle checks (FR-1.4)`.

---

### Task 6: API assignees and membership cleanup (FR-1.6)

**Files:**
- Create: `apps/api/src/projects/assign-routes.ts`, `apps/api/test/projects/assignees.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/members/routes.ts` (member removal, roadmap deletion)

**Interfaces:**
- Produces: `PUT /api/roadmaps/:roadmapId/projects/:projectId/assignees` with `setAssigneesRequestSchema` (`project.assign`). Every user id must have a membership in this roadmap (`422 not_a_member`). Duplicates are removed. It bumps `version`. Returns `200` with the updated item. Audit: `project.assign` with `before` and `after` holding `title` and `assigneeIds`.
- Produces in `members/routes.ts`: removing a member pulls their id from `assigneeIds` of every item in that roadmap, inside the removal's transaction. Deleting a roadmap deletes its `projects` documents, inside the deletion's transaction.

- [ ] **Step 1: Write the failing tests** in `assignees.test.ts`:
  - `'FR-1.6: an Admin assigns two members to a task, and assigns a member at each of the four levels'`.
  - `'Permissions (project.assign)'`: Owner and Admin 200; a Contributor gets 403 even on an item they are assigned to.
  - `'Review focus 3: assigning someone who is not a member of the roadmap returns 422 not_a_member'`, including a member of another roadmap in the same tenant.
  - `'Review focus 3: removing a member clears them from every item in that roadmap and leaves their assignments in other roadmaps'`.
  - `'after being unassigned, a Contributor can no longer edit the item'` (PATCH returns 403).
  - `'deleting a roadmap deletes its projects and leaves another roadmap's projects'`.
  - `'Tenant isolation: another tenant gets 404'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test assignees members`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full API suite with coverage. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): project assignees and membership cleanup (FR-1.6)`.

---

### Task 7: API official priority: order and label (FR-1.3)

**Files:**
- Create: `apps/api/src/projects/priority-routes.ts`, `apps/api/test/projects/priority.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces:
  - `PUT /api/roadmaps/:roadmapId/projects/order` with `reorderRequestSchema` (`project.setPriority`). In one transaction it reads the non-archived items whose `parentId` is the given one. If `orderedIds` is not exactly that set, it returns `409 order_stale`. Otherwise it sets each item's `rank` to its index. It does not bump `version`. Returns `204`. Audit: `project.reorder` with `target` the parent (or the roadmap for top level) and `after: { parentTitle, orderedIds }`.
  - `PUT /api/roadmaps/:roadmapId/projects/:projectId/priority-label` with `priorityLabelRequestSchema` (`project.setPriority`). Bumps `version`. Returns `200` with the updated item. Audit: `project.priority_label` with `before` and `after` holding `title` and `priorityLabel`.
- Register `/projects/order` so it is not captured by `/projects/:projectId`.

- [ ] **Step 1: Write the failing tests** in `priority.test.ts`:
  - `'FR-1.3: an Admin reorders three sub-projects and the list returns the new ranks'`.
  - `'reordering top-level projects uses parentId null'`.
  - `'Review focus 5: a list missing a sibling, with an extra id, or with a duplicate returns 409 order_stale and the ranks are unchanged'`.
  - `'two concurrent reorders of the same siblings leave one consistent order'` (ranks are 0..n-1 with no gaps or repeats).
  - `'archived siblings are not part of the order'`.
  - `'Permissions (project.setPriority)'`: Owner and Admin succeed on both routes; a Contributor gets 403 on both, even when assigned.
  - `'the priority label can be set to P1 and cleared with null'`.
  - `'Tenant isolation: another tenant gets 404 on both routes'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test priority`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full API suite with coverage. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): official priority order and label (FR-1.3)`.

---

### Task 8: API archive, unarchive and delete (FR-1.2)

**Files:**
- Create: `apps/api/src/projects/lifecycle-routes.ts`, `apps/api/test/projects/lifecycle.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces (all `project.delete`, `ctx: assignedCtx`, each in one transaction):
  - `POST /api/roadmaps/:roadmapId/projects/:projectId/archive` sets `archived: true` on the item and on every item whose `path` contains it. Returns `204`. Audit: `project.archive` with `after: { title, count }`.
  - `POST .../unarchive` clears it on the item and everything under it. If the item's parent is archived it returns `409 parent_archived`. The item goes last among its siblings. Returns `204`. Audit: `project.unarchive`.
  - `DELETE /api/roadmaps/:roadmapId/projects/:projectId` deletes the item and everything under it, and pulls every deleted id from the `blockedBy` of the roadmap's other items. Returns `200 { deleted: number }`. Audit: `project.delete` with `before: { title, count }`.
- After an archive or delete, the remaining siblings' ranks are rewritten to 0..n-1.

- [ ] **Step 1: Write the failing tests** in `lifecycle.test.ts`:
  - `'FR-1.2: archiving a project archives its three levels of children, and unarchiving restores them'`.
  - `'unarchiving a child of an archived parent returns 409 parent_archived'`.
  - `'Review focus 2: deleting a project deletes everything under it and returns the count'`.
  - `'Review focus 2: deleting an item removes it from other items' blockedBy lists'`, including a deleted descendant that something else was blocked by.
  - `'sibling ranks close up after an archive and after a delete'`.
  - `'Permissions (project.delete)'`, table-driven over archive, unarchive and delete: Owner and Admin succeed; a Contributor gets 403 when not assigned and succeeds when assigned to the item or its parent.
  - `'Tenant isolation: another tenant, and another roadmap, get 404'`.
  - `'archive, unarchive and delete are each audited with the title'`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test lifecycle`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full API suite with coverage, then once with `TEST_MONGO=container`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): archive, unarchive and delete projects (FR-1.2)`.

---

### Task 9: Web: the Projects tab and the tree (FR-1.7, FR-1.9)

**Files:**
- Create: `apps/web/src/projects/useProjects.ts`, `ProjectsPage.tsx`, `ProjectTree.tsx`, `AddItemRow.tsx`, `names.ts`, `apps/web/e2e/projects.spec.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/roadmaps/RoadmapLayout.tsx`, `apps/web/src/api/errors.ts`, `apps/web/src/styles.css`, `apps/web/e2e/helpers.ts`, and the E2E specs that expect a roadmap to open on Members

**Interfaces:**
- Consumes: the list and create routes; `buildTree`, `projectWarnings`, `can` from `@roadmap/shared`; `useRoadmap()` from `RoadmapLayout`.
- Produces in `useProjects.ts`: `PROJECTS_KEY(roadmapId)`, `useProjects(roadmapId)` returning the items and a `byId` map, `useCreateProject(roadmapId)`. Later tasks add mutations here.
- Produces: `useMembers(roadmapId)` in `apps/web/src/members/useMembers.ts`, the members query that `MembersPage.tsx` uses today, moved out so the tree can show assignee names. `MembersPage.tsx` imports it.
- Produces in `names.ts`: `statusName(status)`, `levelName(depth)`, `addChildLabel(depth)` ("Add sub-project", "Add task", "Add sub-task", or null at depth 4), `formatDates(start, end)`, `warningText(warning, byId)`.
- Produces routes: `/r/:roadmapId/projects` and `/r/:roadmapId/projects/:projectId` (the second renders the page with a panel placeholder until Task 10). `RoadmapIndex` now redirects to `projects`. The tab order is Projects, Members, Audit log.
- Produces in `e2e/helpers.ts`: `addProject(page, title)` and `addChild(page, parentTitle, title)`, both through the UI, and `openProject(page, title)`.
- The tree: rows are a `table` with `aria-level` on each row and `aria-expanded` on rows with children. Collapsed state is kept per roadmap in `sessionStorage`. The row menu holds only "Open" and the add-child item in this task. The status pill is read-only in this task.
- Add errors `too_deep`, `parent_archived` and `too_many_items` to `src/api/errors.ts` with the copy in the UI/UX plan.

- [ ] **Step 1: Write the failing E2E** `projects.spec.ts`:
  - `'FR-1.7: a new roadmap opens on Projects and shows the empty message for an Owner'` (and the Contributor's wording, with no "New project" button).
  - `'FR-1.2: an Owner adds a project, a sub-project, a task and a sub-task in place, and a Sub-task's menu has no add item'`.
  - `'the tree collapses and expands, and stays collapsed after a reload'`.
  - `'an empty title shows "Enter a title." and Escape cancels the row'`.
  - `'rows show status, assignee names, dates and position'` (seed through the API with `page.request`; assert "Unassigned", "No dates", and positions 1 and 2).
  - `'FR-1.9: at 375 px the table shows Name and Status only, four levels of indentation fit, and the page does not scroll sideways'`.
  - `'a Contributor sees the add item only on items they are assigned to or that sit under one'`.
  - `expectNoA11yViolations` on the page with rows, and with the add row open.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e projects`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the existing specs and helpers that expect `/r/{id}/members` after opening a roadmap.
- [ ] **Step 4: Unit tests** for `names.ts` (every status, every level, the four date forms, both warning sentences). Run `pnpm run test --coverage` from the root and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Projects tab with the nested list (FR-1.7, FR-1.9)`.

---

### Task 10: Web: the detail panel, core fields (FR-1.4)

**Files:**
- Create: `apps/web/src/projects/ProjectPanel.tsx`, `apps/web/e2e/project-panel.spec.ts`
- Modify: `apps/web/src/projects/useProjects.ts`, `ProjectsPage.tsx`, `ProjectTree.tsx`, `apps/web/src/api/errors.ts`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: the PATCH route, `projectWarnings`, `can`.
- Produces in `useProjects.ts`: `useUpdateProject(roadmapId)`; on success it replaces the item in the cached list.
- The panel edits Title, Description, Status, Start date and End date and saves them together with the item's `version`. It shows the warnings for the item. On `409 conflict` it shows the existing conflict copy and a "Reload" button that refetches and resets the form. The status pill in the row becomes a menu that saves on choice. Whether the form is editable is `can({ role, action: 'project.edit', ctx: { isAssigned } })`, where `isAssigned` is computed in the browser from the item's `path` and the cached list; the server still decides.
- Focus moves into the panel when it opens and returns to the row's title when it closes. Escape closes it.
- Add `date_order` to `src/api/errors.ts`.

- [ ] **Step 1: Write the failing E2E** `project-panel.spec.ts`:
  - `'FR-1.4: an Admin opens an item, changes title, description, status and dates, saves, and the row and a reload show them'`.
  - `'the status pill in the row changes status without opening the panel'`.
  - `'Review focus 1: when someone else saved first, Save shows the conflict message, and Reload brings in their change'` (two browser contexts).
  - `'Review focus 4: an end date before the start date shows "The end date is before the start date." under End date'`.
  - `'a child outside its parent's dates saves and shows "Dates fall outside {parent}'s dates." and the row shows the warning icon'`.
  - `'a Contributor who is not assigned sees the fields read-only with the explanation, and one who is assigned can save'`.
  - `'the panel is a side panel at 1280 px and a full screen with "Back to projects" at 375 px'`.
  - `'opening the panel's address directly shows the item, and an unknown id shows the roadmap's not-found message'`.
  - Focus moves in and back; `expectNoA11yViolations` with the panel open.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e project-panel`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): project detail panel (FR-1.4)`.

---

### Task 11: Web: assignees, lists, priority and lifecycle (FR-1.3, FR-1.4, FR-1.6)

**Files:**
- Create: `apps/web/src/projects/PanelLists.tsx`, `apps/web/e2e/project-order.spec.ts`
- Modify: `apps/web/src/projects/useProjects.ts`, `ProjectPanel.tsx`, `ProjectTree.tsx`, `ProjectsPage.tsx`, `apps/web/src/api/errors.ts`, `apps/web/e2e/project-panel.spec.ts`, `apps/web/package.json` (`@dnd-kit/core`, `@dnd-kit/sortable`)

**Interfaces:**
- Consumes: the assignees, order, priority-label, archive, unarchive and delete routes; the members list (`GET /api/roadmaps/:roadmapId/members`); `wouldCycle`; `ConfirmDialog`.
- Produces in `useProjects.ts`: `useSetAssignees`, `useReorder`, `useSetPriorityLabel`, `useArchive`, `useUnarchive`, `useDeleteProject`. Each refetches the list on success. `useReorder` updates the cached order first and restores it on failure.
- `PanelLists.tsx` renders Assignees, Tags, Links, Milestones and Blocked by. Tags, links, milestones and blocked by are part of the panel's form and save with "Save". Assignees and the priority label save on change, because they use their own routes. The "blocked by" select leaves out any item `wouldCycle` rejects.
- Reordering: a drag handle per row, shown when `can({ role, action: 'project.setPriority' })`, using dnd-kit's pointer, touch and keyboard sensors and constrained to the row's siblings. "Move up" and "Move down" in the row menu do the same through `useReorder`.
- Archive shows the notice and removes the row. Delete opens the confirm dialog with the count of items under it, taken from the cached list.
- Add `dependency_cycle`, `order_stale` and `unknown_item` ("That item no longer exists. Reload and try again.") to `src/api/errors.ts`.

- [ ] **Step 1: Write the failing E2E.**
  - In `project-panel.spec.ts`:
    - `'FR-1.6: an Admin assigns two members and the row lists both names'`.
    - `'FR-1.4: an Admin adds a tag, a link and a milestone, saves, and a reload shows them'`, with the three validation messages.
    - `'FR-1.4: an Admin marks an item blocked by another, and the select does not offer the item itself, its parent or its children'`.
    - `'an item that starts before its blocker ends shows "Starts before {blocker} ends."'`.
    - `'a Contributor sees assignees and the priority label read-only'`.
  - In `project-order.spec.ts`:
    - `'FR-1.3: an Admin moves a sub-project up with the row menu, and the order survives a reload'`.
    - `'FR-1.3: an Admin reorders with the keyboard on the drag handle'` (focus the handle, Space, ArrowDown, Space).
    - `'FR-1.3: an Admin drags a row with the mouse'`.
    - `'Review focus 5: when a sibling was added in another session, the reorder shows "The list changed while you were reordering. Try again." and the list refreshes'`.
    - `'a Contributor sees no drag handles and no Move items'`.
    - `'an Admin sets the priority label to P1 and the row shows "1 · P1"'`.
    - `'archiving shows "Archived {title}." and removes the item and its children from the list'` (confirm through `page.request` that all of them are archived; Task 12 covers showing and unarchiving them).
    - `'Review focus 2: deleting an item with two children names the count in the dialog, and Cancel keeps it'`.
    - `expectNoA11yViolations` with the delete dialog open and during a keyboard reorder.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e project-panel project-order`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test --coverage` and `pnpm test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): assignees, lists, priority order and lifecycle (FR-1.3, FR-1.4, FR-1.6)`.

---

### Task 12: Web: filters, search and audit sentences (FR-1.8)

**Files:**
- Create: `apps/web/src/projects/FiltersPanel.tsx`, `apps/web/src/projects/filters.ts`, `apps/web/src/projects/filters.test.ts`, `apps/web/e2e/project-filters.spec.ts`
- Modify: `apps/web/src/projects/ProjectsPage.tsx`, `ProjectTree.tsx`, `apps/web/src/audit/describe.ts`, `apps/web/src/audit/describe.test.ts`, `apps/web/src/audit/AuditPage.tsx` (the action filter's options)

**Interfaces:**
- Consumes: `filterProjects`, `activeFilterCount`, `NO_FILTERS`, `ProjectFilters` from Task 2.
- Produces in `filters.ts`: `filtersFromSearch(params: URLSearchParams, meId: string): ProjectFilters` and `filtersToSearch(f: ProjectFilters): URLSearchParams`. Keys: `q`, `status`, `assignee`, `tag`, `label`, `from`, `to`, `archived=1`. Multi-value keys repeat. `assignee=me` stands for the signed-in user. Unknown or malformed values are dropped.
- The tree renders `matches` normally and `context` rows greyed, with their ancestors expanded. With no filters it renders everything not archived.
- `describe.ts` gains the ten audit sentences in the UI/UX plan, built from each event's `before` and `after`.

- [ ] **Step 1: Write the failing tests.**
  - `filters.test.ts`: a round trip for every field; `assignee=me`; a malformed date and an unknown status are dropped; `NO_FILTERS` gives an empty query string.
  - `describe.test.ts`: one case per new sentence, including a deleted item named from `before.title` and a top-level reorder.
  - `project-filters.spec.ts`:
    - `'FR-1.8: filtering by status shows matching items and their ancestors, and the button reads "Filters (1)"'`.
    - `'FR-1.8: filtering by "Assigned to me", by tag, by priority label and by a date range each narrow the list'`.
    - `'FR-1.8: search matches a title, a description and a tag, ignoring case'`.
    - `'filters combine, and "Clear filters" restores the full list'`.
    - `'no match shows "No projects match these filters." with a working "Clear filters" button'`.
    - `'the filtered address can be opened in a new tab and shows the same list'`.
    - `'"Show archived" reveals archived items marked "Archived", with Unarchive in their menu'`.
    - `'the audit log shows a sentence for adding, changing, reordering and deleting an item'`.
    - At 375 px the filters panel fits and the page does not scroll sideways; `expectNoA11yViolations` with the panel open.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test filters describe` and `pnpm --filter @roadmap/web test:e2e project-filters`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm lint`, `pnpm typecheck`, `pnpm run test --coverage` and `pnpm test:e2e` from the root, then the API and E2E suites once with `TEST_MONGO=container`. Expected: PASS. Push and confirm every CI job is green.
- [ ] **Step 5: Commit** `feat(web): filter and search the project list (FR-1.8)`.

---

## Next plans (v1)

1. Timeline and Board views (the rest of FR-1.7), reusing `buildTree`, `filterProjects` and `projectWarnings`.
2. Notes, @mentions and attachments (FR-1.5 and the attachments part of FR-1.4), which needs S3.
3. Snapshots and PDF (FR-3), calendar feed (FR-4), notifications (FR-5), POC infrastructure, release hardening, as listed in the Foundation plan.

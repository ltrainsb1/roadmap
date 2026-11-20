# v1 Projects and List View: decisions made and work left

This records what was decided while executing the [Projects and List View plan](2026-11-19-v1-projects-list-view.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent or wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| P1 | If adding the project audit actions had broken an exhaustive map elsewhere, the smallest generic fallback would go in first. | Keep each task shippable. | None; it was not needed. |
| P2 | Superseded by P6. | | |
| P3 | Assigning someone and removing them from the roadmap at the same instant can't leave them assigned. Both operations write a counter on the roadmap record, so one retries. | The plan says a removed member is never left on an item. | One extra write per assign or removal. |
| P4 | Every reorder writes a counter on the roadmap record. | Writing only the changed positions let two reorders of different items blend into an order neither person sent. | Changes in one roadmap queue behind each other. |
| P5 | Every delete signals the dependency guard, not only a delete that removed a reference. | An edit adding a "blocked by" at the same instant could keep a reference to the deleted item. | None. |
| P6 | Creating an item signals the order guard. | A create at the same instant as its parent's archive or delete left a live child under an archived parent, or an orphan. It also makes positions and the 2,000-item limit exact. | Creates in one roadmap queue behind each other. |
| P7 | The nested list is a plain table. The level is hidden text before each title ("Sub-task: …"), and the collapse button's name carries the open or closed state. | The plan's `aria-level` and `aria-expanded` on rows are invalid on a table; a grid would promise arrow-key navigation this plan does not build. | Revisit if a keyboard grid is wanted. |
| P8 | Opening a roadmap, creating one, and joining by invite all land on the Projects tab. | The plan made Projects the first tab. | One redirect to change. |
| P9, P14, P17 | On-screen copy that implementers wrote beyond the UI/UX plan was accepted. | Reviewers checked it against the plain-writing rules. | Rewording. The list is below. |
| P10 | The panel picks up the result of this browser's own "save on change" action (status, assignees, priority label) only when it is the very next version after the one the form started from. | Otherwise a person's own status change made their next Save show "someone else changed this"; and adopting any later version could hide another person's edit. | None. |
| P11 | With unsaved changes in the panel, Escape, Close, "Back to projects" and opening another row ask before discarding. | The plan's "Escape closes it" would lose typed text on an accidental key press. | One dialog when leaving a dirty form. Browser Back, reload, the tab bar and the roadmap picker are not covered; see below. |
| P12 | While a panel is open for editing, "Save" is the primary button and "New project" is secondary. | One primary button per screen. | None. |
| P13 | After a "Remove" button is used, focus moves to the next entry, the previous one, or the add field. The reorder tests have no fixed waits. | WCAG 2.4.3; flaky tests. | None. |
| P15 | The router's `useTransitions` is off for the whole app. | It is what lets filter state live only in the address without dropped keystrokes. A test fails without it. | A future lazily loaded screen shows its loading state instead of keeping the old screen up. |
| P16 | "Assigned to me" is stored in the address as `me`. | A shared link should mean "assigned to whoever opens it". | None. |
| P18 | A blocker is added with an "Add item" button, not when the dropdown changes. | On Windows and in Firefox the down arrow added the first choice at once (WCAG 3.2.2). | One extra click. |
| P19 | A panel whose item is gone reads "This item no longer exists, or you don't have access to it." | The plan borrowed the roadmap's not-found sentence, which is wrong inside a roadmap that exists. | Rewording. |
| P20 | Adding an item that doesn't match the active filters says so. "Move up" and "Move down" announce the new position. | Otherwise nothing appeared to happen. | None. |
| P21 | The panel's own Save explains a 404 or 403 and refreshes, as the row actions do. | The fix pass had left it out. | None. |

Rulings carried from the Foundation run still apply: commit trailers name the model that wrote the commit, every kind of test runs in GitHub Actions, and Docker is the devbox.

Other choices implementers made where the plan gave no value:

- A stale version is refused with `409 conflict` even when the request would change nothing.
- Reordering is unavailable while any filter, search or "Show archived" is on, with the note "Clear filters to reorder.", because a filtered group is incomplete.
- The priority label is the one "save on change" control with no version check. It is a single value, so the last writer wins.
- The assignee change carries a version from the fix pass on; a request without one still works.
- `ensureIndexes` creates indexes with one call per collection. The index definitions and names are unchanged.
- The end-to-end harness raises its own sign-in rate limit to 10,000 a minute. Production is unchanged.

## Copy added beyond the UI/UX plan

- List: "Cancel" in the add row; "Loading"; hidden level prefixes ("Project: ", "Sub-project: ", "Task: ", "Sub-task: "); hidden "Actions" column heading; "Shown for context" on greyed rows; "Clear filters to reorder."; "Couldn't refresh the list. Try again." with button "Try again".
- Panel: "Discard your unsaved changes to {title}?" with "Discard" and "Keep editing"; "Choose an item" and "Choose an item."; button "Add item"; "Deleted item"; an "Archived" hint on a blocker; "Remove link {x}"; "Remove milestone {x}"; "Unassigned" in a read-only assignee list; "This item no longer exists, or you don't have access to it."
- Notices: "Unarchived {title}."; "Added {title}. It doesn't match the filters, so it isn't shown."; "Moved {title} to position {n} of {total}."; "Picked up {title}."; "Dropped {title} at position {n} of {total}."; "Reordering cancelled."
- Filters: "Former member"; "No tags yet."
- Errors: `unknown_item` "That item no longer exists. Reload and try again."
- Audit log: the fallback "an item"; filter labels "Item added", "Item changed", "Item deleted", "Item archived", "Item unarchived", "Assignees changed", "Items reordered", "Priority label changed".
- Screen-reader names: "Status of {title}: {status}"; "Details".

## Needs a product decision

- **Unarchive restores everything under an item,** including items that had been archived on their own before the parent was. Nothing is lost. Keeping them archived would mean recording which archive hid each item.
- **Editing, labelling and blocking by archived items** is allowed by the API. The plan is silent.
- **Invites to an archived roadmap** still work (carried from Foundation).

## Not verified

- Escape while a native date picker is open in the panel.
- The list's width beside the panel between 900 and 1,000 px.
- Date inputs holding a value at phone width on iOS Safari.

## Found and left for later

Behaviour and usability:

- Browser Back, reload, the tab bar and the roadmap picker discard unsaved panel edits without asking. Guarding them needs a data router's `useBlocker` or a `beforeunload` handler.
- A person with unsaved text in a panel that has become read-only is asked about discarding when they leave.
- Clicking Save and then the status pill before the save returns shows that person a false conflict. The window is under a second.
- Assignee boxes and the label select wait for two requests before they show the change.
- While a row is dragged, other rows with expanded children shift without them.
- Adding a child under a match while filtered writes the stored collapsed state.
- With both `me` and your own id in the address, two boxes show ticked for one person.
- A long paste into Description is truncated silently at 5,000 characters.
- The default date format prints September as "Sept", which depends on the browser.
- The list endpoint returns every item with no paging.

Accessibility:

- Tag, link and milestone errors and the no-match message are not in live regions.
- The collapse button could carry `aria-expanded`, which is valid on a button.
- Warning sentences on a row are in a `title` attribute; the panel shows them properly.

Code:

- A reorder of a very large group runs up to 2,000 sequential updates in one transaction. A bulk write is the eventual fix.
- `ProjectsPage.tsx` is about 420 lines. Move the row actions into a hook before the Timeline and Board views copy them.
- `SelectField` would let a caller's own `aria-describedby` override its error wiring. No caller does.
- `NO_FILTERS` is used only by tests. A small `Group` component is duplicated in two files.
- `isHttpUrl` accepts `http:foo`.

Tests:

- Give the end-to-end specs a reusable signed-in fixture. About 70 specs each create an account through the full sign-up flow, twice over, against one server; the three one-off local failures seen during this plan all fit a 60-second budget running out, and no other cause was found.
- No test covers `useReorder` rolling back, a blocker that was archived or deleted, or non-adoption through the assignee or label path.
- Some test names lack the FR id the definition of done asks for.

## Next plans

1. Timeline and Board views (the rest of FR-1.7), reusing `buildTree`, `filterProjects` and `projectWarnings`.
2. Notes, @mentions and attachments (FR-1.5 and the attachments part of FR-1.4), which needs S3.
3. Snapshots and PDF, calendar feed, notifications, POC infrastructure and release hardening, as listed in the Foundation plan.

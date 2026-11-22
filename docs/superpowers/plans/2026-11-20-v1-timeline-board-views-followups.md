# v1 Timeline and Board views: decisions made and work left

This records what was decided while executing the [Timeline and Board views plan](2026-11-20-v1-timeline-board-views.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass with its own re-review.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent or in conflict. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| R1 | The work was done in place on `v1-views`, with no separate worktree. | Same as both earlier plans. | None. |
| R2 | Commit trailers name the model that wrote the commit. | Carried from Foundation. | None. |
| R3 | A week tick cut by the start of the axis has no label. | Its Monday is in the previous month, so it read as a wrong date under the month heading. | Rewording. |
| R4 | At Weeks zoom, when month headings would be under 48 px wide, the headings are years. | A 300-year range gave about 3,600 month cells 6 px wide. | One branch to remove. |
| R5 | Every menu's list is positioned against the window, opens upward when there is no room below, and closes when a scroll moves its button. | Menus inside the Timeline's scrolling frame were cut off. | It changes the shared menu, so the List's menus changed too. |
| R6 | The today line is decorative. The "Today" button is what assistive technology gets. | The line's meaning is its position. | Add hidden text later if wanted. |
| R7 | Below 600 px the Timeline hides the status pill and the Actions menu, and each row carries its status as hidden text for screen readers. | The plan said both "hide the pill" and "status as text on every row". | On a phone, status and row actions can't be changed from the Timeline, and sighted users get status from bar colour only. |
| R8 | Changing Zoom scrolls today back into view. | Pixel scroll offsets mean nothing after the scale changes. | One line. |
| R9 | On Board cards narrower than 200 px the status sits on its own line under the handle and Actions. | Three 44 px controls don't fit in 114 px. | CSS only. |
| R10 | Board cards show the same warning icon as the List and the Timeline. | The plan's card table left it out, but the plan promises that conflicts are flagged in the new views. | One icon to remove. |
| R11 | The Board's drag handle is not a tab stop. | It does nothing from the keyboard; the status menu is the keyboard way to move a card. | One attribute. |
| R12 | The "Projects" tab still links to the List with no filters, and the roadmap picker and section tabs still skip the unsaved-edits question. | Both are older than this plan and outside it. | Someone on the Timeline who clicks "Projects" lands on the unfiltered List. |
| R13 | A dialog ignores a late "closed" event from its previous closing. | Pressing Escape right after "Discard" silently dropped the next "Discard your unsaved changes?" question. This was the cause of the flaky panel test. | None. |
| R14 | Context-row bars on the Timeline are drawn at 80% strength, up from 50%. | At 50% every status colour was under the 3:1 contrast that WCAG 1.4.11 asks for (grey was 1.97:1; it is now 3.28:1). | Context bars look only a little lighter than normal ones; the italic, muted name still marks the row. |
| R15 | On the List, a touch drag now starts with a 250 ms long press, the same as the Board. | The List's pointer sensor was taking touch before the long press could apply. | A touch reorder takes a moment longer to start. |
| R16 | The last review finding (arrow keys in a height-capped menu moved focus to an entry that was scrolled out of view) was fixed directly after the re-review, with a unit test. | It was introduced by the fix pass and took ten lines; parking it would have shipped a known keyboard fault. | That one change had no separate review. |

Other choices implementers made where the plan gave no value:

- The Board's scrolling container is a region named "Board", and it can take keyboard focus so it can be scrolled without a card.
- Unknown query-string keys are dropped from links inside the three views.
- The roadmap picker keeps the current view and drops the open item and the filters, since filters name ids from one roadmap.
- The Board's drag uses a pointer sensor that leaves touch to the long-press sensor, and auto-scroll is limited to the board.
- After a card moves through its status menu, or is put back because the save was refused, focus returns to that card's status menu.
- A menu is never taller than the room beside its button; a longer one scrolls inside.

## Copy added beyond the UI/UX plan

- Timeline: the scrolling area is named "Schedule, scrolls sideways"; "No items have dates yet. Open an item to add its dates."
- Board: the scrolling area is named "Board"; "No projects match these filters." with "Clear filters" when the filters leave no card at the chosen level.

## Not verified

- Only Chromium is tested. Board card menus are positioned correctly in Chromium 159 (measured, and now covered by a test). Older Firefox and Safari versions may treat a card as the anchor for its menu and put the menu in the wrong place; this has not been checked in either browser.
- The Board at 320 px wide. Tests run at 375 px.
- Colour contrast figures are calculated, not measured on screen.

## Found and left for later

- After "Discard", focus can land on the row's link in the list and not on the new panel's heading. The heading takes focus while the dialog still blocks the page, then the dialog's closing puts focus back on the link. Older than this plan.
- On the Timeline below 600 px, status and row actions can't be changed; use the panel or the List (R7). Items with no dates show no status to sighted users there.
- The Timeline's date header does not stay in place when scrolling down.
- "Today" is worked out on each render, so it is stale after midnight until the next render.
- `TimelineView.tsx` uses the colour `#d5d9e0` where `--border` exists.
- The Board's region is a tab stop even when it is wide enough not to scroll.
- The List's menu entries repeat Open, Archive and Delete from the shared hook's `menuFor`.
- `void owner;` in `roadmaps.spec.ts` and `settings.spec.ts`.
- `changeStatus`'s true/false result has no unit test; the Board's end-to-end tests exercise it.
- "No sub-tasks yet." is covered only by a unit test.
- `dayNumber` does not validate its input, and no test covers a range that starts mid-month at Months or Quarters zoom.

## Needs a product decision

Carried from the Projects plan, still open:

- Whether unarchive should restore items that were archived on their own before their parent.
- Whether archived items may be edited or used as blockers.

## Next plans

1. Notes, @mentions and attachments (FR-1.5 and the attachments part of FR-1.4), which needs S3.
2. Snapshots and PDF (FR-3), which reuses `packages/shared/src/timeline.ts`.
3. Calendar feed, notifications, POC infrastructure and release hardening.

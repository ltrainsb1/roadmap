# v1 Notes, Mentions and Attachments: decisions made and work left

This records what was decided while executing the [Notes, Mentions and Attachments plan](2026-11-21-v1-notes-mentions-attachments.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass with its own re-review.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent, or where the plan turned out to be wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| P1 | The local download route exists whenever the store in use is the local-disk or in-memory one, whatever `FILES` says. | Tests hand the app a store directly. | None. |
| P2 | The work was done in place on `v1-notes`, with no separate worktree. | Same as the earlier plans. | None. |
| P3 | Tests that need containers (MinIO, ClamAV, the compose smoke run) are proven in CI and on the devbox, not by implementers. | Docker is not on the Mac. | A container test can fail first in CI. |
| P4 | When two members share a name, the person recorded for `@Name` is the one picked from the list. A hand-typed `@Name` records the first member with that name. | The picker knows who was chosen; the text doesn't. | A hand-typed mention of the second "Ann Lee" records the first. |
| P5 | No stopgap was added to keep the `deploy-smoke` job passing between Task 3 and Task 9. | Nothing was pushed until all nine tasks were done. | None now. |
| P6 | At most four uploads are in flight in one API process. A fifth is refused at once with "Couldn't add {file name}. Try again.". | The plan set no bound, and one member could exhaust the server's memory. | A busy team sees an occasional retry. |
| P7 | A note nested more than 50 block quotes deep or 200 levels deep in any way, or one whose rendering fails, shows as plain text. | A note of 3,000 `>` characters crashed the panel for everyone who opened the item. | A very deeply quoted note loses its formatting. |
| P8 | When a reply or edit can't be saved because the note is gone, its text moves to the "Add a note" box with "That note no longer exists." above it. The same happens when a refresh removes the note. | Typed text is never thrown away silently. | One more state to maintain. |
| P9 | A reply or edit box that holds changed text blocks opening another one, with the message "Finish or cancel this one first." | Opening a second box used to discard the first one's text. | One extra step when switching. |
| P10 | Escape inside a reply or edit box behaves as it does in the item form: it asks first if there is text, then closes the panel. | The copy plan was silent and this matches the form. | Someone expecting Escape to cancel only the box closes the panel. |
| P11 | The plan was wrong to make the note text box a `combobox` while the @ list is open. The text box keeps its role; a hidden announcement reads out the highlighted name, or "No one matches.". | The HTML accessibility rules allow no other role on a multi-line text box. | Spoken feedback depends on the announcement where screen readers handle the other attributes poorly. |
| P12 | A deleted top note that still has replies accepts new replies. | The plan says a reply to a reply adds to the same thread; the thread was offering "Reply" and always refusing. | None. |
| P13 | A download navigates the page to the signed link. | Opening a new tab after fetching the link is blocked as a popup, and an inline frame to S3 is blocked by the content security policy, which must not be loosened. | If S3 answers with an error page (for example a wrong access role), the browser leaves the app and unsaved text is lost. See "Left for later". |
| P14 | An upload has 300 seconds to arrive, up from 120. | At 120 seconds a 25 MB file needs 1.7 Mbit/s upstream. | A stalled upload holds one of the four slots for up to five minutes. |
| P15 | ClamAV may use 3 GB of memory, up from the plan's 2 GB. | Reloading its signatures briefly holds two copies, about 1.9 GB. | On the 4 GB POC server a reload can squeeze MongoDB and the API. |
| P16 | Not fixed in this plan: a per-person upload cap, sweeping stored files whose deletion failed, roadmap delete in one transaction, the archived sentence showing once per section, and code shared between the two sections. | Each is small or needs a decision; all are listed below. | See "Left for later". |

Other choices implementers made where the plan gave no value:

- An edit that changes only who is mentioned counts as an edit: "Edited" shows and the audit log records it.
- A file name with a raw line break is refused by the upload parser (400); browsers send it encoded, and that name is stored cleaned.
- A refused upload that failed the virus check is recorded against the item, since no file record exists.
- When an item becomes archived while someone is typing a note, the text stays on screen in a read-only box under the archived sentence until the panel closes.
- Download links are followed only when they are `http:` or `https:`.
- The smoke script's writing checks run only with `SMOKE_WRITES=yes`, which CI sets. They create a tenant, a roadmap, an item and two files, so they must only run against a throwaway stack.
- The ClamAV image is listed by the vulnerability scan in CI but does not block the build; the two images we build still do.

## Copy added beyond the UI/UX plan

- Notes: "Finish or cancel this one first."; "Loading" while notes load; "Something went wrong. Try again." in the delete dialog; "This item no longer exists, or you don't have access to it." when a note can't be added because the item is gone.
- Audit log: sentences "{who} added a note.", "{who} edited a note.", "{who} deleted a note." and the matching ones for files; filter labels "Note added", "Note edited", "Note deleted", "File added", "File removed", "File blocked by the virus check".

## Not verified

- Only Chromium is tested.
- A real touch tap on a phone choosing a name from the @ list, and whether the list can sit under the on-screen keyboard. Check on an iPhone and an Android phone before release.
- Real S3 with a real KMS key and access role. Tests use MinIO with a generated key.
- ClamAV fetching fresh signatures on the production server; it needs outbound internet, and signatures go stale silently without it.
- Roadmap delete at the limits (2,000 items with 500 notes each) inside MongoDB's 60-second transaction limit.

## Needed before release

- **A fixable high-severity flaw in the ClamAV image** (`clamav/clamav:1.4.7`, in its XML library). Build a thin image of our own that upgrades that library and goes through the same blocking scan as our other two images.
- **The S3 bucket, its KMS key and the access role** (POC infrastructure plan). An existing deployment must also add `S3_BUCKET` to its `.env`, or the stack refuses to start.
- **Downloads when S3 returns an error** (P13). Decide with the infrastructure plan: either an S3 error page that links back, or a download path that can't leave the app.
- **Health checks** do not cover S3 or ClamAV. When S3 is down an upload fails with a generic error and a log line; when ClamAV is down it fails with "Files can't be checked right now."
- Pin container images by digest. The MinIO images used by the smoke run and the container test are community builds; replace them or accept them as test-only.
- Put ClamAV and MongoDB on an internal network that the public-facing proxy is not on.

## Found and left for later

- One person can hold all four upload slots. A per-person cap of one or two inside the four would stop that.
- When deleting stored files fails after the records are gone, the keys are logged once and nothing retries. Keys are laid out as tenant/roadmap/id, so a sweep by prefix is possible.
- The upload limit of four counts per API process.
- "The archived sentence" appears once in Files and once in Notes, so a screen reader hears it twice.
- If an item is unarchived while kept note text is showing, two fields named "Add a note" sit side by side until the panel closes.
- A member who loses access while typing loses the text in the bottom note box.
- A reply box whose item is gone says "That note no longer exists.".
- `x**@Ann**` is highlighted as a mention when Ann is recorded on the note, though that position would not record one.
- A rule written as more than 50 repeats of `- ` or `* `, or a code line starting with more than 50 `>`, shows the whole note as plain text.
- Pressing "Reply" again while "Finish or cancel this one first." is showing does not announce it again.
- A no-op edit of a note still writes the item's internal revision counter.
- The main JavaScript bundle grew from 562 kB to about 692 kB (about 36 kB more when compressed) with the Markdown library. Loading it only when a note is shown was judged not worth a loading state in the panel.
- The Files and Notes sections share patterns (the delete dialog wrapper, focus after removal, the load-error alert) that could be one piece when a third section arrives.
- The smoke script reads JSON fields with a pattern that takes the last match in a response.
- Web unit-test coverage counts only `src/api/**`; this is older than this plan.

## Needs a product decision

- Archived items: this plan made notes and files on an archived item read-only. The question carried from the Projects plan, whether archived items may be edited or used as blockers, is still open, and this should match its answer.
- Whether unarchive should restore items that were archived on their own before their parent (carried from the Projects plan).

## Next plans

1. Snapshots and PDF (FR-3), which reuses `packages/shared/src/timeline.ts` and must decide how notes appear (FR-3.5).
2. Notifications (FR-5): reads the mentions stored on notes to send "you were mentioned", with per-user instant, digest or off.
3. Calendar feed (FR-4), POC infrastructure (including the items under "Needed before release"), and release hardening.

# v1 Notifications: decisions made and work left

This records what was decided while executing the [Notifications plan](2026-11-23-v1-notifications.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass with its own re-review.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent, or where the plan turned out to be wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| N1 | The work was done in place on `v1-notifications`, with no separate worktree. | Same as the earlier plans. | None. |
| N2 | Each pass, the worker walks every notification due for email, not only the oldest 100. | Rows waiting for a digest would otherwise hold up instant ones behind them. | A scan of waiting rows every pass; fine at POC scale. |
| N3 | The worker's heartbeat file path is a setting (`WORKER_HEARTBEAT_FILE`). | Test runs on a shared machine need their own file. | None. |
| N4 | "Due soon" reminders are written one at a time outside a transaction; a duplicate means "already reminded". | A reminder is independent of other writes. | A reminder for an item deleted at that instant can be written; N12 cleans it up. |
| N5 | Container work was proven on the devbox and in CI, not by every implementer. | Docker is not on the Mac. | A container fault can surface first in CI. |
| N6 | Every date the app and the emails print uses fixed English month names ("Sep"), as the Timeline already did. | Different ICU versions print "Sep" or "Sept"; the same screen showed both. | September dates on screen changed from "Sept" to "Sep". |
| N7 | A day's digest takes only notifications from before 8 am that morning; later ones wait for the next morning. | The plan promises 8 am; the first rule sent a one-line "digest" at whatever time something arrived on a quiet day. | Something that happens at 8:05 waits a day if that person chose the digest. |
| N8 | Above 99 the bell is read out as "Notifications, 99+ unread". | Reading out the exact number fails the accessibility rule that the spoken name match the visible label. | A screen reader user hears "99+" rather than the exact count. |
| N9 | A change of email settings is recorded in the audit data but not listed on a roadmap's audit page. | It belongs to the person's account, not a roadmap; sign-ins aren't listed there either. | It is visible only in the database until an account-level log exists. |
| N10 | Mention notifications are tied to their note: deleting the note deletes them, and editing it removes them for anyone no longer mentioned and updates the excerpt for the rest. | Deleted note text was still emailed and listed for 90 days. | An email that has already gone can't be recalled. |
| N11 | Times in the list read "{day} at {HH:MM}" in the person's time zone, for example "3 Sep 2026 at 14:05". | Ruling N6 applies to times as well; the browser's locale format mixed spellings. | Differs from the audit page, which still uses the browser's format. |
| N12 | A notification whose item or roadmap has gone is left out of the list, and the worker deletes it instead of sending it. | Closes the race left by N4, and keeps the unread count equal to the list. | One more read per page and per send. |
| N13 | The worker counts as unhealthy only when its heartbeat is older than 3 intervals plus 150 seconds, and a stop gives it 120 seconds to finish its pass. | A slow email service must not make it look broken or be cut off between sending and marking sent. | A hung worker takes up to about 4 minutes to show as unhealthy. |

Other choices implementers made where the plan gave no value:

- Every notification written also bumps a counter on the recipient's membership, so a mention saved while that person is being removed from the roadmap conflicts with the removal and one retries. No notification is ever left for someone who has left.
- Claims and leases are timed when each one is taken, not at the start of a pass; email sends time out (5 s to connect, 30 s per request).
- A worker pass in which all three steps fail writes no heartbeat, so a worker that can't reach the database fails its health check.
- Removing a member already removed them from every item's assignees; the dates rule checks membership as a second guard.
- Marking a notification read needs current membership of its roadmap.
- The worker's cross-tenant queries live in `apps/api/src/db/worker-db.ts`, beside `unscoped.ts`.
- `formatDates` moved into `@roadmap/shared`, so the web and the emails print date ranges the same way.
- The account-setup command's build now includes the shared package, as the server's and worker's builds do; without it the command failed inside the built image.

## Copy added beyond the UI/UX plan

- "Loading" (status) on the notifications list and the settings page.
- "Couldn't load your settings. Try again." on the settings page.

## Measured

- The worker container peaked at 50 MiB of its 256 MB limit on the devbox stack.

## Not verified

- Only Chromium is tested.
- The CI `deploy-smoke` job with the worker service and the new smoke checks, until the first push.
- Real email delivery through SES; all tests use the file and memory mailers.
- The radios on the settings page lining up under their column headings at 600 px and wider (no visual check).
- The browser's Back button and Sign out don't ask before discarding unsaved settings (the item form has the same limit).

## Needed before release

- **Email reputation:** SES bounce and complaint handling, and a one-click unsubscribe (`List-Unsubscribe`), belong with SES in the infrastructure plan.
- **The worker holds every API secret**, because it loads the same configuration. Trim what it gets in the infrastructure plan.
- **Watching the worker:** nothing restarts an unhealthy worker in plain Compose; the deployer must watch its health. With the email service hung, the N13 slack covers about five sends before a pass is reported unhealthy, and the stop grace about four; a larger backlog during an outage can still be reported unhealthy or, on a stop, resend one email.
- **Time zones:** people created by the bootstrap command are on UTC, and nobody can change their time zone yet.

## Found and left for later

- A note edited to drop someone and then to add them back notifies them again.
- After a failed digest, a notification arriving during the retry wait can go out on its own and push the failed ones to the next day (narrowed by N7).
- The worker rebuilds every digest-waiting row on each pass; replace the walk with the SQS design.
- A test that two passes run at once takes about 10 seconds.
- The email client's timeout settings are checked by value, not by a test that the client uses them.
- A note excerpt can be cut inside an emoji sequence joined by zero-width joiners (never inside a single character).
- Stored email settings are read without re-validating them; only the validated save writes them.
- Saving unchanged settings still writes an audit event.
- The smoke script's member lookup uses GNU `sed`; CI and the devbox are Linux.
- The invited member the smoke script creates isn't removed (the stack is thrown away).

## Needs a product decision

- Whether to add an account-level activity log (sign-ins, passkeys, email settings).
- Whether people may change their own time zone (it drives the digest hour and "due soon").
- Carried from earlier plans: whether archived items may be edited or used as blockers, and whether unarchive should restore items archived on their own before their parent.

## Next plans

1. Calendar feed (FR-4).
2. POC infrastructure (server size, S3, KMS, SES with bounce handling and unsubscribe, the queue for PDFs and email), then release hardening.

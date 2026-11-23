# v1 Snapshots and PDF: decisions made and work left

This records what was decided while executing the [Snapshots and PDF plan](2026-11-22-v1-snapshots-pdf.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass with its own re-review.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent, or where the plan turned out to be wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| S1 | The work was done in place on `v1-snapshots`, with no separate worktree. | Same as the earlier plans. | None. |
| S2 | No stopgap kept the `deploy-smoke` job passing between Task 5 and Task 9. | Nothing was pushed until all nine tasks were done. | None now. |
| S3 | The page supplies the PDF footer's left part ("{roadmap name} · As of {date}"); the PDF service adds " · Page {n} of {total}". | The page can't know page numbers. | None. |
| S4 | `apps/pdf` has a `start` script like the API's, which the E2E setup runs. | Matches the API. | None. |
| S5 | Container work was proven on the devbox and in CI, not by every implementer. | Docker is not on the Mac. | A container fault can surface first in CI. |
| S6 | The API test timeout is 15 s, up from 5 s. | Each test database now builds four more collections' indexes, and a queued build once pushed an unrelated test past 5 s. | A real hang takes 15 s to fail. |
| S7 | A snapshot card's "Expires {date}" is shown in the browser's time zone, the zone the expiry was built in. | Otherwise it can read a day off from the day the Admin picked. | It can differ from the card's other dates when the profile and browser zones differ. |
| S8 | Chromium's sandbox stays on in the `pdf` container, with one capability added back (`SYS_CHROOT`) beside `cap_drop: [ALL]`, Playwright's seccomp profile, a non-root user, `no-new-privileges`, a read-only root and internal-only networks. | Without that capability the sandbox can't start (`sys_chroot("/proc/self/fdinfo/")` fails). A sandboxed browser with one narrow capability is safer than an unsandboxed one with none. | If it's unwanted: set `chromiumSandbox: false` and remove the `cap_add`. |
| S9 | The API trusts `X-Forwarded-For` only from the proxy's own network (`TRUSTED_PROXY_CIDR`, required in production). Caddy reaches the API on a network only the two of them share. | The `pdf` container shares a network with the API, so before this a compromised browser could claim any client address, dodging the per-address limits on sign-in and snapshot passwords and falsifying audit addresses. | One more production setting, and a fixed network range that can collide on a host. |
| S10 | The API starts once the PDF service has started, not once it is healthy. | A Chromium failure on a host must not take sign-in and the rest of the site down for an optional export. | PDF requests answer "Couldn't create the PDF. Try again." until the service is healthy. |
| S11 | Snapshots too large to print are refused up front with "This snapshot is too large for a PDF. You can still read it here.", and a PDF that just failed is not retried for 60 seconds per snapshot and view. | The plan's largest list PDF (2,000 items, 5,000 notes) ran out of the PDF container's 1 GB in 2.2 s; without a limit it would fail every time and hold a render slot on every retry. | A size limit and a message the plan didn't have. |
| S12 | The proxy network's default range is `10.254.254.0/24` (`PROXY_SUBNET`), outside Docker's default address pools; `TRUSTED_PROXY_CIDR` refuses IPv4 ranges wider than /8 and IPv6 wider than /32. | The first default sat inside Docker's pools and could collide; a range like `0.0.0.0/0` would bring the address-forging problem back. | A host whose own network uses that range must set `PROXY_SUBNET`. |
| S13 | The PDF size limit is 700 rows (items plus included notes for the list; items for the timeline). | Two PDFs can be made at once; two at 1,000 rows ran out of memory and two at 700 peaked at 785 MiB. | A 2,000-item timeline, which prints alone in 3.1 s and 713 MiB, is refused too. Raising the `pdf` container's memory is the way to allow more. |

Other choices implementers made where the plan gave no value:

- Each snapshot create bumps a `snapshotRevision` counter on the roadmap, so two creates, or a create and a roadmap delete, conflict and one retries. That keeps the 50-snapshot limit and stops a snapshot outliving its roadmap.
- A render token opens only the content route; the status, notes, PDF and unlock routes ignore it.
- A Chromium that hangs without crashing (a browser context that won't open or close in time) fails the PDF service's health check and restarts it; a page that is only slow is a plain timeout.
- The create mutation keeps no copy of the snapshot password once the request settles.
- An item with nothing in its details shows its title as plain text, not a button.
- On a print page, link addresses are written out as "{label} ({url})".
- Times in a PDF are UTC and the list PDF says so; on screen they use the viewer's own zone.

## Copy added beyond the UI/UX plan

- Snapshots tab, for a Contributor: "Only Owners and Admins can see snapshots."; "Created by a former member on {date}" when the creator's account is gone.
- Viewer: "Enter the password." for an empty submit; the list's accessible name "List".
- Download PDF: "This snapshot is too large for a PDF. You can still read it here." (S11).

## Measured

- PDFs: a small list 2 pages, a timeline 1 page, 200 items with 300 notes 59 pages. The largest timeline (2,000 items) is 374 pages.
- Memory on the devbox stack: the `pdf` container peaked at 258 MiB on a 200-item PDF and 785 MiB with two 700-row PDFs at once; all services' peaks add up to about 2.6 GiB on top of ClamAV's 3 GB allowance. Plan on an 8 GB server; the 4 GB mentioned in the notes plan's follow-ups (P15) is no longer enough.

## Not verified

- Only Chromium is tested.
- On GitHub's runners, until the first push: the workflow step that lets Chromium's sandbox start (`kernel.apparmor_restrict_unprivileged_userns=0`), the blocking vulnerability scan of the new `roadmap-pdf` image (scanned on the devbox as a filesystem, with no fixable high or critical findings), and the `deploy-smoke` job with the new service.
- The committed seccomp profile has not been compared byte for byte with Playwright's own copy.
- Deleting a roadmap at the limits (50 snapshots, each with up to 5,000 notes) inside MongoDB's 60-second transaction limit.
- The 375 px stacked cards rely on Chromium keeping table semantics under `display: block`, as the app's own List does.

## Needed before release

- **Server size:** 8 GB for the POC server (see "Measured").
- **Existing deployments** must add `PROXY_SUBNET` (or keep the default) and get `TRUSTED_PROXY_CIDR` from it, and pull the new `pdf` service; production refuses to start without `PDF=service` and `TRUSTED_PROXY_CIDR`.
- **The ClamAV image, S3 bucket and key, and downloads when S3 returns an error** carried from the notes plan's follow-ups.

## Found and left for later

- A burst of wrong passwords can re-trip the lock, adding extra "link locked" audit events and stretching the lock by seconds; after a burst the count can sit at up to four, so fewer guesses lock the link again. Making a failure do nothing while the link is already locked would fix it (it would change sign-in too).
- A wrong password on a snapshot revoked during the request answers "That password isn't right." instead of "This link doesn't work".
- The link id in logs is redacted, but a percent-encoded path gets past the redaction (invites have the same gap).
- A failing clean-up (the render token's delete, or the stored PDF's delete after a revoke) turns the PDF answer into a server error.
- Two requests at once for the same missing PDF both render it.
- Closing the create dialog while a create is in flight still lets the late success show "Snapshot created" next time.
- In the viewer, the page heading takes focus again on reload or Back; the notes "Loading" text isn't announced; a direct `/s/{id}/list` with no session says "Enter the password again to keep viewing." even to someone who never had it.
- The PDF service: a 10-second context close under heavy load counts as a hang and restarts the service; the footer can split an emoji at its 300-character cut; `chromium.ts` is proven by the browser tests, not counted in coverage.
- Tests: no time-zone changeover day, no boundary cases for the timeline's zoom choice, no count of password checks per unlock, and the timeline's "one page wide" check measures the print page, not the PDF.
- On a phone, the roadmap's section tabs wrap to two rows for Owners and Admins now that "Snapshots" is one of them.

## Needs a product decision

- Whether larger PDFs are worth a bigger `pdf` container (S13), or a denser list layout (a 200-item list with notes is 59 pages).
- Carried from earlier plans: whether archived items may be edited or used as blockers, and whether unarchive should restore items archived on their own before their parent.

## Next plans

1. Notifications (FR-5): reads the mentions stored on notes; per-user instant, digest or off.
2. Calendar feed (FR-4).
3. POC infrastructure (server size, S3 bucket, KMS key, roles, the queue for PDFs), then release hardening.

# v1 Calendar feed: decisions made and work left

This records what was decided while the [Calendar feed plan](2026-11-24-v1-calendar-feed.md) was carried out, and what was found and deliberately left. The plan was run task by task, each task with its own review. Then came one whole-branch review, and one fix pass with its own re-review.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent, or where the plan turned out to be wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| C1 | The work was done in place on `v1-calendar`, with no separate worktree. | Same as the earlier plans. | None. |
| C2 | A saved feed can come back with an empty list of roadmaps. The page then shows "Only these" with nothing ticked and "Choose at least one roadmap.". Saving still needs at least one. | Deleting a roadmap removes it from feeds that chose it, and the plan says the screen says so. | None. |
| C3 | The archived flag on a roadmap leaves that roadmap's items out of the feed, the same as archived items. | The PRD's Roadmap has an `archived` field, and the plan's rule for archived items carries over. | No screen archives a roadmap yet, so this only matters once one does. |
| C4 | The event id's host is the app address's host, port included (`item-…@localhost:5173` in development). | The plan says the app address's host. Production has no port. | Development ids differ from production ids. Harmless. |
| C5 | The delay note ("Calendar apps check for changes every few hours…") also shows on later visits, not only right after the link is made. | People come back to the page when a calendar hasn't updated. | One more line on the page. |
| C6 | The two form errors show as soon as the choices are invalid, not only on Save. | Needed so the C2 state shows its message when the page loads. | None. |
| C7 | "Get a new link" records when the current link was made (`linkCreatedAt`) and clears "last checked". The page's "It was made on…" uses that date. | Before this, the page described the old, revoked link. | Rows made before this change fall back to the feed's first date. |
| C8 | Control characters in titles are turned into line breaks (vertical tab, form feed, Unicode line and paragraph separators) or dropped. Tabs are kept. | Text pasted from Office or PDFs carries them, and a strict calendar app can reject the whole feed. | None. |
| C9 | A slash or backslash in an item's title becomes "-" in the downloaded file's name, on the server and in the browser alike ("iOS/Android launch" becomes "iOS-Android launch.ics"). | Without this the name kept only the part after the last slash. | None. |
| C10 | Cancelled items are left out of "Add to calendar", and the download route refuses them, as the feed does. Archived items are left out too. | The feed and the one-off download should agree. | A person can't add a cancelled item's dates on purpose. |
| C11 | The List's Actions menu is built in `ProjectTree.tsx`, so "Add to calendar" reaches it through a prop. The plan named `menuFor`. | The plan was wrong about the List. | None. |
| C12 | The downloaded file's temporary address is released one second after the click. | Releasing it at once can lose the download in Safari and older Firefox. | None. |
| C13 | A feed over 5,000 dates keeps upcoming dates first, soonest first, then the most recent past ones. A date counts as past once it ended before yesterday in UTC. The calendar's name reads "Roadmap dates (nearest 5,000 dates)". | Your decision after the run: upcoming dates are the ones people subscribe for. The day of slack keeps a date that is still today somewhere from dropping out early. | When cut, the feed changes each day as dates pass, so calendar apps download it again daily. |
| C14 | The delay note now warns that using "Add to calendar" alongside the feed shows the item twice, and that the added copy won't update. | Your decision after the run. | One more sentence on the page. |

Other choices implementers made where the plan gave no value:

- The "Copy link" logic and the unsaved-changes guard moved into shared hooks in `ui/`. The snapshot dialog and the email settings page now use them.
- The settings tabs add a second "Security" link on the settings pages. Two existing tests now click the one in the header.
- A feed's rate-limit counter is keyed by the token's hash, never by the token or the address. The route opts out of the global allow-list so the limit applies.
- Caddy's own `X-Robots-Tag` replaces the API's, so the header appears once, including on 404 and 304.
- The smoke script reads the item's version from the roadmap's item list, since there is no single-item read.

## Measured

- Through Caddy on the devbox: the `api` zone refused 82 of 150 feed fetches from one address before this change and none after. The calendar zone stopped at 600 a minute.

## Not verified

- Only Chromium is tested. The file download has not been tried in Safari or Firefox.
- Real Google, Apple and Outlook subscriptions. The tests parse the feed with `ical.js`, not with the calendar services.
- The CI `deploy-smoke` job with the new feed checks, until the first push.

## Needs your decision

- Carried from earlier plans: an account-level activity log (calendar feed changes are recorded but listed nowhere, as with email settings), and changing one's own time zone.

## Found and left for later

- Every fetch reads whole item documents, descriptions included, and a 304 still builds the whole calendar first. The per-token limit bounds the cost. Later, add a projection to `scoped().find`.
- Malformed tokens each get their own rate-limit counter. Caddy's per-address limit bounds this. Later, give them one shared counter.
- Log shortening matches the literal `/api/calendar/` path, so a percent-encoded path would log the full token. Only someone who already has the token can do this, and snapshot links have the same gap.
- An item in an archived roadmap can still be downloaded on its own.
- After a failed "Get new link" or "Turn off" because the feed was turned off in another tab, the next "Create calendar link" reopens the dialog with the old error.
- Two quick clicks on "Add to calendar" download the file twice.
- Choosing an archived roadmap in the feed's list is accepted, and the feed shows nothing for it.

## Next plans

1. POC infrastructure (server size, S3, KMS, SES with bounce handling and unsubscribe, the queue for PDFs and email).
2. Release hardening.

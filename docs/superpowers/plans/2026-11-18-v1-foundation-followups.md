# v1 Foundation: decisions made and work left

This records what was decided while executing the [v1 Foundation plan](2026-11-18-v1-foundation.md), and what was found and deliberately left. The plan was run task by task, each with its own review, then one whole-branch review and one fix pass.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent or wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| R1 | Work on branch `v1-foundation` in place, with no separate worktree. | The repo was empty. | None. |
| R2 | Tests use an in-memory MongoDB by default and a real container when `TEST_MONGO=container`. CI sets it. Locally, containers run on the devbox through an SSH tunnel. | No Docker daemon on the Mac. | None; both paths run. |
| R3 | The root `test:e2e` script was a no-op until Task 12. | Playwright did not exist before then. | None now. |
| R4 | pnpm is pinned to 9.0.0, not 10. `engines.node` is `>=24`; images use `node:24-alpine`. | 9.0.0 is what is installed, and corepack is absent. | A one-line bump. |
| R5 | The Docker stack was verified on the devbox on ports 18080 and 18443. | The devbox is shared and ports 80 and 443 may be taken. | None. |
| R6 | Every kind of test a task adds is wired into GitHub Actions in that task. | You asked for all tests to run as GitHub Actions. | None. |
| R7 | TTL indexes are exempt from "`tenantId` first in every index". | MongoDB requires TTL indexes to be single-field. | None. |
| R8 | Commit trailers name the model that wrote each commit. | Accurate attribution. | None. |
| R9 | A session upgrade rotates the CSRF token as well as the session token. | A token seen before a privilege change should not outlive it. | None. |
| R10 | In production the API trusts exactly one proxy hop (Caddy). | Trusting every hop lets a client spoof its address. | Safe only while the API port stays unpublished. |
| R11 | `RoadmapDoc.archived` is a boolean, as the plan says. | An earlier task had added `archivedAt` as a placeholder. | None. |
| R12 | A correct password never resets the failed-attempt counter. It resets only when the whole sign-in completes, second factor included. | The rule is five consecutive failures of password or second factor. | A user who mistypes often is locked out sooner. |
| R13 | Re-enrolling the authenticator from a signed-in session requires the current code. | Otherwise a stolen session cookie could replace the second factor. | One extra field. |
| R14 | Audit timestamps use the real clock, not the injectable test clock. | The 30-day expiry index needs real time. | None. |
| R15, R17 | On-screen copy that implementers wrote beyond the UI/UX plan was accepted, with three edits. | Reviewers checked it against the plain-writing rules. | Rewording. The list is below. |
| R16 | Remove member, Remove passkey, Revoke invite and Sign out everywhere are all red and all open a confirm dialog. | The UI/UX plan's rule for destructive buttons has no exceptions. | Two extra clicks. |
| R18 | Wherever the current authenticator code is required, an unused recovery code is accepted too. Adding a passkey also requires one of the two. | Losing the authenticator app was a dead end, and a stolen cookie could add a passkey. | One extra prompt when adding a passkey. |

Other choices implementers made where the plan gave no value:

- Config defaults: the passkey relying-party id defaults to the host of `APP_ORIGIN`; `MAIL_FROM` defaults to `no-reply@<that host>`; `MAILER=file`; `AWS_REGION=us-east-1`; `HIBP_ENABLED=true`; `AUTH_RATE_LIMIT_PER_MIN=10`.
- New error responses: `409 enroll_not_started`, `409 passkey_exists`, `422 invalid_passkey`, `422 no_passkeys`, `409 last_factor`, `409 other_tenant`, `422 already_owner`, `409 conflict`.
- Setting a member to the role they already have returns success and writes no audit entry.
- A password reset deletes the user's other unused reset links.
- An invite can't be accepted by an account in another tenant.
- Removing the only passkey from an account with no authenticator app is refused.

## Copy added beyond the UI/UX plan

- Required-field messages: "Enter your email.", "Enter your password.", "Enter your name.", "Enter a valid email.", "Enter the 6-digit code from your authenticator app.", "Enter a recovery code.", "Use 128 characters or fewer."
- Second step, recovery mode: heading "Enter a recovery code", label "Recovery code", hint "Each recovery code works once.", toggle "Use your authenticator app", error "That recovery code didn't work. Check it and try again."
- Passkeys: "That passkey didn't work. Try again or use another way to sign in.", "This account has no passkeys. Use your authenticator app instead.", "You have no passkeys yet.", "Remove {name}? You can't sign in with it afterwards.", "You can't remove your only passkey. Set up your authenticator app first."
- Step-up prompt: label "6-digit code or recovery code", hint "Use a recovery code if you lost your authenticator app.", button "Continue".
- Sessions: "Too many attempts. Wait a minute and try again.", "Your sign-in has expired. Sign in again.", "Password saved. Sign in with your new password.", "Your session changed. Reload the page and try again.", "Finish signing in first."
- Roadmaps and members: "This roadmap doesn't exist, or you don't have access to it.", "Back to roadmaps", "Invite sent to {email}.", "Invite someone first. Only a member can become the owner.", "You will become an Admin.", "Only Owners and Admins can see the audit log.", "The owner can't be changed here. Transfer ownership instead.", "Someone else changed this at the same time. Reload and try again.", "You already own this roadmap.", "That person isn't a member of this roadmap.", "The name doesn't match.", "This email belongs to a different organization. Ask the person who invited you to use another address."
- Confirm dialogs: "Revoke the invite for {email}? The link stops working.", "Sign out everywhere? This signs you out on every device, including this one."
- Header: "Sign out", "Security". Links: "Back to sign in". Status: "Loading". Fallback: "Something went wrong. Try again."
- Audit log: one sentence per event, such as "Maria changed Bob's role from Contributor to Admin." A person who has left reads "A former member".

## Not verified

- Nobody completed the first-owner setup link in a browser against the Docker stack. The end-to-end tests cover that flow against the dev build.
- Whether CI blocks merges depends on branch protection, which is a repository setting.

## Found and left for later

Security hardening:

- A session upgrade does not clear a pending passkey challenge, so one set during passkey sign-in survives into the full session for up to 5 minutes. Using it needs the challenge value, which only the user's browser has.
- Authenticator-code checks from a signed-in session count no failures; only the per-IP rate limit bounds guessing.
- Someone who knows a passkey's credential id can lock that account with five bogus sign-in attempts.
- The recovery-code second step has no lock re-check after the code is consumed. The authenticator step has one.
- Nothing in lint stops a route from using the raw database handle. No route does today.
- The API connects to MongoDB as the root user in the POC stack, and the root password variable is also passed to the API container.
- Transfer and delete rely on transaction write conflicts, not explicit checks, to stay correct under concurrency.
- Two different unused reset links confirmed at the same moment both succeed.

Behaviour and usability:

- The step-up code is spent before the browser's passkey prompt, so a cancelled prompt costs a fresh code. The code form has no Cancel.
- A half-signed-in session that opens an invite link after a reload sees a CSRF message.
- The empty-field message on the step-up prompt mentions only the 6-digit code.
- The default passkey name repeats after a removal ("Passkey 2" twice).
- Audit rows about someone who has left read "a former member", because the audit API does not return target names.
- Account events with no roadmap (sign-ins, password resets, passkey changes) are recorded but have no screen.
- A failed email send after an invite is saved returns an error with the invite left open. Inviting again recovers.
- Invites to an archived roadmap still work. Nothing in this plan can archive a roadmap; decide in the projects plan.
- A whole office behind one address shares the 10-per-minute sign-in limit.

Operations:

- The API does not handle SIGTERM, so a container stop waits out the kill timeout.
- The health check logs a request about every 5 seconds.
- Image tags float (`mongo:8.0`, `caddy:2-*`, `node:24-alpine`), and the pnpm version is repeated in both Dockerfiles.
- The http to https redirect ignores a remapped `HTTPS_PORT`. The smoke script always skips certificate checks.
- `otplib` 12 pulls in sub-packages marked deprecated in favour of version 13.
- The root `.env.example` holds only `PORT`, and there is no README for running locally.
- `MAILER=file` is the POC default, so no email leaves the box until SES is configured.
- Two images remain on the devbox: `roadmap-api:poc` and `roadmap-caddy:poc`.

Tests:

- Add a state-machine test that walks every route from every session state and asserts which can reach a full session. It would have caught the two sign-in defects the whole-branch review found.
- Some test names lack the FR or section id the definition of done asks for.
- The mobile no-horizontal-scroll check does not cover the QR, recovery-code or multi-member states.
- The dialog focus-trap assertion can pass by wrap-around.

## Next plans

As listed at the end of the Foundation plan: projects and views, snapshots and PDF, calendar feed, notifications, POC infrastructure, and release hardening.

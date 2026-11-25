# v1 POC infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Compose stack deployable to one AWS server from a button in GitHub Actions. Everything the server needs is in Terraform, and email has bounce handling and one-click unsubscribe.

**Architecture:** Terraform (`deploy/poc/terraform/`) creates a VPC with one public subnet and a t4g.large Amazon Linux 2023 server with a separate encrypted data volume for MongoDB. It also creates one KMS key, S3 buckets for files, backups and releases, ECR repositories, SSM parameters for settings and secrets, SES with an SNS → SQS path for bounce and complaint events, daily EBS snapshots, and a GitHub OIDC role. A manual workflow builds ARM images on GitHub's ARM runners, pushes them to ECR and uploads `deploy/poc/` as a release bundle. It then tells the server over SSM Run Command to run `deploy/poc/host/deploy`, which writes the env files from SSM, pulls and starts the stack, and rolls back if the new release isn't healthy. On the app side, the worker gets its own trimmed settings and reads SES events from SQS. Emails carry a signed one-click unsubscribe link, and the API and worker connect to MongoDB as an app user, not root.

**Tech Stack:** Terraform ≥ 1.11 (write-only arguments), hashicorp/aws ~> 6.0, hashicorp/random ~> 3.7 (ephemeral `random_password`), tflint with the AWS ruleset, Trivy config scan, bash host scripts tested with bats-core and checked with shellcheck, systemd timers, `@aws-sdk/client-sqs` (same major version as the existing `@aws-sdk/*` packages), GitHub Actions `ubuntu-24.04-arm` runners, `aws-actions/configure-aws-credentials` with OIDC.

**Spec:** `docs/prd.md`, mainly "Security and non-functional requirements" (Data protection, Application security, Non-functional targets) and "Architecture and tech stack" → "POC: single EC2 instance" and "Moving from POC to production". The follow-ups docs of the earlier plans list what this plan owes ("Needed before release"): `2026-11-21-v1-notes-mentions-attachments-followups.md`, `2026-11-22-v1-snapshots-pdf-followups.md`, `2026-11-23-v1-notifications-followups.md`.

## Decisions taken before writing

The user chose these on 2026-11-25:

- **Server:** t4g.large (2 vCPU, 8 GB), not the PRD's t4g.medium. The measured peaks are about 2.5 GiB, and up to 4.5 GiB when ClamAV and Chromium both reach their limits.
- **Queue:** one SQS queue, for SES bounce and complaint events only, read by the worker. PDFs stay a direct call to the PDF service, and email jobs stay in the MongoDB outbox. Moving those to SQS waits for the Fargate move.
- **Scope:** this plan writes the Terraform and tests it in GitHub Actions without touching AWS. The user applies it by following the runbook (Task 9). No task runs `terraform apply`, `plan` against AWS, or any AWS API call.
- **Deploys:** a manual `workflow_dispatch` workflow. Nothing deploys on merge.

Decided here, where the PRD and the user were silent:

- **D1. Secrets never enter Terraform state.** Secret SSM parameters are SecureStrings set with `value_wo`/`value_wo_version` from ephemeral `random_password` values. Changing `value_wo_version` rotates a secret. The runbook warns that rotating `totp-enc-key` makes every enrolled authenticator unreadable, so it is never rotated.
- **D2. Settings live in SSM Parameter Store under `/roadmap/poc/`.** Secrets are SecureString, the rest are String. The server reads them at every deploy, so changing a setting means `terraform apply` and then a deploy. User data never holds settings.
- **D3. The server's own files come from the release bundle, not from user data.** User data only installs Docker and the Compose plugin, mounts the data volume and creates `/opt/roadmap`. The first deploy installs the host scripts and systemd units, and every later deploy updates them.
- **D4. IMDSv2 required, hop limit 2.** The API and worker containers take the instance role's credentials through IMDS, and Docker's bridge adds a hop. The PDF service's networks are internal, so it can't reach IMDS.
- **D5. Downloads keep navigating to the signed S3 link (P13 stays).** The Terraform gives the server's role exactly the S3 and KMS rights the API uses, and the deploy check fetches a real download. That makes an S3 error page a configuration fault caught at deploy, not something users meet.
- **D6. The API and worker connect to MongoDB as `roadmap_app`** (readWrite on `MONGO_DB` only). Root credentials stay in the `mongo` service and the backup script.
- **D7. No CloudWatch, alarms or WAF in this plan.** The PRD puts the WAF outside the POC, and alerts and tracing belong to release hardening.

## Global Constraints

- Every AWS resource is tagged `Project = "roadmap"` and `Environment = "poc"` (provider `default_tags`). Names start with `roadmap-poc`.
- Region is a variable, default `us-east-1`.
- "Only ports 80 and 443 open to the internet": the security group's ingress is exactly TCP 80 and TCP 443, each from `0.0.0.0/0` and `::/0` (four `aws_vpc_security_group_ingress_rule` resources and nothing else). There is no port 22, no key pair, and admin access goes through SSM Session Manager.
- "IMDSv2 required, EBS encrypted, secrets in SSM Parameter Store."
- "Nightly mongodump to S3 and daily EBS snapshots through Data Lifecycle Manager." Both are kept 14 days ("Backups: Daily, kept for 14 days").
- "Automatic OS security patching (Amazon Linux 2023)."
- "TLS 1.2 or later everywhere, with HSTS." "Data is encrypted at rest in … S3 and backups using keys managed by AWS KMS." One customer-managed KMS key with rotation on encrypts the EBS volumes, the S3 buckets, the SNS topic, the SQS queues and the SSM SecureStrings.
- "GitHub Actions with OIDC to AWS (no long-lived keys)." No AWS access key appears anywhere: not in the repo, not in GitHub secrets, not on the server.
- "Requirement from the start: all configuration comes from environment variables, and nothing except the database writes to local disk."
- Every S3 bucket blocks all public access, enforces bucket-owner ownership, denies non-TLS requests, and has KMS default encryption with a bucket key.
- Pinned versions: GitHub Actions are pinned to a full commit SHA with the tag in a comment, as `ci.yml` already does. The Terraform CLI, tflint, its AWS ruleset, bats-core and the Docker Compose plugin are pinned to an exact release at least two weeks old, which the implementer looks up (`gh release view -R <owner>/<repo>`). The Compose plugin download is checked against its published SHA-256.
- Existing CI checks stay green, and the new `terraform` and `host-scripts` jobs join them. `deploy-smoke` keeps running the stack from the base Compose file plus the smoke override.
- Tests carry the requirement they prove in the name: `FR-5.x` for email behaviour, `NFR` with the PRD line (for example `NFR backups 14 days`) for infrastructure.
- UI and email copy follow the plain-writing rules of the earlier plans and is exactly as in the copy table below.
- Plans and commits end with the project's trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Copy

| Where | Text |
| --- | --- |
| Email footer, second line (after the existing settings line) | "Turn off these emails:" followed by the unsubscribe page link |
| Unsubscribe page heading | "Turn off notification emails" |
| Unsubscribe page body | "This turns off every notification email. You'll still see notifications in the app." |
| Unsubscribe page button | "Turn off emails" |
| Unsubscribe page, done (role status) | "Emails are off. You can turn them back on in your notification settings." |
| Unsubscribe page, bad or old link (role alert) | "This link doesn't work. You can change your emails in your notification settings." |
| "notification settings" in both lines above | a link to `/settings/notifications` |
| Notification settings, address bounced | "Emails to {email} bounced, so we stopped sending them." |
| Notification settings, marked as spam | "One of our emails was marked as spam, so we stopped sending them." |
| Notification settings, button under either line | "Send emails again" |
| Notification settings, after the button works (role status) | "Emails are on again." |
| Notification settings, button failed (role alert) | "Couldn't turn emails back on. Try again." |

## Review Focus

1. **The server restarts (patch reboot, hardware move) and the data volume isn't mounted.** MongoDB must never start on an empty folder on the root disk. Docker waits for `/srv/mongo` (`RequiresMountsFor`), the fstab entry has no `nofail`, and `deploy` refuses to run when `/srv/mongo` isn't a mount point. Test: Task 5's bats test for `deploy` without a mount.
2. **A release whose containers never get healthy.** The previous release must come back up, and the workflow must fail. Test: Task 5's bats rollback test.
3. **The backup runs while MongoDB is down or the dump fails part-way.** No object may reach S3 for that night, and the timer unit must fail so it shows in `systemctl --failed`. The dump goes to a file first, and only a complete dump is uploaded. Test: Task 5's bats test with a failing `docker`.
4. **SES events the worker didn't expect.** Transient bounces, malformed bodies, unknown addresses and SNS subscription notices must all leave users unchanged and delete the message. The same address in two tenants is blocked in both. Test: Task 3's event-handling tests.
5. **A mail scanner fetching the unsubscribe link.** A GET (the link in the footer) must never turn emails off; only the page's button, or a mail client's one-click POST, does. A token for a deleted user answers like a bad token. Test: Task 2's API and web tests.

---

## File structure

```
apps/api/src/
  config.ts                    loadConfig (API) and loadWorkerConfig (worker), sharing one base schema
  worker.ts                    uses loadWorkerConfig; adds the SES events step's client
  mail/mailer.ts               MailMessage.headers; SES configuration set
  mail/unsubscribe.ts          NEW: signUnsubscribe / verifyUnsubscribe
  notifications/unsubscribe-routes.ts   NEW: POST /api/email/unsubscribe
  notifications/routes.ts      prefs GET shows emailBlocked; POST /api/me/notification-prefs/resume
  worker/ses-events.ts         NEW: the SQS step
  worker/run.ts                runs the new step
  worker/emails.ts             footer and List-Unsubscribe headers
  worker/instant.ts, digest.ts skip a blocked address
  logging.ts                   redacts the unsubscribe token
apps/web/src/
  email/UnsubscribePage.tsx    NEW: /unsubscribe
  settings/NotificationSettingsPage.tsx   the blocked notice and "Send emails again"
packages/shared/src/notifications.ts      emailBlocked in the prefs response
deploy/poc/
  docker-compose.yml           own env files for api and worker; app Mongo user; clamav image built here
  docker-compose.aws.yml       NEW: ECR images, server paths, no builds
  mongo-init/create-app-user.js NEW
  clamav.Dockerfile            NEW
  api.env.example, worker.env.example   replace .env.example
  host/                        NEW: render-env, deploy, backup-mongo, restore-mongo, env-map, systemd/*, test/*.bats
  terraform/                   NEW: see Tasks 6–8
  README.md                    NEW: the runbook
.github/workflows/ci.yml       terraform and host-scripts jobs; deploy-smoke changes
.github/workflows/deploy-poc.yml   NEW
scripts/post-deploy-check.sh   NEW: read-only checks against the live site
```

---

### Task 1: The worker gets its own settings, and the app connects to MongoDB as `roadmap_app`

Closes "The worker holds every API secret" (notifications follow-ups) and D6.

**Files:**
- Modify: `apps/api/src/config.ts`, `apps/api/src/worker.ts`, `deploy/poc/docker-compose.yml`, `deploy/poc/docker-compose.smoke.yml`, `.github/workflows/ci.yml` (deploy-smoke's "Write a throwaway .env" step)
- Create: `deploy/poc/mongo-init/create-app-user.js`, `deploy/poc/api.env.example`, `deploy/poc/worker.env.example`
- Delete: `deploy/poc/.env.example` (its comments move into the two new examples and a short `compose.env` section in `api.env.example`'s header)
- Test: `apps/api/test/config.test.ts`

**Interfaces:**
- Produces: `loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig`, where `WorkerConfig = Pick<Config, 'nodeEnv' | 'mongoUri' | 'mongoDb' | 'appOrigin' | 'mailer' | 'mailFrom' | 'mailOutboxFile' | 'awsRegion' | 'workerIntervalMs' | 'workerHeartbeatFile'>`. Tasks 2 and 3 add fields to both `Config` and `WorkerConfig`.
- Produces: the Compose variables `API_ENV_FILE` and `WORKER_ENV_FILE` (default `api.env` and `worker.env`, beside the Compose file) and `MONGO_APP_PASSWORD` (Compose interpolation, read by the mongo init script). Task 5's `render-env` writes these files.

- [ ] **Step 1: Write the failing tests in `apps/api/test/config.test.ts`**
  - `loadWorkerConfig` loads with only the worker's settings in production (`NODE_ENV=production`, `MONGO_URI`, `MONGO_DB`, `APP_ORIGIN`, `MAILER=ses`, `MAIL_FROM`, `AWS_REGION`), with no `TOTP_ENC_KEY`, `S3_BUCKET`, `PDF`, `SCANNER` or `TRUSTED_PROXY_CIDR`.
  - `loadWorkerConfig` rejects a missing `MONGO_URI` and a missing `APP_ORIGIN` with `ConfigError`.
  - `loadWorkerConfig`'s result has no `totpEncKey`, `s3Bucket` or `trustedProxyCidrs` key (`expect(Object.keys(cfg)).not.toContain('totpEncKey')`, and so on).
  - `loadConfig` behaves exactly as before. Existing tests unchanged.
- [ ] **Step 2: Run them and see them fail.** Run: `pnpm --filter ./apps/api exec vitest run test/config.test.ts`. Expected: FAIL, `loadWorkerConfig` is not exported.
- [ ] **Step 3: Implement `loadWorkerConfig` in `config.ts`** by picking the worker's fields from the existing zod schema (one base schema, two `.pick`s or an extend). Keep the production rules that apply to those fields, such as `MAILER=ses` in production if `loadConfig` has that rule. Point `worker.ts` at it.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Split the Compose environment.**
  - `api` uses `env_file: ${API_ENV_FILE:-api.env}`.
  - `worker` uses `env_file: ${WORKER_ENV_FILE:-worker.env}` and its own `environment:` block (no `FILES`, `S3_BUCKET`, `SCANNER`, `CLAMD_HOST`, `PDF*` or `TRUSTED_PROXY_CIDR`). Remove the `&api-environment` anchor's use for the worker, and update the comments that say the worker needs the API's settings.
  - `mongo` gets `MONGO_APP_PASSWORD: ${MONGO_APP_PASSWORD:?set MONGO_APP_PASSWORD}` and `MONGO_DB: ${MONGO_DB:-roadmap}`, and mounts `./mongo-init:/docker-entrypoint-initdb.d:ro`.
- [ ] **Step 6: Write `mongo-init/create-app-user.js`.** On the database named by `process.env.MONGO_DB`, it creates the user `roadmap_app` with password `process.env.MONGO_APP_PASSWORD` and role `readWrite` on that database only, and throws if either variable is empty. It runs only on a fresh data folder, which the comment says.
- [ ] **Step 7: Write `api.env.example` and `worker.env.example`.** Both take `MONGO_URI=mongodb://roadmap_app:change-me-app-password@mongo:27017/roadmap?replicaSet=rs0&authSource=roadmap`. Comments carry over from the old `.env.example`, each to the file it concerns. The Compose-level variables (`DOMAIN`, `S3_BUCKET`, `MONGO_INITDB_ROOT_*`, `MONGO_APP_PASSWORD`, `PROXY_SUBNET`, the ports) are listed in a header comment of `api.env.example` as going in `deploy/poc/.env`, which Compose reads for interpolation.
- [ ] **Step 8: Update CI's deploy-smoke.** It writes three throwaway files (`.env` for interpolation, `api.env`, `worker.env`) with generated passwords, and the API and worker use the `roadmap_app` URI. Add a smoke step that proves D6: `$COMPOSE exec -T api node -e` connects with the API's own `MONGO_URI`, runs `db.admin().command({ listDatabases: 1 })`, and the step expects it to fail with an authorization error.
- [ ] **Step 9: Run lint, typecheck and the API tests.** Run: `pnpm lint && pnpm typecheck && pnpm --filter ./apps/api exec vitest run`. Expected: all pass. The Compose change is proven by `deploy-smoke` on the first push (Docker is not on the Mac, N5).
- [ ] **Step 10: Commit.** `feat(deploy): the worker gets its own settings and the app connects as roadmap_app`

---

### Task 2: One-click unsubscribe (RFC 8058)

**Files:**
- Create: `apps/api/src/mail/unsubscribe.ts`, `apps/api/src/notifications/unsubscribe-routes.ts`, `apps/web/src/email/UnsubscribePage.tsx`, `apps/web/src/email/UnsubscribePage.test.tsx`, `apps/api/test/notifications/unsubscribe.test.ts`
- Modify: `apps/api/src/config.ts` (`UNSUBSCRIBE_KEY`, both loaders), `apps/api/src/mail/mailer.ts`, `apps/api/src/worker/emails.ts`, `apps/api/src/worker/instant.ts`, `apps/api/src/worker/digest.ts`, `apps/api/src/app.ts` (register the route), `apps/api/src/logging.ts`, `packages/shared/src/schemas.ts` (`AUDIT_ACTIONS` gets `'user.unsubscribed'`), `apps/web/src/App.tsx`, both env examples, CI's throwaway env files, `scripts/smoke.sh`
- Test: the files above plus `apps/api/test/worker/*.test.ts` and `apps/api/test/mail/*.test.ts`, wherever the existing email and mailer tests live

**Interfaces:**
- Produces: `signUnsubscribe(key: Buffer, tenantId: string, userId: string): string` and `verifyUnsubscribe(key: Buffer, token: string): { tenantId: string; userId: string } | null`. The token is `${tenantId}.${userId}.${sig}`, where `sig` is base64url HMAC-SHA256 over `unsubscribe:${tenantId}:${userId}`, compared with `timingSafeEqual`. It never expires.
- Produces: `Config.unsubscribeKey: Buffer` and `WorkerConfig.unsubscribeKey: Buffer` from `UNSUBSCRIBE_KEY` (the `key32` rule: base64 of exactly 32 bytes). Required in every environment. Tests use a fixed key.
- Produces: `MailMessage.headers?: Record<string, string>`. `SesMailer` sends them as `Content.Simple.Headers` (`[{ Name, Value }]`), and `FileMailer`/`MemoryMailer` keep them, so tests and the smoke script can read them.
- Produces: `POST /api/email/unsubscribe?t={token}`, `auth: { level: 'public' }`. It accepts `application/x-www-form-urlencoded` (a mail client sends `List-Unsubscribe=One-Click`) or an empty body, through a content-type parser registered only in this route's plugin that ignores the body. Rate limit: 30 a minute per address.

- [ ] **Step 1: Write the failing unit tests for the token** (`apps/api/test/mail/unsubscribe.test.ts`): a signed token verifies to its ids; a token with one character changed, with three parts but a wrong signature, with two parts, or empty returns `null`; a token signed with another key returns `null`.
- [ ] **Step 2: Write the failing API tests** (`apps/api/test/notifications/unsubscribe.test.ts`):
  - `FR-5: POST with a valid token and body List-Unsubscribe=One-Click sets all four prefs to off and answers 200 with an empty body`. Read the prefs back through `GET /api/me/notification-prefs` as that user.
  - `FR-5: an audit event user.unsubscribed is recorded with before and after prefs, actor { type: 'user', userId }`.
  - `FR-5: a GET to the same URL changes nothing` (Fastify answers 404 for the method, and the prefs are unchanged).
  - `FR-5: a bad token, another key's token, and a token for a deleted user all answer 404 with an empty body`.
  - `FR-5: a second POST answers 200 again and records no second audit event` (nothing changed).
  - `FR-5: the 31st POST in a minute from one address is 429`.
  - `FR-5: the request log shows /api/email/unsubscribe?t=[redacted]`. Extend the existing `redactUrl` tests with an `UNSUBSCRIBE_TOKEN` pattern, matched as the three earlier ones are.
- [ ] **Step 3: Write the failing email tests.** Every instant and digest email:
  - has `headers['List-Unsubscribe']` equal to `<${appOrigin}/api/email/unsubscribe?t=${token}>`;
  - has `headers['List-Unsubscribe-Post']` equal to `List-Unsubscribe=One-Click`;
  - has a text footer whose second line is `Turn off these emails: ${appOrigin}/unsubscribe?t=${token}`, and an HTML footer with the same link.
  The token verifies to the recipient's tenant and user. `SesMailer` passes the headers in `Content.Simple.Headers` (assert on the command sent to a fake `SesLikeClient`).
- [ ] **Step 4: Run them and see them fail.** Run: `pnpm --filter ./apps/api exec vitest run test/mail test/notifications/unsubscribe.test.ts test/worker`. Expected: FAIL.
- [ ] **Step 5: Implement.** `instantEmail` and `digestEmail` take the recipient's unsubscribe token in their options, and `instant.ts`/`digest.ts` sign it with `deps.unsubscribeKey` (add it to `WorkerDeps`). The route's handler, in one transaction: verify the token, find the user in `scoped(db, tenantId)`, and if any pref isn't `off`, set all four to `off` and record `user.unsubscribed`.
- [ ] **Step 6: Write the failing web test** (`UnsubscribePage.test.tsx`, route `/unsubscribe`): it shows the heading, body and button from the copy table. Clicking the button POSTs once to `/api/email/unsubscribe?t=<the page's t>` and shows the done text with `role="status"`. A 404 shows the bad-link text with `role="alert"`, and so does a page with no `t`, without calling the API. Loading the page makes no request. The "notification settings" words link to `/settings/notifications`. Add an axe check as the other page tests do.
- [ ] **Step 7: Implement `UnsubscribePage`** as a public route in `App.tsx`, outside the signed-in layout, as the snapshot viewer is.
- [ ] **Step 8: Run the tests and see them pass.** Run: `pnpm --filter ./apps/web exec vitest run src/email && pnpm --filter ./apps/api exec vitest run`. Expected: PASS.
- [ ] **Step 9: Smoke.** In `scripts/smoke.sh`, after the assignment email arrives in the outbox, read its `List-Unsubscribe` URL, POST `List-Unsubscribe=One-Click` to it through Caddy, and expect 200 and the member's prefs all `off`.
- [ ] **Step 10: Run lint and typecheck, then commit.** `feat(email): one-click unsubscribe in every notification email (FR-5)`

---

### Task 3: SES bounce and complaint events

**Files:**
- Create: `apps/api/src/worker/ses-events.ts`, `apps/api/test/worker/ses-events.test.ts`
- Modify: `apps/api/package.json` (`@aws-sdk/client-sqs`), `apps/api/src/config.ts` (`SES_CONFIGURATION_SET`, `SES_EVENTS_QUEUE_URL`), `apps/api/src/mail/mailer.ts`, `apps/api/src/worker.ts`, `apps/api/src/worker/run.ts`, `apps/api/src/worker/instant.ts`, `apps/api/src/worker/digest.ts`, `apps/api/src/db/types.ts` (`UserDoc.emailBlocked`), `apps/api/src/db/worker-db.ts`, `apps/api/src/notifications/routes.ts`, `packages/shared/src/notifications.ts`, `packages/shared/src/schemas.ts` (`AUDIT_ACTIONS` gets `'user.email_blocked'` and `'user.email_resumed'`), `apps/web/src/settings/NotificationSettingsPage.tsx`, `apps/web/src/settings/useNotificationPrefs.ts`, both env examples
- Test: the new test file, `apps/api/test/notifications/*.test.ts`, `apps/web/src/settings/NotificationSettingsPage.test.tsx`

**Interfaces:**
- Produces: `UserDoc.emailBlocked?: { reason: 'bounced' | 'complained'; at: Date }`.
- Produces: `Config.sesConfigurationSet?: string` (API and worker) and `WorkerConfig.sesEventsQueueUrl?: string`. When `MAILER=ses`, `SesMailer` sends with `ConfigurationSetName`. When the queue URL is unset, the step does nothing, as in development and tests.
- Produces: `interface SqsLikeClient { send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown> }` and `sesEventsStep(deps: WorkerDeps): Promise<{ blocked: number; ignored: number }>`. `WorkerDeps` gets `sqs?: SqsLikeClient` and `sesEventsQueueUrl?: string`. `PassCounts` gets `blocked` and `ignored`.
- Produces: `prefsResponseSchema` gains `emailBlocked: z.object({ reason: z.enum(['bounced', 'complained']), email: z.string() }).nullable()`. And `POST /api/me/notification-prefs/resume` (full session, CSRF) clears `emailBlocked`, removes the address from the SES account suppression list (`DeleteSuppressedDestinationCommand`; `NotFoundException` counts as success; skipped when `MAILER` isn't `ses`), records `user.email_resumed`, and answers the prefs response.

- [ ] **Step 1: Write the failing worker tests** (`ses-events.test.ts`, fake SQS client, real MongoDB as the other worker tests use). Message bodies are SES event JSON as SNS raw delivery sends it.
  - `FR-5: a Permanent bounce blocks every user with that address, in every tenant, with reason bounced, and deletes the message`. Seed the same address in two tenants; the match is case-insensitive.
  - `FR-5: a Complaint blocks with reason complained`.
  - `FR-5: a Transient bounce, a Delivery event, a body that isn't JSON, an address nobody has, and an SNS SubscriptionConfirmation body change no user and delete the message`. Count them as `ignored`.
  - `FR-5: a user already blocked keeps the first reason and date`.
  - `FR-5: each new block records user.email_blocked with actor { type: 'system' }`.
  - `FR-5: a failed delete is logged, the step goes on, and the message is handled again harmlessly on its next delivery`.
  - `FR-5: the step reads at most 10 batches of 10 per pass` (with 150 waiting it handles 100). It uses `WaitTimeSeconds: 0`, so a pass never waits on an empty queue.
- [ ] **Step 2: Write the failing skip tests.**
  - `FR-5: an instant notification for a blocked user is skipped, not sent, and not retried`, as `mode === 'off'` is today.
  - `FR-5: a blocked user's digest rows are skipped and no digest is sent`.
  - `FR-5: account emails (invites, password reset) still go to a blocked address`. SES's suppression list is the guard for those.
- [ ] **Step 3: Write the failing route tests.**
  - `GET /api/me/notification-prefs` returns `emailBlocked: { reason, email }`, or `null`.
  - `POST /api/me/notification-prefs/resume` clears the block, calls the fake SES client's `DeleteSuppressedDestination` once with the address, treats `NotFoundException` as success, records `user.email_resumed`, and needs CSRF.
  - When SES fails with any other error, the route answers 502 `ses_failed` and the block stays.
- [ ] **Step 4: Run them and see them fail.** Run: `pnpm --filter ./apps/api exec vitest run test/worker test/notifications`. Expected: FAIL.
- [ ] **Step 5: Implement.** The cross-tenant user lookup and update by address goes in `worker-db.ts`, beside the other cross-tenant queries, using a case-insensitive collation (`{ locale: 'en', strength: 2 }`). `runPass` runs the step first, so a bounce stops the same pass's sends. `worker.ts` builds a real `SQSClient` with the same timeouts as `SES_TIMEOUTS` only when the queue URL is set.
- [ ] **Step 6: Write the failing web test, then implement.** With `emailBlocked` set, the settings page shows the bounced or spam line from the copy table above the radios, with the "Send emails again" button. A successful click shows "Emails are on again." (status) and removes the line. A failure shows the error (alert) and keeps it. Add an axe check.
- [ ] **Step 7: Run all tests, lint and typecheck.** Run: `pnpm lint && pnpm typecheck && pnpm run test`. Expected: all pass.
- [ ] **Step 8: Commit.** `feat(email): bounces and complaints stop notification emails (FR-5)`

---

### Task 4: Our own ClamAV image

Closes "A fixable high-severity flaw in the ClamAV image" (notes follow-ups).

**Files:**
- Create: `deploy/poc/clamav.Dockerfile`
- Modify: `deploy/poc/docker-compose.yml` (the `clamav` service gets `build:` and `image: roadmap-clamav:poc`), `.github/workflows/ci.yml` (deploy-smoke builds four images, and the ClamAV scan becomes a gate like the other three)

- [ ] **Step 1: Write `clamav.Dockerfile`:** `FROM clamav/clamav:1.4.7` pinned by digest, then the base distribution's package upgrade of the XML library and nothing else. The implementer checks which distribution the image uses (`docker run --rm --entrypoint cat clamav/clamav:1.4.7 /etc/os-release`) and that the image has a `linux/arm64` variant (`docker buildx imagetools inspect clamav/clamav:1.4.7`). If it has no arm64 variant, stop and report BLOCKED: the server is ARM.
- [ ] **Step 2: Gate it in CI.** Remove the "upstream image, not a gate" step and scan `roadmap-clamav:poc` with the same Trivy settings as the other images (fixable HIGH/CRITICAL fail the job).
- [ ] **Step 3: Prove it on the devbox before committing.** Build it there and run Trivy on it with the CI settings. Expected: no fixable HIGH or CRITICAL finding, and `clamdcheck.sh` healthy within the start period when started with the stack. The devbox is the Docker host (`DOCKER_HOST=tcp://127.0.0.1:23750`): touch only `roadmap-*` resources, never prune, never use ports 80 or 443, never mount the Docker socket, and remove what you made.
- [ ] **Step 4: Commit.** `build(deploy): our own ClamAV image with the XML library upgraded`

---

### Task 5: Host scripts, the AWS Compose override, and backups

**Files:**
- Create: `deploy/poc/docker-compose.aws.yml`, `deploy/poc/host/env-map`, `deploy/poc/host/render-env`, `deploy/poc/host/deploy`, `deploy/poc/host/backup-mongo`, `deploy/poc/host/restore-mongo`, `deploy/poc/host/systemd/roadmap-backup.service`, `roadmap-backup.timer`, `roadmap-patch.service`, `roadmap-patch.timer`, `docker-wait-for-data.conf` (a drop-in for `docker.service`), `deploy/poc/host/test/*.bats`, `deploy/poc/host/test/stubs/` (fake `aws`, `docker`, `mountpoint`, `systemctl` on `PATH`)
- Modify: `.github/workflows/ci.yml` (a new `host-scripts` job, and backup and restore steps in deploy-smoke)

**Interfaces:**
- Consumes: Task 1's `API_ENV_FILE`, `WORKER_ENV_FILE` and `MONGO_APP_PASSWORD`, and Task 6's SSM names below.
- Produces: the SSM parameter names under `/roadmap/poc/`, which Task 6 creates. Secrets (SecureString): `mongo-root-password`, `mongo-app-password`, `totp-enc-key`, `unsubscribe-key`. Settings (String): `domain`, `app-origin`, `mail-from`, `aws-region`, `s3-bucket`, `backup-bucket`, `registry`, `ses-configuration-set`, `ses-events-queue-url`.
- Produces: `env-map`, one line per variable: `<file> <VARIABLE> <parameter name | literal:value>`. `<file>` is `compose`, `api` or `worker`. Literals cover the fixed values (`NODE_ENV=production`, `MAILER=ses`, `HIBP_ENABLED=true`, `MONGO_DB=roadmap`, `MONGO_DATA=/srv/mongo`). The two `MONGO_URI`s are built in `render-env` from `mongo-app-password`, URL-encoded.
- Produces: `deploy <release>`, run as root from `/opt/roadmap/releases/<release>/deploy/poc/host/deploy`. It exits 0 when the release is up and healthy, 1 when it rolled back (and says so), and 2 when it never touched the running stack.

Paths on the server: `/opt/roadmap/releases/<release>/` (unpacked bundles, the newest 5 kept), `/opt/roadmap/current` (a file holding the running release), `/run/roadmap/{compose,api,worker}.env` (root, 0600), `/srv/mongo` (the data volume), `/srv/mongo-backup` (a folder on the data volume for the dump in progress).

- [ ] **Step 1: Write `docker-compose.aws.yml`.**
  - Each of `api`, `worker`, `pdf`, `caddy` and `clamav` gets `image: ${REGISTRY}/roadmap-<name>:${RELEASE}` and `pull_policy: always`.
  - `api` and `worker` take `env_file` from `/run/roadmap/api.env` and `/run/roadmap/worker.env`.
  - The API's `environment:` sets `SES_CONFIGURATION_SET` from interpolation; the worker's sets that and `SES_EVENTS_QUEUE_URL`.
  - The deploy runs it as `docker compose -p roadmap-poc -f docker-compose.yml -f docker-compose.aws.yml --env-file /run/roadmap/compose.env` with `up --no-build`.
- [ ] **Step 2: Write the failing bats tests** (`deploy/poc/host/test/`):
  - `render-env` writes the three files with mode 0600 and the values from the stubbed `aws ssm get-parameters-by-path --path /roadmap/poc/ --with-decryption --recursive`. A password with `@`, `/` and `%` is URL-encoded in `MONGO_URI`.
  - `render-env` with one parameter missing exits non-zero, names the parameter, and leaves any existing files untouched (it writes temporary files and moves them into place only when all three are complete).
  - `deploy` exits 2 without starting anything when `/srv/mongo` isn't a mount point (stubbed `mountpoint -q` fails), when `render-env` fails, or when ECR sign-in fails.
  - `deploy` on success records the release in `/opt/roadmap/current`, installs the systemd units and runs `systemctl daemon-reload` and `enable --now` for both timers, and keeps only the newest 5 release folders.
  - `deploy` when `up --wait` fails runs `up` again with the previous release's folder and `RELEASE`, leaves `current` unchanged, and exits 1. With no previous release it exits 1 and leaves the failed stack for inspection.
  - `backup-mongo` runs `mongodump --archive --gzip` inside the `mongo` container as root to `/srv/mongo-backup/<UTC date>.archive.gz`. It uploads to `s3://<backup-bucket>/mongo/<UTC date>.archive.gz` with `--sse aws:kms`, removes the local file, and exits 0.
  - `backup-mongo` when the dump fails part-way uploads nothing, removes the partial file, and exits non-zero.
  - `restore-mongo <date>` downloads that object and runs `mongorestore --archive --gzip --drop` into the running `mongo`. It refuses without a date argument.
- [ ] **Step 3: Run them and see them fail.** Run: `bats deploy/poc/host/test`. Expected: FAIL, the scripts don't exist.
- [ ] **Step 4: Write the scripts.** They use `#!/usr/bin/env bash`, `set -euo pipefail`, no `eval`, and read settings only from SSM or `/run/roadmap/compose.env`. ECR sign-in is `aws ecr get-login-password | docker login --username AWS --password-stdin <registry>`. `up --wait --wait-timeout 600`, because ClamAV's first signature load can take 6 minutes.
- [ ] **Step 5: Write the systemd units.**
  - `roadmap-backup.timer`: `OnCalendar=*-*-* 03:00:00 UTC`, `Persistent=true`.
  - `roadmap-patch.timer`: `OnCalendar=*-*-* 04:00:00 UTC`. Its service runs `dnf -y upgrade --security --releasever=latest` and then `dnf needs-restarting -r || systemctl reboot`.
  - The `docker.service` drop-in: `RequiresMountsFor=/srv/mongo`.
- [ ] **Step 6: Run the bats tests and shellcheck.** Run: `bats deploy/poc/host/test && shellcheck deploy/poc/host/render-env deploy/poc/host/deploy deploy/poc/host/backup-mongo deploy/poc/host/restore-mongo`. Expected: all pass, no findings.
- [ ] **Step 7: Add the CI job `host-scripts`** on `ubuntu-latest`. It installs pinned bats-core, runs the tests and shellcheck, and runs `docker compose -f deploy/poc/docker-compose.yml -f deploy/poc/docker-compose.aws.yml config --quiet` with placeholder variables, so a broken override fails CI.
- [ ] **Step 8: Prove backups against the real stack in deploy-smoke.** After the smoke test, run `backup-mongo` with `AWS_ENDPOINT_URL` pointing at the smoke MinIO and a test bucket. Then run `restore-mongo` for the same date into a second database (an optional `--to <db>` argument, which the bats tests also cover). Check that `users` and `projects` have the same counts in both. Settings come from a stub `aws ssm` that reads the throwaway env, not from SSM.
- [ ] **Step 9: Commit.** `feat(deploy): host scripts for deploys with rollback, nightly backups and patching`

---

### Task 6: Terraform base — state, network, KMS, S3, ECR, SSM, and the CI job

**Files:**
- Create: `deploy/poc/terraform/bootstrap/main.tf` (the state bucket; local state, `terraform.tfstate*` ignored in git), `deploy/poc/terraform/{versions.tf,providers.tf,variables.tf,outputs.tf,network.tf,kms.tf,s3.tf,ecr.tf,ssm.tf}`, `deploy/poc/terraform/tests/base.tftest.hcl`, `deploy/poc/terraform/.tflint.hcl`, `deploy/poc/terraform/.trivyignore` (each line with a reason)
- Modify: `.gitignore`, `.github/workflows/ci.yml` (a new job `terraform`)

**Interfaces:**
- Produces variables: `region` (default `us-east-1`), `domain` (for example `roadmap.example.com`, required), `hosted_zone_id` (an existing Route 53 zone that holds `domain`, required), `github_repository` (default `ltrainsb1/roadmap`), `create_dmarc` (default `true`), `secret_version` (default `1`, the `value_wo_version` of every generated secret).
- Produces resources other tasks reference: `aws_kms_key.main`, `aws_s3_bucket.files`, `aws_s3_bucket.backups`, `aws_s3_bucket.releases`, `aws_ecr_repository.app["api"|"pdf"|"caddy"|"clamav"]`, `aws_subnet.public`, `aws_vpc.main`, and the SSM parameters named in Task 5.
- Produces outputs: `registry`, `releases_bucket`, `files_bucket`, `backup_bucket`, `kms_key_arn`.

Values:
- **Backend:** S3, key `poc/terraform.tfstate`, `use_lockfile = true`, `encrypt = true`. The bucket name comes from `-backend-config` (the runbook gives it).
- **Network:** VPC `10.40.0.0/16` with an Amazon-provided IPv6 block. One public subnet `10.40.1.0/24` with an IPv6 /64, in the region's first availability zone that offers t4g.large (data source). An internet gateway, a route table with `0.0.0.0/0` and `::/0` to it, and a free S3 gateway endpoint. No NAT.
- **KMS:** one key, `enable_key_rotation = true`, alias `alias/roadmap-poc`. The key policy gives the account root full access, and `ses.amazonaws.com` and `sns.amazonaws.com` `kms:GenerateDataKey*` and `kms:Decrypt`, conditioned on `aws:SourceAccount`. Task 8 needs those two for the encrypted SNS topic and SQS queues.
- **S3:** buckets `roadmap-poc-files-<account id>`, `roadmap-poc-backups-<account id>`, `roadmap-poc-releases-<account id>`. Each blocks all public access, uses `BucketOwnerEnforced`, has SSE-KMS with the key and `bucket_key_enabled`, and a policy that denies `aws:SecureTransport = false`. Backups expire `mongo/` objects after 14 days. Releases expire objects after 90 days. Files have versioning on, with noncurrent versions expiring after 14 days.
- **ECR:** repositories `roadmap-api`, `roadmap-pdf`, `roadmap-caddy`, `roadmap-clamav`. Tags immutable, scan on push, KMS encryption with the key. A lifecycle policy keeps the newest 10 images.
- **SSM:** the four SecureStrings from ephemeral `random_password` (`length = 40`, `special = false`), except `totp-enc-key` and `unsubscribe-key`, which are `base64encode` of a `length = 32` ephemeral password, so each decodes to exactly 32 bytes. All use the KMS key. The String settings come from variables and other resources (`app-origin` is `https://${var.domain}`, `mail-from` is `no-reply@${var.domain}`).

- [ ] **Step 1: Write the failing `terraform test`** (`tests/base.tftest.hcl`, `mock_provider "aws"` with `override_data` for the availability zones and caller identity; the random provider runs for real), `command = plan`:
  - `NFR data protection: every bucket blocks public access and uses the KMS key`.
  - `NFR data protection: every bucket denies non-TLS requests` (the policy document has a `Deny` with `aws:SecureTransport = false`).
  - `NFR backups 14 days: mongo/ in the backup bucket expires after 14 days`.
  - `NFR secrets: every secret SSM parameter is a SecureString with value_wo set and no value` (`value` is null in the plan).
  - Ephemeral values can't be asserted on in a test, so the 32-byte rule for `totp-enc-key` and `unsubscribe-key` is guarded at run time instead. The API's existing `key32` check refuses to start with any other length, and Task 5's `deploy` then rolls back. Add a comment beside those two resources saying so.
  - `NFR: the KMS key rotates`.
  - `NFR: ECR tags are immutable and scanned on push`.
- [ ] **Step 2: Run it and see it fail.** Run: `cd deploy/poc/terraform && terraform init -backend=false && terraform test`. Expected: FAIL, no configuration.
- [ ] **Step 3: Write the configuration** with the values above.
- [ ] **Step 4: Run the tests and see them pass.** Same command. Expected: `Success!`, every run passing.
- [ ] **Step 5: Add the CI job `terraform`.** It sets up the pinned Terraform, then runs:
  - `terraform fmt -check -recursive`;
  - `terraform init -backend=false` and `terraform validate`, in both `deploy/poc/terraform` and its `bootstrap`;
  - `terraform test`;
  - pinned tflint with the AWS ruleset;
  - Trivy config scan on `deploy/poc/terraform` that fails on HIGH and CRITICAL.
  `.trivyignore` may list only findings this plan accepts, each with a reason: open egress (the server reaches Let's Encrypt, ECR, SES, S3, SSM, HIBP and ClamAV's mirrors), no VPC flow logs (cost; D7), and no S3 access logging (cost; D7).
- [ ] **Step 6: Commit.** `feat(infra): Terraform base — network, KMS, S3, ECR, SSM parameters`

---

### Task 7: Terraform server — EC2, data volume, IAM, snapshots, DNS

**Files:**
- Create: `deploy/poc/terraform/{ec2.tf,iam.tf,dlm.tf,dns.tf}`, `deploy/poc/terraform/user-data.sh.tftpl`, `deploy/poc/terraform/tests/server.tftest.hcl`
- Modify: `outputs.tf` (`instance_id`, `public_ip`)

Values:
- **AMI:** `data "aws_ssm_parameter"` `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`, with `lifecycle { ignore_changes = [ami] }` on the instance, so a new AMI never replaces the server.
- **Instance:** `t4g.large`. `metadata_options { http_tokens = "required", http_put_response_hop_limit = 2, http_endpoint = "enabled" }`. No `key_name`. Root volume 30 GB gp3, encrypted with the key. `disable_api_termination = true`. `user_data_replace_on_change = false`.
- **Data volume:** a separate `aws_ebs_volume`, 20 GB gp3, encrypted with the key, tag `Snapshot = "roadmap-poc-data"`, attached as `/dev/sdf`. `prevent_destroy = true`.
- **Address:** an Elastic IP, and the instance gets an IPv6 address.
- **Security group:** exactly the two ingress rules in Global Constraints. Egress to everything on IPv4 and IPv6.
- **User data:**
  - installs `docker` from the AL2023 repositories and the pinned Compose plugin binary, checked by SHA-256, to `/usr/libexec/docker/cli-plugins/docker-compose`;
  - finds the data volume by its EBS id under `/dev/disk/by-id/`, makes an XFS file system only if it has none, and adds it to fstab by UUID at `/srv/mongo` with `defaults` and no `nofail`;
  - creates `/srv/mongo-backup`, `/opt/roadmap/releases` and `/run/roadmap` (via tmpfiles.d, mode 0700);
  - enables Docker.
  It holds no settings or secrets (D2, D3).
- **Instance role** `roadmap-poc-server`:
  - `AmazonSSMManagedInstanceCore`;
  - ECR pull from the four repositories (and `ecr:GetAuthorizationToken`);
  - `ssm:GetParametersByPath` on `/roadmap/poc/*`;
  - S3 `GetObject`, `PutObject` and `DeleteObject` on the files bucket;
  - `PutObject` and `GetObject` on `mongo/*` in the backup bucket;
  - `GetObject` on the releases bucket;
  - `kms:Decrypt`, `kms:GenerateDataKey` and `kms:Encrypt` on the key;
  - SES `ses:SendEmail` and `ses:SendRawEmail` on the domain identity and the configuration set, and `ses:DeleteSuppressedDestination` on `*`;
  - SQS `ReceiveMessage`, `DeleteMessage` and `GetQueueAttributes` on the events queue (Task 8 adds the SES and SQS statements next to its resources).
- **DLM:** a policy targeting `Snapshot = "roadmap-poc-data"`, daily at `05:00` UTC, keeping 14, with the AWS-managed DLM role policy.
- **DNS:** A and AAAA records for `var.domain` in `var.hosted_zone_id`.

- [ ] **Step 1: Write the failing `server.tftest.hcl`**, `command = plan`, mocked AWS:
  - `NFR POC: the instance is a t4g.large with IMDSv2 required and hop limit 2`.
  - `NFR POC: the security group allows only TCP 80 and 443 in` (exactly four ingress rules, every one on port 80 or 443, none on 22).
  - `NFR POC: no key pair`.
  - `NFR POC: root and data volumes are encrypted with the KMS key`.
  - `NFR backups 14 days: DLM keeps 14 daily snapshots of the data volume`.
  - `NFR: the server role cannot read other parameters` (its `ssm:GetParametersByPath` resource is exactly the `/roadmap/poc/*` path).
  - `NFR: user data holds no settings` (D2): the rendered user data contains neither `var.domain` nor the files bucket's name, and its template takes only the data volume's id, the Compose version and its SHA-256.
- [ ] **Step 2: Run it and see it fail.** Run: `terraform test`. Expected: FAIL.
- [ ] **Step 3: Write the configuration.**
- [ ] **Step 4: Run tests, fmt, validate, tflint and the Trivy config scan locally** (or rely on CI if a tool is missing on the Mac, saying which). Expected: all pass, with no new ignore lines beyond Task 6's list.
- [ ] **Step 5: Commit.** `feat(infra): the POC server, its data volume, role and daily snapshots`

---

### Task 8: Terraform email — SES, events, and the app's email settings

**Files:**
- Create: `deploy/poc/terraform/ses.tf`, `deploy/poc/terraform/tests/email.tftest.hcl`
- Modify: `iam.tf` (the SES and SQS statements), `ssm.tf` (`ses-configuration-set`, `ses-events-queue-url`)

Values:
- **Identity and records:**
  - `aws_sesv2_email_identity` for `var.domain`, with Easy DKIM (RSA 2048) and its three CNAME records in the zone;
  - a custom MAIL FROM domain `mail.${var.domain}` with its MX (`feedback-smtp.<region>.amazonses.com`, priority 10) and SPF TXT (`v=spf1 include:amazonses.com ~all`), and behaviour on MX failure `USE_DEFAULT_VALUE`;
  - when `create_dmarc`, the TXT record `_dmarc.${var.domain}` = `v=DMARC1; p=quarantine; adkim=s; aspf=r`.
- **Configuration set** `roadmap-poc`: `reputation_options.reputation_metrics_enabled = true`, `suppression_options.suppressed_reasons = ["BOUNCE", "COMPLAINT"]`, and an event destination to the SNS topic for `BOUNCE` and `COMPLAINT`.
- **Account:** `aws_sesv2_account_suppression_attributes` with `BOUNCE` and `COMPLAINT`.
- **SNS:** topic `roadmap-poc-ses-events`, KMS-encrypted with the key. Its policy allows `ses.amazonaws.com` to publish, conditioned on `aws:SourceAccount` and the configuration set's ARN.
- **SQS:** queue `roadmap-poc-ses-events` (KMS key, `receive_wait_time_seconds = 0`, `message_retention_seconds = 1209600`, `visibility_timeout_seconds = 60`), a dead-letter queue `roadmap-poc-ses-events-dlq` with `maxReceiveCount = 5`, a queue policy allowing the topic to send, and a subscription with `raw_message_delivery = true`.

- [ ] **Step 1: Write the failing `email.tftest.hcl`:**
  - `FR-5: SES sends through the configuration set with bounce and complaint events to SNS`.
  - `FR-5: the SNS subscription to SQS uses raw message delivery`.
  - `FR-5: the events queue has a dead-letter queue after 5 receives`.
  - `FR-5: the account suppression list covers bounces and complaints`.
  - `NFR data protection: the topic and both queues use the KMS key`.
  - `the server role can send only from the domain identity`.
  - `DMARC is created only when create_dmarc is true` (two runs).
- [ ] **Step 2: Run it and see it fail, write `ses.tf`, run it and see it pass.** Run: `terraform test`. Expected: FAIL, then `Success!`.
- [ ] **Step 3: Run fmt, validate, tflint and the Trivy config scan.** Expected: clean.
- [ ] **Step 4: Commit.** `feat(infra): SES with DKIM, a configuration set and bounce events to SQS (FR-5)`

---

### Task 9: GitHub OIDC, the deploy workflow, the post-deploy check, and the runbook

**Files:**
- Create: `deploy/poc/terraform/github.tf`, `deploy/poc/terraform/tests/github.tftest.hcl`, `.github/workflows/deploy-poc.yml`, `scripts/post-deploy-check.sh`, `deploy/poc/README.md`
- Modify: `outputs.tf` (`deploy_role_arn`), `.github/workflows/ci.yml` (shellcheck `post-deploy-check.sh` in `host-scripts`; `actionlint` on both workflows)

Values:
- **OIDC:** `aws_iam_openid_connect_provider` for `https://token.actions.githubusercontent.com`, client id `sts.amazonaws.com`. Role `roadmap-poc-deploy` trusts it only when `token.actions.githubusercontent.com:aud = sts.amazonaws.com` and `token.actions.githubusercontent.com:sub = repo:${var.github_repository}:environment:poc`.
- **Deploy role permissions:**
  - ECR push to the four repositories (and `ecr:GetAuthorizationToken`);
  - `s3:PutObject` on `releases/*` in the releases bucket;
  - `kms:GenerateDataKey` on the key;
  - `ssm:SendCommand` on the document `arn:aws:ssm:<region>::document/AWS-RunShellScript` and on the instance, by ARN;
  - `ssm:GetCommandInvocation` and `ssm:ListCommandInvocations` on `*`.
  It can't read parameters, open sessions or change infrastructure.
- **Workflow `deploy-poc.yml`:** `on: workflow_dispatch` only, `environment: poc`, `permissions: { id-token: write, contents: read }`, `concurrency: { group: deploy-poc, cancel-in-progress: false }`. It reads GitHub repository variables `AWS_REGION`, `POC_DEPLOY_ROLE_ARN`, `POC_INSTANCE_ID`, `POC_REGISTRY`, `POC_RELEASES_BUCKET`, `POC_DOMAIN`. Jobs:
  1. `images`: a matrix over api, pdf, caddy and clamav on `ubuntu-24.04-arm`. It builds natively for `linux/arm64` and scans with Trivy using the same gate as CI, before any push. It pushes `${POC_REGISTRY}/roadmap-<name>:${GITHUB_SHA}`. Because tags are immutable, a re-run of the same commit skips the push when the tag exists (`aws ecr describe-images`).
  2. `release` (needs `images`): `tar -czf` of `deploy/poc` to `s3://${POC_RELEASES_BUCKET}/releases/${GITHUB_SHA}.tar.gz`. Then `aws ssm send-command` with `AWS-RunShellScript` and `executionTimeout` 1200. The command downloads and unpacks the bundle into `/opt/roadmap/releases/${GITHUB_SHA}` and runs its `deploy/poc/host/deploy ${GITHUB_SHA}`. The job polls `get-command-invocation` every 10 s for up to 20 minutes, prints the output, and fails unless the status is `Success`.
  3. `check` (needs `release`): `scripts/post-deploy-check.sh "https://${POC_DOMAIN}"`.
- **`post-deploy-check.sh <origin>`:** GET requests only; it creates no data. It checks:
  - `/api/health` is 200;
  - the certificate is valid (curl with no `-k`) and TLS 1.1 is refused;
  - `Strict-Transport-Security` is present with `max-age` of at least 31536000;
  - the CSP header is present;
  - `/api/calendar/<43 random base64url characters>.ics` is 404 with `X-Robots-Tag`;
  - `http://` redirects to `https://`.
  The S3 check from D5 is in the runbook's first-deploy steps, because a download needs a signed-in user.

- [ ] **Step 1: Write the failing `github.tftest.hcl`:**
  - `NFR: the deploy role trusts only the poc environment of the repository` (the exact `sub` and `aud` conditions).
  - `NFR: the deploy role has no ssm:GetParameter*, ssm:StartSession or iam:* action`.
  - `NFR: send-command is limited to AWS-RunShellScript and the one instance`.
- [ ] **Step 2: Run it and see it fail, write `github.tf`, run it and see it pass.** Run: `terraform test`. Expected: FAIL, then `Success!`.
- [ ] **Step 3: Write the workflow and the check script.** Add `actionlint` (pinned) and shellcheck of the check script to CI. Run `actionlint` locally if it's installed. Expected: clean.
- [ ] **Step 4: Prove the check script against the devbox stack.** Start the stack there with `DOMAIN=localhost` on free high ports. Run the script with `--insecure-for-local-ca` (an option that adds curl's `--cacert` for Caddy's local CA, never `-k`). Expected: every check passes except the certificate check, which the option replaces. Remove the stack afterwards.
- [ ] **Step 5: Write `deploy/poc/README.md`, the runbook.** Plain writing. Numbered steps a person follows once, each with the exact command:
  1. What you need: an AWS account, a Route 53 zone, the AWS CLI signed in as an administrator, Terraform, and `gh`.
  2. Create the state bucket: `terraform -chdir=deploy/poc/terraform/bootstrap apply`.
  3. `terraform init -backend-config=bucket=<name>`, then `terraform apply -var domain=… -var hosted_zone_id=…`.
  4. Ask AWS to move SES out of the sandbox (what to write in the request, and that it takes about a day). Until then, only verified addresses get email.
  5. Create the `poc` environment in GitHub, and set the six variables from `terraform output` with `gh variable set`.
  6. Run the deploy workflow (`gh workflow run deploy-poc.yml --ref <branch>`).
  7. Create the first account: `aws ssm start-session`, then the bootstrap command run inside the api container.
  8. First-deploy checks by hand: sign in, upload a file and download it (D5), make a snapshot PDF, subscribe a calendar, get one notification email and check its unsubscribe link.
  9. Restoring a backup (`restore-mongo <date>`) and restoring a whole data volume from a DLM snapshot.
  10. Rotating secrets (`secret_version`), and why `totp-enc-key` is never rotated.
  11. Monthly cost at list prices: t4g.large about $49, 50 GB gp3 about $4, IPv4 about $3.65, KMS $1, plus S3, ECR, SES and Route 53 at a few dollars. About $60 a month, not the PRD's $33.
  12. Tearing it down: the data volume and termination protection stop a plain `destroy`, and why.
- [ ] **Step 6: Run everything that runs locally.** Run: `pnpm lint && pnpm typecheck && pnpm run test`, `bats deploy/poc/host/test`, `terraform -chdir=deploy/poc/terraform test`. Expected: all pass.
- [ ] **Step 7: Commit.** `feat(infra): GitHub OIDC deploy role, the deploy workflow and the runbook`

---

## Not in this plan

- Applying anything to AWS (the user does it with the runbook).
- CloudWatch logs, metrics and alarms; OpenTelemetry; the OWASP ZAP scan; the quarterly restore test as a schedule; a profile page for name and time zone. All of these are release hardening.
- AWS WAF, a second server, or Atlas (production).
- Moving PDFs or email jobs to SQS (the Fargate move).

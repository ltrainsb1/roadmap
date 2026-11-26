# v1 POC infrastructure: decisions made and work left

This records what was decided while the [POC infrastructure plan](2026-11-25-v1-poc-infrastructure.md) was carried out, and what was found and left on purpose. The plan was run task by task, and each task had its own review. Then came one whole-branch review and one fix pass, with its own re-review. Nothing was applied to AWS. You apply it by following the runbook in `deploy/poc/README.md`.

## Decisions made during execution

Each of these was a choice where the plan or the PRD was silent, or where the plan turned out to be wrong. Change any of them and the code follows.

| # | Decision | Why | Cost if wrong |
| --- | --- | --- | --- |
| I1 | On the server, `compose.env` names the env files (`API_ENV_FILE`, `WORKER_ENV_FILE`). The AWS Compose override sets no `env_file`. | Compose appends `env_file` lists across files, so the base file's default would also load and be missing. | None. |
| I2 | The SES settings reach the API and worker through `env-map`, like every other setting. | One source for settings. | None. |
| I3 | Backup and restore read the backup bucket from `compose.env`. The CI smoke run writes one and points `AWS_ENDPOINT_URL` at MinIO. | No fake SSM is needed in CI. | None. |
| I4 | The unsubscribe route opts out of the global rate-limit allow list, as the calendar feed does. | Otherwise its 30-a-minute limit wouldn't apply. | None. |
| I5 | The proof that `roadmap_app` can't see other databases checks two things. A plain `listDatabases` lists only `roadmap`, and `listDatabases` with `authorizedDatabases: false` is refused. | MongoDB filters a plain `listDatabases` to the user's own databases, so the plan's check could never fail. | None. |
| I6 | Our ClamAV image is built on `clamav/clamav-debian:1.4.7`, pinned by digest. It upgrades `libxml2` and `libzstd1` with apt. | The Alpine `clamav/clamav:1.4.7` has no ARM build, and the server is ARM. The Debian image also had a fixable HIGH in `libzstd1`. | A bigger image. The Compose hardening was re-proven on Debian. |
| I7 | When `/run/roadmap` is empty (after a reboot), backup and restore render the settings again from SSM first. | `/run` is emptied at every reboot, including the 04:00 patch reboot, so backups would stop until the next deploy. | A 03:00 backup needs SSM to answer. |
| I8 | `/srv/mongo-backup` is on the root disk. | The data volume is MongoDB's own data folder. The plan wrongly said "on the data volume". | None (30 GB root disk). |
| I9 | Each secret has its own version number in `deploy/poc/terraform/secret-versions.auto.tfvars`, which is committed. `totp-enc-key` has none: it is never rotated. | One shared number rotated every secret at once, which would break every authenticator. Changing a MongoDB password in SSM doesn't change MongoDB's own user. A lost local file would make Terraform write new passwords. | None. The runbook gives the rotation steps. |
| I10 | The Terraform state bucket uses the AWS-managed `aws/s3` KMS key. | The customer key lives in the main configuration, which the state bucket must exist before. | None. |
| I11 | The subnet doesn't hand out public addresses. The server asks for its own, plus the Elastic IP. | The config scan refuses subnets that do. | None. |
| I12 | Terraform ignores later changes to the server's first-boot script. | That script runs once per server, so a change would only stop and start it. A Compose upgrade on a live server is a host step in the runbook. | Changes to the first-boot script reach only a new server. |
| I13 | The host scripts get the AWS region from the instance metadata service when it isn't set. | systemd services and SSM commands have no home folder, so `~/.aws/config` isn't read. | One metadata call per script. |
| I14 | Uploads and backups send no encryption header, so the bucket's own KMS key applies. | Sending `aws:kms` without a key id makes S3 use the AWS-managed key instead. | None. |
| I15 | No IPv6 DNS record: the POC is IPv4 only. | Docker's IPv6 port proxy makes every IPv6 visitor look like one address, so they would all share one sign-in rate limit. | No IPv6 reach. |
| I16 | The server keeps AWS's `AmazonSSMManagedInstanceCore` policy. The runbook asks for an AWS account used only for this POC. | That policy can read any parameter in the account, but replacing it can't be tested without AWS and could break Session Manager, the only way in. | The server can read other parameters in a shared account. |
| I17 | Image repositories are named `roadmap-poc-api`, `-pdf`, `-caddy` and `-clamav`. | The plan's own naming rule; it's free before the first apply. | None. |
| I18 | The AWS provider is locked at 6.73.0, the newest release at least 14 days old. | The same age rule as the tools. | None. |
| I19 | The smoke run's MinIO bucket encrypts by default. | The API no longer asks for encryption on each upload. | None. |
| I20 | A deploy pulls the images before it stops anything, and a failed pull leaves the running stack alone (exit 2). | A registry fault shouldn't look like a rollback. | It also pulls `mongo:8.0` from Docker Hub on every deploy. |
| I21 | The check that TLS 1.1 is refused uses `openssl s_client`, and the check fails when openssl is missing. | curl fails such a request on its own side, which would hide a server that still accepts it. | None. |

## Measured

- **Smoke run on the devbox:** the full CI smoke flow passed there with the new ClamAV image, the unsubscribe check, the `roadmap_app` check, and a backup and restore through MinIO whose counts matched. The smoke script uses 8 of the 10 sign-in requests a minute the stack allows.
- **ClamAV image:** with CI's settings, Trivy found no fixable HIGH or CRITICAL finding. The container became healthy in about 19 s, read-only and with every capability dropped.
- **Post-deploy check:** all 9 checks passed against the devbox stack, with Caddy's local CA.

## Not verified

- **Anything on real AWS:** first boot, the volume mount, the SSM, SES, SQS and KMS permissions, DKIM, the deploy workflow and the post-deploy check against the real domain. The runbook's first-deploy checks cover these by hand.
- **The new CI jobs on GitHub:** `terraform`, `host-scripts`, the changed `deploy-smoke`, and the `ubuntu-24.04-arm` runners the deploy workflow needs. The host-script tests have only run on macOS bash 3.2.
- **The MinIO and ClamAV container tests:** not re-run after the upload change. Their requests are the same as before.
- **Session Manager only:** `docker.socket` on Amazon Linux 2023, and whether `dnf needs-restarting -r` exits as the patch unit expects. Check both once on the first server.
- **Docker Compose v5.7.0** with Amazon Linux 2023's Docker.
- **The workflow needs to be on `main`:** a `workflow_dispatch` workflow can only be started once it is on the default branch.

## Needs your decision

- **Containers can reach the server's AWS role:** containers other than the API and worker can reach the instance metadata service, and so the role's rights (I16 and D4). A ClamAV exploit from a hostile upload could read secrets from SSM. A `DOCKER-USER` firewall rule that lets only the API and worker reach `169.254.169.254` would close this, but it needs a live server to test. Do it on the first server, or leave it?
- **Replace `AmazonSSMManagedInstanceCore`:** use a minimal Session Manager policy instead, or keep the dedicated-account rule (I16).
- **Shorten the PRD's cost figure:** the POC now costs about $60 a month, not $33, because of the 8 GB server.
- **Carried from earlier plans:** an account-level activity log, changing one's own time zone, archived-item editing, and what unarchive restores.

## Found and left for later

**Server and host scripts**
- The root MongoDB password is passed on the `mongodump` and `mongorestore` command lines, so `ps` on the host shows it. The health check already does the same.
- MongoDB is recreated on every deploy, because its init-script folder moves with each release. It now gets 60 s to stop cleanly. A fixed path would avoid the restart.
- After a failed rollback, the env files may describe the new release while `current` names the old one. The message doesn't say so.
- Redeploying the release that is already running has no fallback if it fails.
- Compose's required variables aren't checked against `env-map` the way the env files are.
- `systemctl stop docker docker.socket` in the runbook prints an error if the socket unit doesn't exist. It still stops Docker.

**Terraform**
- **DLM key policy:** the snapshot role has a KMS policy it doesn't need for same-account, same-region snapshots.
- **Dead-letter queue:** it has no policy limiting which queue may send to it.
- **Account suppression list:** it is set for the whole AWS account, which deserves a comment.
- **Test gaps:**
  - a guard against a stored `random_password`;
  - the deny-non-TLS check doesn't look at its action and resources;
  - only the first DKIM record is checked;
  - the topic and queue policies are checked with `strcontains` rather than by decoding them;
  - the DLM interval unit and the A record's address aren't checked;
  - an unused mock and a `.gitignore` line that matches nothing.

**Deploy workflow and runbook**
- **Errors while waiting:** every error is treated as "still waiting", so a permissions fault takes 20 minutes to show.
- **Approvals:** with required reviewers on the `poc` environment, the build job and the release job each ask for approval. Limiting the environment to `main` isn't described yet.
- **Placeholders:** a few runbook commands use literal values (`us-east-1`, `roadmap.example.com`) where they should use placeholders.
- **Old volume after a restore:** it keeps its snapshot tag.
- **Emptying a bucket:** the teardown loop that empties a versioned bucket breaks above 1,000 objects.
- **Robots header:** the post-deploy check confirms `X-Robots-Tag` is present but not that it says `noindex`.
- **Rotation note:** the rotation section doesn't name the 03:00 backup as one of the things that fail during the window.

**App**
- **SNS envelope:** if SNS raw delivery were ever off, every bounce would be thrown away without a log line.
- **Test gaps:**
  - no test that `a@x` doesn't block `xa@x`;
  - no test of the digest guard on its own;
  - no test of the API's `SES_CONFIGURATION_SET` setting;
  - no axe check in the unsubscribe page's unit test (the E2E test has one).
- **Duplicate client:** the API builds a second SES client beside the mailer's.
- **Screen readers:** "Emails are on again." is added already filled in, which some screen readers skip.
- **Pass log:** it loses the earlier batches' counts if a later SQS read fails.
- **Bounce lookup:** looking up users by bounced address scans the users collection. Fine at POC size.
- **Worker sender address:** the worker's default sender ignores `WEBAUTHN_RP_ID`. Production sets `MAIL_FROM`.
- **ClamAV container tests:** they still use the Alpine ClamAV image, not the Debian one production uses.
- **Smoke rate-limit margin:** the smoke script has only 2 sign-in requests to spare.

## Next plans

1. Apply the infrastructure with the runbook and run the first-deploy checks.
2. Release hardening:
   - the OWASP ZAP scan;
   - CloudWatch logs and alarms, and OpenTelemetry;
   - the quarterly restore test;
   - a profile page for name and time zone;
   - the IMDS firewall rule, if not done on the first server.

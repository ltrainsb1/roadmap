> Copy of the PRD Claude Doc, https://claude.ai/artifact/LGUFMSk7c39zAFcG2Zkrd2 (as of 2026-11-18). The doc is the source of truth.

# Roadmap Tool — Product Requirements Document
2026-11-18 · Lance

## Overview
A lightweight, secure web app for planning project roadmaps. It replaces the spreadsheets, reminders and scattered notes that small teams use today. v1 serves one small team; the design is multi-tenant from day one so it can become a product later.
**Problem.** Spreadsheets have no roles, no history and no way to collect input from the wider team. Dates live in one place and calendars in another, so commitments drift.
**Vision.** One place where admins own the official plan, team members contribute ideas and votes, stakeholders get a clean read-only snapshot, and anyone can ask an AI assistant what's going on.

### Goals
- Admins can build and maintain a roadmap of projects, nested up to 4 levels, with dates, priorities, notes and assignees.

- Invited members can submit ideas and upvote projects; admins see the demand signal but keep the final say.

- Stakeholders get a password-protected, frozen snapshot as a web page or PDF.

- Roadmap dates show up in each user's own calendar (Google, Apple, Exchange/Outlook) through a subscribable feed.

- An AI chat can answer questions across every roadmap the user can access, and propose changes that only apply after the user confirms.

- Security is built in from the start: MFA, passkeys, tenant isolation and audit logging.

### Non-goals (v1)
- Native iOS or Android apps (the web app is responsive instead).

- Two-way calendar sync.

- Time tracking, budgets, resource capacity planning or full Gantt-style dependency scheduling.

- SAML SSO, data residency and formal compliance certifications (for example SOC 2).

## Users and roles
Roles are set per roadmap, so one person can be an Admin on one roadmap and a Contributor on another. Year-one scale is 15–20 users in a single tenant (organization). Every query is scoped to the tenant.

### Personas
- **Roadmap owner.** Creates the roadmap, invites people, and is ultimately accountable for it.

- **Admin.** Maintains projects, dates and the official priority. Reviews ideas and votes.

- **Contributor.** A team member who submits ideas, votes, comments, and works on the sub-projects assigned to them.

- **Viewer (stakeholder).** Has no account. Opens a password-protected snapshot link or a PDF.

### Permissions

| Capability | Owner | Admin | Contributor | Viewer (link) |
| --- | --- | --- | --- | --- |
| View the live roadmap | Yes | Yes | Yes | No (snapshot only) |
| Create, edit or delete projects | Yes | Yes | Only assigned items | No |
| Set the official priority | Yes | Yes | No | No |
| Assign users | Yes | Yes | No | No |
| Submit ideas, upvote, comment | Yes | Yes | Yes | No |
| Turn an idea into a project | Yes | Yes | No | No |
| Create snapshot links and PDFs | Yes | Yes | No | No |
| Invite and remove members, change roles | Yes | Admins and Contributors only | No | No |
| Delete the roadmap or transfer ownership | Yes | No | No | No |
| Use AI chat | Yes | Yes | Yes (within their own permissions) | No |
A Contributor assigned to an item can edit that item and everything under it: status, dates, notes, and its own sub-projects. They can't change its priority or reassign it.
Access is by invitation only. Joining needs an emailed invite link that expires; there is no self-sign-up into a roadmap.

## Data model
The hierarchy is Tenant → Roadmap → Project, with projects nested up to **4 levels** (Project → Sub-project → Task → Sub-task). The API rejects anything deeper.

### Core entities

| Entity | Key fields |
| --- | --- |
| Tenant | id, name, plan, createdAt |
| User | id, email, name, MFA settings, passkeys, timezone, notification preferences |
| Membership | userId, roadmapId, role (Owner, Admin, Contributor) |
| Roadmap | id, tenantId, name, description, owner, archived |
| Project (any level) | id, roadmapId, parentId, depth (1–4), title, description, status, start date, end date, milestones, dependencies, tags, attachments, links, assignees, official priority, vote count |
| Milestone | id, projectId, name, date |
| Note | id, projectId, author, body (Markdown), createdAt, editedAt |
| Idea | id, roadmapId, linked projectId (optional), author, title, body, status (Open, Accepted, Declined, Converted), convertedProjectId |
| Vote | userId, target (project or idea), createdAt; one per user per target |
| Snapshot | id, roadmapId, frozen-at date, frozen data, password hash, expiry, created by |
| Calendar feed | userId, feed token (hashed), scope (roadmaps), revoked |
| Audit event | tenantId, actor (user or AI on behalf of a user), action, target, before and after values, timestamp, IP address |

### Rules
- **Status values:** Not started, In progress, Blocked, Done, Cancelled.

- **Official priority:** a single ordered ranking set by Admins (drag to reorder). It can also show a P1–P4 label. Vote counts are shown next to it as advice only and never change the order on their own.

- **Dependencies:** an item can be marked "blocked by" other items in the same roadmap. These are shown on screen and flagged when dates conflict; nothing is rescheduled automatically.

- **Dates:** stored as dates in UTC. A child's dates should fall inside its parent's; the app warns when they don't but doesn't block the change.

- **Attachments:** stored in S3 with a size limit per file, a malware scan on upload, and pre-signed URLs for download.

## Functional requirements
Requirement IDs (FR-x.y) are referenced by tests and tickets. Each area is tagged with the release it belongs to (see Release plan).

### FR-1 Roadmaps and projects (v1)
- FR-1.1 A user can belong to many roadmaps and switch between them from a roadmap picker.

- FR-1.2 Admins can create, edit, archive and delete projects and sub-projects, up to 4 levels deep.

- FR-1.3 Admins can set an official priority by dragging items into order within a level.

- FR-1.4 Projects carry dates, milestones, status, tags, links, attachments and "blocked by" dependencies.

- FR-1.5 Notes on a project are threaded, written in Markdown, and support @mentions.

- FR-1.6 An item can have one or more assignees, and any member can be assigned at any level.

- FR-1.7 Three views: **List/tree** (the default), **Timeline** (bars and milestones on a time axis), and **Board** (columns by status).

- FR-1.8 Filter and search by assignee, status, tag, date range and priority.

- FR-1.9 Every screen works on mobile browsers from 375 px wide. The tree collapses, and the timeline scrolls sideways.

### FR-2 Crowdsourced ideas and voting (v2)
- FR-2.1 Invited members can submit an idea against the whole roadmap or against a specific project. Ideas don't need admin approval before others can see them.

- FR-2.2 Each member can give one upvote per project or idea and take it back at any time. Votes are not anonymous: the list of voters is visible.

- FR-2.3 Vote counts appear next to the official priority as a demand signal and never reorder the roadmap.

- FR-2.4 Admins can change an idea's status and convert it to a project in one click. The new project keeps a link to the idea, its author and its votes.

- FR-2.5 Admins can hide or delete inappropriate ideas, and the action is logged in the audit log.

### FR-3 Read-only snapshots and PDF (v1)
- FR-3.1 An Admin creates a snapshot that freezes the roadmap as of a chosen date. Later edits don't change it.

- FR-3.2 Each snapshot has its own unguessable URL protected by a password the Admin sets. Optional expiry; can be revoked at any time.

- FR-3.3 A snapshot shows a timeline view and a list view, with a header showing the "as of" date and roadmap name.

- FR-3.4 A one-click PDF export of either view, generated on the server so the output looks the same on every device.

- FR-3.5 Admins choose what a snapshot includes: notes, assignee names, and vote counts can each be shown or hidden.

- FR-3.6 Wrong-password attempts are rate-limited, and the link locks for a while after repeated failures.

### FR-4 Calendar feed (v1)
- FR-4.1 Each user gets their own iCalendar (.ics) subscription URL, which works in Google Calendar, Apple Calendar and Outlook/Exchange.

- FR-4.2 The user chooses what the feed includes: which roadmaps, start/end dates, milestones, and whether to show only items assigned to them.

- FR-4.3 Calendar entries update automatically when dates change. Each entry has a stable ID, so the calendar updates the existing entry instead of adding a duplicate.

- FR-4.4 Feed URLs contain a long random token that can be revoked and regenerated. Entries show only titles and dates, with a link back to the app instead of the notes.

- FR-4.5 A one-off .ics download for a single item, so it can be added to a calendar right away.

### FR-5 Notifications (v1: email; v2: browser push)
- FR-5.1 Events that trigger a notification: assigned to an item, dates changed on an assigned item, @mention, new idea on a roadmap the user administers, idea status changed, and a due date coming up.

- FR-5.2 Each user chooses, per event type, whether to get it instantly, as a daily digest, or not at all.

- FR-5.3 An in-app notification center with unread counts.

### FR-6 AI chat assistant (v2)
- FR-6.1 A chat panel on every screen. The assistant can answer questions across every roadmap the user can access, for example "What's slipping this month?" or "What's assigned to Maria?"

- FR-6.2 It can propose changes: add a project or sub-project, change dates, add notes, reassign, or change status.

- FR-6.3 **Every change needs confirmation.** The assistant shows a preview of what would change (before and after); nothing is written until the user approves.

- FR-6.4 The assistant acts with the user's own permissions. It can only see and change what that user could in the app, and the server enforces this, not the prompt.

- FR-6.5 Every change the AI makes is logged in the audit log as made by the AI on behalf of that user, and can be undone.

- FR-6.6 The AI provider sits behind an adapter. Claude via the Anthropic API is the first implementation; others can be added without changing the app's tool layer.

- FR-6.7 Project content passed to the model is treated as data, not instructions, so text in a note can't take control of the assistant (prompt-injection defense). The assistant can only take actions through a fixed set of tools.

- FR-6.8 Usage limits per user and per tenant to control API cost.

## Security and non-functional requirements
The product is sold on being secure, so these requirements are not optional extras.

### Authentication
- **Email and password** with MFA required for everyone. Authenticator-app codes (TOTP) are the primary second factor, and one-time recovery codes are issued at setup.

- **Passkeys (WebAuthn)** can be used as a passwordless sign-in or as the second factor.

- Passwords are hashed with Argon2id, and new passwords are checked against lists of breached passwords.

- Sessions use HttpOnly, Secure, SameSite cookies; they log out after a period of inactivity and have an absolute maximum lifetime. A user can sign out of all their sessions at once.

- Sign-in attempts are rate-limited, and accounts lock temporarily after repeated failures.

### Authorization and tenant isolation
- Every API and database query is scoped by tenantId and checks the user's role on that roadmap. The checks live in one central policy layer, never in individual route handlers.

- Automated tests confirm that one tenant can never read another tenant's data and that each role can only do what the permissions table allows (see Quality).

### Data protection
- TLS 1.2 or later everywhere, with HSTS. Data is encrypted at rest in MongoDB Atlas, S3 and backups using keys managed by AWS KMS.

- Secrets live in AWS Secrets Manager, never in code or plain environment files.

- Snapshot passwords and feed tokens are stored only as hashes.

### Audit log
- Records sign-ins, permission changes, every create, update and delete, snapshot creation and access, and every change made by the AI.

- Entries can't be edited or deleted, and are kept for **30 days** (removed automatically by a MongoDB TTL index).

- Owners and Admins can view and filter the audit log for their own roadmaps.

### Application security
- Protections against the OWASP Top 10 risks: input validation (zod), output encoding, a strict content security policy (CSP), CSRF protection, and SSRF protection on any link previews.

- Dependency and container image scanning, static analysis (SAST) and secret scanning run in CI and block a merge when they find something.

- AWS WAF in front of the app, with rate-limiting rules.

### Non-functional targets

| Area | Target |
| --- | --- |
| Availability | 99.5% monthly (small team stage) |
| Page response (p95) | Under 500 ms for API calls, under 2 s for first page load on 4G |
| AI response | First token within 3 s |
| Backups | Daily, kept for 14 days; restore tested every quarter |
| Recovery | Up to 24 h of data loss (RPO) and up to 4 h to restore service (RTO) |
| Accessibility | WCAG 2.1 AA |
| Browsers | Latest 2 versions of Chrome, Safari, Firefox, Edge; iOS Safari, Android Chrome |

## Architecture and tech stack
It's a single TypeScript codebase running on AWS, with all infrastructure defined in Terraform. Infrastructure comes in two stages: a single-instance POC and a highly available production stack (see Infrastructure options below). The diagram shows production.

*[Diagram: AWS architecture · edge, services, data — see the PRD doc]*
The API is the only path to the data. The background worker handles slow jobs (generating PDFs, building calendar feeds, sending email digests) that the API hands it through SQS.

| Layer | Choice |
| --- | --- |
| Frontend | React + TypeScript (Next.js or Vite), responsive, installable as a home-screen web app later |
| API | Node.js + TypeScript (Fastify or NestJS), REST + OpenAPI, request validation with zod |
| Database | MongoDB Atlas on AWS, private networking (VPC peering or PrivateLink), tenantId on every collection and in every index |
| Files | S3 with private buckets, KMS encryption and pre-signed download URLs |
| Async jobs | SQS queue plus a worker service (PDF generation with headless Chromium, email digests) |
| Email | Amazon SES |
| Auth | Built in-house with vetted libraries (SimpleWebAuthn for passkeys, otplib for authenticator codes), or AWS Cognito if it supports passkeys well enough |
| AI | An LLM adapter interface; Claude via the Anthropic API first, using tool calling to map to API actions |
| Hosting | ECS Fargate behind an Application Load Balancer, CloudFront and AWS WAF |
| IaC and CI/CD | Terraform modules per environment (dev, staging, prod); GitHub Actions with OIDC to AWS (no long-lived keys) |
| Observability | CloudWatch logs and metrics, OpenTelemetry tracing, alerts on errors and latency |

### Infrastructure options
The POC runs on one EC2 instance with Docker Compose for about **$33/month**. Production moves the same container images to ECS Fargate with MongoDB Atlas for about **$190–200/month** (or $130–140 in the lean configuration). At 50 users, nearly all of the cost is fixed infrastructure, not per-user load.

| Option | Stack | ~Monthly (50 users, excl. AI) | Availability | Use when |
| --- | --- | --- | --- | --- |
| POC | 1 × EC2 t4g.medium + Docker Compose (Caddy, API, worker, MongoDB) | ~$33 | Single instance; downtime on reboot or failure | Team trial, v1 validation |
| Production, lean | Fargate (1 API + 1 worker task), ALB, Atlas M10, public subnets with no NAT | ~$130–140 | Managed database; brief downtime during deploys | Early paying users on a tight budget |
| Production, standard | Fargate (2 API + 1 worker across 2 AZs), ALB, NAT Gateway, WAF, Atlas M10 | ~$190–200 | Highly available across 2 AZs | Multi-tenant product (v3) |

#### POC: single EC2 instance

| Item | Sizing | ~Monthly |
| --- | --- | --- |
| EC2 t4g.medium (ARM) | 2 vCPU / 4 GB on-demand; 4 GB leaves room for Node, MongoDB and headless Chromium | ~$25 |
| EBS gp3 | 30 GB, encrypted, separate data volume for MongoDB | ~$2.50 |
| Public IPv4 | 1 address | ~$3.65 |
| MongoDB | Container on the same instance | $0 |
| S3 backups, SES, Route 53 | Light use | ~$2 |
| Total |  | ~$33 |
Security baseline for the POC:
- Only ports 80 and 443 open to the internet; Caddy terminates TLS with free Let's Encrypt certificates and rate-limits requests.

- No SSH: port 22 stays closed and admin access goes through SSM Session Manager.

- IMDSv2 required, EBS encrypted, secrets in SSM Parameter Store.

- Nightly mongodump to S3 and daily EBS snapshots through Data Lifecycle Manager.

- Automatic OS security patching (Amazon Linux 2023).

- All infrastructure in Terraform from day one.

What the POC gives up: high availability, a managed database with point-in-time recovery, and AWS WAF. These are acceptable for an internal team trial, not for external tenants.

#### Production: ECS Fargate

| Item | Sizing | ~Monthly |
| --- | --- | --- |
| Fargate API | 2 tasks × 0.5 vCPU / 1 GB, ARM | $29 |
| Fargate worker | 1 task × 0.5 vCPU / 2 GB, ARM | $17 |
| Application Load Balancer | Base charge + light capacity-unit (LCU) usage | $18–20 |
| NAT Gateway | 1 gateway | $33 |
| Public IPv4 | ALB in 2 AZs | ~$7 |
| MongoDB Atlas M10 | Includes backups; M10 or higher is needed for VPC peering or PrivateLink | $60–65 |
| AWS WAF | 1 web ACL, ~5 rules | ~$10 |
| CloudFront, S3, SQS, SES, Secrets Manager, KMS, CloudWatch, Route 53 | Low volume | ~$15 |
| Total |  | ~$190–200 |
The lean configuration drops the NAT Gateway (–$33) by running tasks in public subnets with tight security groups (or using IPv6 with an egress-only internet gateway), and runs one API task instead of two (–$15). A staging environment adds about $80–100 if it mirrors production, or under $40 on Atlas Flex with one task that scales to zero when idle.

#### AI chat cost (v2, either option)
About $30–150/month, assuming 20 active users × 10 questions a day × ~8,000 tokens of roadmap context, depending on which Claude model is used and how much prompt caching saves. The per-user and per-tenant usage limits (FR-6.8) cap it. Check current Anthropic API prices before budgeting.

#### Moving from POC to production
- Push the same container images to ECR and run them as ECS Fargate services.

- Move the data to Atlas with mongodump / mongorestore, then switch the connection string.

- Replace Caddy with CloudFront, WAF and the ALB, then switch DNS.

- Requirement from the start: all configuration comes from environment variables, and nothing except the database writes to local disk. This keeps the move to about a day.

Prices are us-east-1 list prices as of November 2026. EC2, EBS, WAF, SES and Secrets Manager figures are approximate. Sources: AWS Fargate pricing, MongoDB Atlas pricing, Elastic Load Balancing pricing, Amazon VPC pricing (NAT Gateway).

## Quality and testing
No feature is done until it has passing automated **unit** and **functional** tests. CI blocks the merge if either is missing or failing.

### Definition of done (every feature and fix)
- Unit tests for the new logic (services, permission policies, date and priority rules, AI tool handlers)

- Functional tests covering the user flow from start to finish in a real browser

- Permission tests for each role the feature touches, plus a check that another tenant can't reach it

- Coverage on changed code stays at 80% or higher

- Security scans pass: dependency audit, static analysis (SAST), secret scanning

- Accessibility check (axe) passes on any new screens

- The FR-x.y requirement ID is referenced in the test name or the PR

### Test layers and tools

| Layer | Scope | Tooling |
| --- | --- | --- |
| Unit | Functions, services, policy layer, validators | Vitest or Jest, mongodb-memory-server |
| API / integration | REST endpoints against a real MongoDB, including auth and tenant scoping | Supertest, Testcontainers |
| Functional (E2E) | User flows in the browser on desktop and mobile screen sizes | Playwright |
| Contract | iCalendar feed is valid; PDF output renders | ical.js parser, PDF snapshot checks |
| AI | Tool calls map to correct API actions, require confirmation, and resist prompt-injection fixtures | Mocked LLM adapter plus a small set of evaluation prompts run against the real model each night |
| Security | Automated scan of the running app (DAST) before each release | OWASP ZAP baseline scan |

### Pipeline
On every pull request: lint, type-check, unit tests, API tests, security scans. Before merge: functional tests against a temporary preview environment. After merge: deploy to staging, run smoke tests, then manually promote to production.

## Release plan
v1 ships the core roadmap tool, the snapshot links and the calendar feed. v2 adds collaboration features (ideas and voting) and the AI assistant. v3 is the work needed to sell it as a product. v1 runs on the POC infrastructure (single EC2 instance); the move to production on Fargate happens before the first external tenant (v3), or earlier if uptime becomes a concern. No dates are set yet.

| Release | Scope | Exit criteria |
| --- | --- | --- |
| v1: Core | Sign-in (MFA, passkeys), tenants and roles, roadmaps, 4-level projects, priorities, notes, assignments, list, timeline and board views, password-protected snapshots and PDF, .ics feed, email notifications, audit log | The team runs a real roadmap in it for 4 weeks instead of the spreadsheet |
| v2: Collaborate and AI | Ideas, upvotes, converting an idea to a project, AI chat with confirmed changes, browser push notifications | At least half of members vote or submit an idea; AI changes are confirmed and audited with no permission leaks |
| v3: Product | Self-serve tenant signup, billing, tenant admin console, SAML/OIDC SSO, native apps evaluated | First external tenant onboarded |

## Success metrics, risks and open questions
Success is measured by whether the team actually works in this tool day to day instead of the spreadsheet.

### Metrics
- 100% of active team roadmaps move out of spreadsheets within 30 days of v1.

- A new roadmap with 10 projects can be set up in under 15 minutes.

- Each roadmap has at least one snapshot link viewed per month.

- At least 50% of members vote or submit an idea each month (v2).

- At least 90% of changes the AI proposes are accepted without edits, and no AI action has ever gone beyond the user's permissions (v2).

- Zero cases of one tenant seeing another tenant's data, and zero critical vulnerabilities left open more than 7 days.

### Risks

| Risk | Mitigation |
| --- | --- |
| AI chat makes unwanted or unauthorized changes | Confirmation required before every change, permissions enforced on the server, a fixed set of tools, audit log, undo |
| Prompt injection through notes or ideas | Content passed to the model as data, never instructions; tool calls validated; injection test cases run in CI |
| A tenant's data leaks to another tenant once there are multiple customers | One central tenant-scoped data layer; isolation tests run on every PR |
| Snapshot link shared too widely | Password, expiry, revocation, access logged in the audit log |
| AI API cost grows with usage | Usage limits per user and per tenant, response caching, usage dashboard |
| Calendar apps refresh subscribed feeds slowly (Google can take hours) | Explain the delay in the UI and offer a one-off .ics download for changes that need to show up right away |

### Open questions
- Does each Admin also need a private personal ranking alongside the official priority?

- Should the AI assistant be available to Contributors in v2, or only to Admins at first?

- Should audit logs be archived to S3 for longer than 30 days once there are paying customers?

- Pricing model for the product phase (per seat or per roadmap)?

- Product name and domain.

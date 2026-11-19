# v1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable, secure skeleton of the Roadmap Tool where invited people sign in with mandatory MFA, create roadmaps, manage members by role, and see an immutable audit log, with every request tenant-scoped and permission-checked in one central place.

**Architecture:** A pnpm monorepo with a Fastify + TypeScript API (`apps/api`), a Vite + React SPA (`apps/web`), and shared zod schemas and role and action types (`packages/shared`). The API is the only path to MongoDB. All data access goes through a tenant-scoped data layer (`apps/api/src/db/`), and all authorization goes through one pure policy function (`can`) applied by a deny-by-default Fastify hook. For the POC, the stack runs in Docker Compose (Caddy, API, MongoDB).

**Tech Stack:** Node 24 LTS, pnpm 10 workspaces, TypeScript (strict), Fastify 5 + `fastify-type-provider-zod` + `@fastify/swagger`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cookie`, MongoDB 8 (official `mongodb` driver), `argon2`, `otplib`, `@simplewebauthn/server` / `@simplewebauthn/browser`, `@aws-sdk/client-sesv2`, React 18, React Router, TanStack Query, Vitest (+ `@vitest/coverage-v8`), `mongodb-memory-server`, Testcontainers (`@testcontainers/mongodb`), Playwright + `@axe-core/playwright`, Docker Compose, Caddy (built with `caddy-ratelimit`).

**Spec:** `docs/prd.md` (a copy of the [PRD doc](https://claude.ai/artifact/LGUFMSk7c39zAFcG2Zkrd2)). Sections this plan implements: Users and roles, Data model (Tenant, User, Membership, Roadmap, Audit event), FR-1.1 (picker only), Security and non-functional requirements (Authentication, Authorization and tenant isolation, Data protection as it applies to the app, Audit log, Application security), Quality and testing, and the POC part of Infrastructure options.

**Not in this plan:** These are later v1 plans: projects and the three views (FR-1.2–1.9), snapshots and PDF (FR-3), calendar feed (FR-4), notifications (FR-5), and POC Terraform, EC2 and backups. v2 and v3 are also out.

## Global Constraints

- Single TypeScript codebase. All config comes from environment variables, validated at startup. Nothing except MongoDB writes to local disk (PRD, "Moving from POC to production").
- Every collection has `tenantId`, and every index starts with `tenantId` (PRD Architecture: "tenantId on every collection and in every index"). The only exceptions are the pre-auth lookup indexes listed in Task 2.
- Only `apps/api/src/db/**` may import from `mongodb`. ESLint `no-restricted-imports` enforces this.
- Authorization checks live only in `apps/api/src/policy/`. Route handlers never compare roles.
- Request validation uses zod. All API routes live under `/api`. Errors are JSON `{ "error": "<snake_case_code>" }`.
- MFA is required for every user. TOTP is the primary second factor, and passkeys (WebAuthn) are allowed as passwordless sign-in or as the second factor.
- Passwords are hashed with Argon2id and checked against the breached-password list (HIBP k-anonymity range API).
- Session cookie: `__Host-sid`, `HttpOnly; Secure; SameSite=Lax; Path=/`. State-changing requests carry `x-csrf-token`.
- Snapshot passwords and feed tokens are stored only as hashes. That rule also applies here to session, invite, reset and recovery-code tokens (SHA-256 of 32 random bytes, base64url).
- The audit log is append-only, kept 30 days through a TTL index (`expireAfterSeconds: 2592000`), and viewable by Owners and Admins for their own roadmaps.
- Strict CSP, HSTS (`max-age=31536000; includeSubDomains`), TLS terminated by Caddy on the POC.
- Definition of done applies to every task: unit plus functional tests, permission tests for each role touched plus a cross-tenant check, coverage ≥ 80%, security scans pass, axe passes on new screens, and the FR or section ID appears in the test name.
- Accessibility WCAG 2.1 AA. Every screen works from 375 px wide (FR-1.9).
- On-screen copy and UI/UX notes follow the `mobbin:plain-writing` rules. The exact copy is in the UI/UX plan section before Task 12.
- **Plan decisions where the PRD is silent** (change them here if you disagree, and every task follows):
  - Session idle timeout 30 min, absolute lifetime 12 h, pending-MFA session lifetime 10 min.
  - Sign-in lockout: 5 consecutive failures (password or second factor) locks the account for 15 min. `/api/auth/*` is rate-limited to 10 requests per minute per IP.
  - Locked and wrong-credential responses are both `401 { error: "invalid_credentials" }`, so neither reveals whether an account exists.
  - Password length 12–128 characters. If the breached-password API can't be reached, the check fails open and logs a warning.
  - TOTP: 6 digits, 30 s step, ±1 step window. 10 recovery codes in the format `XXXXX-XXXXX` (Crockford base32), each single-use.
  - TOTP enrollment is mandatory at first sign-in. Passkeys are added later from Security settings.
  - Invite links expire after 7 days, password-reset links after 1 h, and the bootstrap setup link after 24 h.
  - TOTP secrets are encrypted in the app with AES-256-GCM using `TOTP_ENC_KEY`.
  - v1 has one tenant per email address: `users.email` is globally unique.
  - Account events with no roadmap (sign-ins, password resets, passkey changes) are recorded in the audit log but have no screen in this plan. The audit page lists roadmap events only.

## Review Focus

1. **Email with different case or extra spaces** (`" Lance@Example.com"`): invite, sign-in and reset must all resolve to the same account. Emails are normalized with `trim().toLowerCase()` at the zod boundary (`emailSchema`). Tests are in Task 6 and Task 10.
2. **Invite link reused, expired, revoked, or sent to someone already a member**: return a clear `410 invite_invalid` or `409 already_member`, and never create a duplicate membership, even when two accepts race. Tests are in Task 10.
3. **A roadmap left without an Owner**: removing or demoting the Owner, or transferring to a non-member, is refused (`409 owner_immutable`, `422 not_a_member`). Tests are in Task 11.
4. **The same TOTP code used twice inside its 30 s window**: the second use is rejected, while a code one step old (clock drift) is accepted. Tests are in Task 7.
5. **Sign out everywhere, or a password reset**: every existing session cookie for that user stops working on the next request. Tests are in Task 5 and Task 9.

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js, .gitignore, .env.example
.github/workflows/ci.yml
packages/shared/src/
  roles.ts            Role, ROLES, Action, ACTIONS
  schemas.ts          emailSchema, passwordSchema, shared request/response zod schemas
  index.ts
apps/api/src/
  config.ts           loadConfig(env) → Config
  app.ts              buildApp(deps) → FastifyInstance (plugins, hooks, routes)
  server.ts           process entry
  errors.ts           HttpError, error handler
  db/client.ts        connectDb
  db/indexes.ts       ensureIndexes
  db/types.ts         document types for every collection
  db/scoped.ts        scoped(db, tenantId) → ScopedDb
  db/unscoped.ts      pre-auth lookups only
  policy/policy.ts    can()
  policy/hook.ts      authPlugin (session resolution + deny-by-default authorization)
  audit/audit.ts      createAuditLog
  audit/routes.ts     GET /api/roadmaps/:roadmapId/audit
  auth/tokens.ts      newToken, hashToken
  auth/crypto.ts      encryptSecret, decryptSecret
  auth/passwords.ts   hashPassword, verifyPassword, isBreached
  auth/lockout.ts     recordFailure, recordSuccess, isLocked
  auth/sessions.ts    createSessionStore
  auth/totp.ts        TOTP enroll/verify with replay guard
  auth/recovery.ts    recovery codes
  auth/passkeys.ts    WebAuthn ceremonies
  auth/routes.ts      login, MFA, enroll, logout, me
  auth/passkey-routes.ts
  auth/reset-routes.ts
  mail/mailer.ts      Mailer + SES / file / memory implementations
  mail/templates.ts   inviteEmail, resetEmail
  roadmaps/routes.ts  create, list, delete, transfer
  invites/routes.ts   create, info, accept
  members/routes.ts   list, change role, remove
  cli/bootstrap.ts    create tenant + first user
apps/api/test/        helpers.ts + *.test.ts per module
apps/api/Dockerfile
apps/web/src/
  main.tsx, App.tsx (routes), api/client.ts, auth/*, roadmaps/*, members/*, audit/*, settings/*
apps/web/e2e/         global-setup.ts, helpers.ts, *.spec.ts
apps/web/playwright.config.ts
deploy/poc/docker-compose.yml, deploy/poc/Caddyfile, deploy/poc/caddy.Dockerfile
scripts/smoke.sh
```

---

### Task 1: Monorepo scaffold, CI, and health endpoint

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `.env.example`, `.github/workflows/ci.yml`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/api/{package.json,tsconfig.json,vitest.config.ts,src/app.ts,src/server.ts}`
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx}`
- Test: `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: AppDeps): Promise<FastifyInstance>` in `apps/api/src/app.ts`. `AppDeps` is `{}` for now; later tasks add fields. `GET /api/health` returns `200 { status: "ok" }`.
- Produces: root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test` (Vitest in every package), `pnpm test:e2e` (Playwright in `apps/web`).
- Produces: package names `@roadmap/shared`, `@roadmap/api`, `@roadmap/web`.

- [ ] **Step 1: `git init`, set up workspaces and tooling.** Turn on TypeScript `strict`, `noUncheckedIndexedAccess`, and ESM (`"type": "module"`). ESLint flat config uses typescript-eslint `recommendedTypeChecked`, plus `no-restricted-imports` banning `mongodb` in `apps/api/src/**` except `apps/api/src/db/**`. Vitest coverage thresholds are 80% for lines, functions and branches in `apps/api` and `packages/shared`. In `apps/web`, Vitest coverage counts only `src/api/**`, because Playwright covers the screens.
- [ ] **Step 2: Write the failing test** `health.test.ts`:

```ts
test('GET /api/health returns ok', async () => {
  const app = await buildApp({});
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
```

- [ ] **Step 3: Run** `pnpm --filter @roadmap/api test`. Expected: FAIL (`buildApp` is not defined).
- [ ] **Step 4: Implement `buildApp`** with the zod type provider (`validatorCompiler`/`serializerCompiler`) and the route. `server.ts` listens on `PORT` (default 3000). The web app is a "Roadmap" placeholder page, and Vite proxies `/api` to `http://localhost:3000`.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm test`. Expected: all PASS.
- [ ] **Step 6: Write `ci.yml`.** On pull requests it runs these jobs: `lint` and `typecheck`; `unit-and-api` (`pnpm test --coverage`; Testcontainers works on `ubuntu-latest`); `security`, made of `pnpm audit --audit-level=high`, `gitleaks/gitleaks-action`, and `github/codeql-action` (javascript-typescript); and `e2e` (`pnpm test:e2e`, filled in by Task 12). Pin each action to a commit SHA. Every job must pass, so failures block the merge.
- [ ] **Step 7: Commit** `chore: scaffold monorepo, CI and health endpoint`.

---

### Task 2: Config, MongoDB connection and the tenant-scoped data layer

**Files:**
- Create: `apps/api/src/config.ts`, `src/db/client.ts`, `src/db/types.ts`, `src/db/indexes.ts`, `src/db/scoped.ts`, `src/db/unscoped.ts`
- Test: `apps/api/test/config.test.ts`, `apps/api/test/db/scoped.test.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`. It throws a `ConfigError` that lists every missing or invalid key. `Config` is:
  `{ nodeEnv: 'development'|'test'|'production'; port: number; mongoUri: string; mongoDb: string; appOrigin: string; webauthnRpId: string; webauthnRpName: string; totpEncKey: Buffer /* 32 bytes, from base64 */; mailer: 'ses'|'file'|'memory'; mailFrom: string; mailOutboxFile?: string; awsRegion: string; hibpEnabled: boolean }`
- Produces: `connectDb(uri: string, dbName: string): Promise<{ client: MongoClient; db: Db }>` and `ensureIndexes(db: Db): Promise<void>`.
- Produces: the document types in `db/types.ts`: `TenantDoc`, `UserDoc`, `MembershipDoc`, `RoadmapDoc`, `SessionDoc`, `InviteDoc`, `ResetTokenDoc`, `WebauthnChallengeDoc`, `AuditEventDoc`. `_id` is a `string` (UUID v7 via `uuid`), and every doc except `TenantDoc` and `WebauthnChallengeDoc` has `tenantId: string`. Each later task adds its fields to these types. `UserDoc` starts as `{ _id, tenantId, email, name, timezone: string, passwordHash: string|null, createdAt: Date }`.
- Produces: `scoped(db: Db, tenantId: string): ScopedDb`, where:
  ```ts
  type CollectionName = 'users'|'memberships'|'roadmaps'|'sessions'|'invites'|'resetTokens';
  interface ScopedCollection<T extends { tenantId: string }> {
    findOne(filter: Filter<T>): Promise<T | null>;
    find(filter: Filter<T>, opts?: { sort?: Sort; limit?: number }): Promise<T[]>;
    insertOne(doc: Omit<T, 'tenantId'>): Promise<T>;
    updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<{ matched: number }>;
    findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T>): Promise<T | null>; // returns the updated doc
    deleteOne(filter: Filter<T>): Promise<{ deleted: number }>;
    deleteMany(filter: Filter<T>): Promise<{ deleted: number }>;
    countDocuments(filter: Filter<T>): Promise<number>;
  }
  interface ScopedDb {
    tenantId: string;
    collection<N extends CollectionName>(name: N): ScopedCollection<DocFor<N>>;
    audit: { insertOne(doc: Omit<AuditEventDoc, 'tenantId'>): Promise<void>; find(filter: Filter<AuditEventDoc>, opts: { sort: Sort; limit: number }): Promise<AuditEventDoc[]> };
    withTransaction<R>(fn: (s: ScopedDb) => Promise<R>): Promise<R>;
  }
  ```
  Every method merges `{ tenantId }` into the filter and the inserted doc. It **throws** if a caller's filter, doc or `$set` already contains a different `tenantId`. `audit` has no update or delete.
- Produces: `unscoped(db: Db)`, the only pre-auth access. It returns `{ findUserByEmail(email): Promise<UserDoc|null>; findSessionByTokenHash(h): Promise<SessionDoc|null>; findInviteByTokenHash(h): Promise<InviteDoc|null>; findResetByTokenHash(h): Promise<ResetTokenDoc|null>; insertChallenge(c: WebauthnChallengeDoc): Promise<void>; takeChallenge(id): Promise<WebauthnChallengeDoc|null> /* find and delete */; findUserByCredentialId(id): Promise<UserDoc|null>; insertTenant(t: TenantDoc): Promise<void> }`.
- Produces in `test/helpers.ts`: `startMongo(): Promise<{ uri: string; stop(): Promise<void> }>` (Testcontainers `mongo:8.0`, replica set) and `memoryMongo()` (mongodb-memory-server replset) for unit tests.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`: `loadConfig({})` throws, and the message names `MONGO_URI`, `APP_ORIGIN` and `TOTP_ENC_KEY`. A `TOTP_ENC_KEY` that decodes to anything other than 32 bytes throws. A full valid env returns the typed config.
  - `scoped.test.ts` (memoryMongo):
    - `test('Tenant isolation: tenant B cannot read tenant A user')` inserts a user via `scoped(db,'A')`, then expects `scoped(db,'B').collection('users').findOne({ email })` to be `null`.
    - `test('Tenant isolation: update and delete never cross tenants')` runs `scoped(db,'B').collection('users').updateOne({ _id: aUserId }, …)` and expects `matched` to be 0. The same goes for `deleteOne`, and the doc is unchanged.
    - `test('rejects a filter or doc that names another tenant')`: `findOne({ tenantId: 'A' })` from scope B throws, and so does `insertOne({ …, tenantId: 'A' })`.
    - `test('audit collection exposes no update or delete')` expects `'updateOne' in scoped(db,'A').audit` to be false.
    - `test('ensureIndexes creates tenant-first indexes and the audit TTL')` lists the indexes. Every non-`_id` index's first key is `tenantId`, except `users.email` (unique), `sessions.tokenHash`, `invites.tokenHash`, `resetTokens.tokenHash`, `webauthnChallenges._id`, `users.passkeys.credentialId`. `auditEvents` has `{ timestamp: 1 }` with `expireAfterSeconds: 2592000`, and `sessions`, `resetTokens`, `webauthnChallenges` have TTLs on `expiresAt` (`expireAfterSeconds: 0`). `memberships` has a unique index `{ tenantId, roadmapId, userId }`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test config scoped`. Expected: FAIL.
- [ ] **Step 3: Implement** `loadConfig` (zod over `process.env`), `connectDb`, `ensureIndexes`, `scoped`, `unscoped`. `withTransaction` uses `client.startSession().withTransaction`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm lint`: a temporary `import 'mongodb'` in `src/app.ts` must fail lint (check this, then remove it).
- [ ] **Step 5: Commit** `feat(api): config and tenant-scoped data layer`.

---

### Task 3: Central permission policy

**Files:**
- Create: `packages/shared/src/roles.ts`, `apps/api/src/policy/policy.ts`
- Test: `apps/api/test/policy/policy.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export const ROLES = ['owner', 'admin', 'contributor'] as const; export type Role = typeof ROLES[number];
  export const ACTIONS = ['roadmap.view','project.create','project.edit','project.delete','project.setPriority','project.assign',
    'idea.submit','vote.cast','comment.create','idea.convert','snapshot.create',
    'member.invite','member.remove','member.changeRole','roadmap.delete','roadmap.transfer','ai.use','audit.view'] as const;
  export type Action = typeof ACTIONS[number];
  ```
- Produces: `can(input: { role: Role | null; action: Action; ctx?: PolicyContext }): boolean`, where `PolicyContext = { isAssigned?: boolean; targetRole?: Role; newRole?: Role }`. It is a pure function with no I/O. Later plans call it for project, idea and snapshot actions, so the whole PRD table is encoded now.

- [ ] **Step 1: Write the failing table-driven test** `policy.test.ts`. Name it `'Permissions table (PRD Users and roles)'`. Encode the PRD table exactly:

| Action(s) | owner | admin | contributor |
| --- | --- | --- | --- |
| roadmap.view, idea.submit, vote.cast, comment.create, ai.use | ✓ | ✓ | ✓ |
| project.create, project.edit, project.delete | ✓ | ✓ | only `ctx.isAssigned === true` |
| project.setPriority, project.assign, idea.convert, snapshot.create, audit.view | ✓ | ✓ | ✗ |
| member.invite (needs `newRole`), member.remove (needs `targetRole`), member.changeRole (needs both) | ✓ | only when every required role is `admin` or `contributor` | ✗ |
| roadmap.delete, roadmap.transfer | ✓ | ✗ | ✗ |

  The test also asserts:
  - `role: null` is denied for every action.
  - `member.remove`/`member.changeRole` with `targetRole: 'owner'` is denied for **every** role, owner included, because ownership only moves by transfer.
  - `member.invite` with `newRole: 'owner'` is denied for every role.
  - A contributor with `isAssigned: true` is still denied `project.setPriority` and `project.assign`.
  - A `member.*` call missing a required `ctx` role is denied (fail closed).
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test policy`. Expected: FAIL.
- [ ] **Step 3: Implement `can`** as a lookup table plus the three context rules above. Unknown actions return `false`.
- [ ] **Step 4: Run.** Expected: PASS with 100% branch coverage of `policy.ts`.
- [ ] **Step 5: Commit** `feat(api): central permission policy`.

---

### Task 4: Audit log service

**Files:**
- Create: `apps/api/src/audit/audit.ts`
- Modify: `apps/api/src/db/types.ts` (`AuditEventDoc`)
- Test: `apps/api/test/audit/audit.test.ts`

**Interfaces:**
- Consumes: `scoped(db, tenantId).audit`.
- Produces:
  ```ts
  type AuditActor = { type: 'user'; userId: string } | { type: 'ai'; onBehalfOf: string } | { type: 'system' };
  interface AuditInput { action: AuditAction; actor: AuditActor; roadmapId?: string; target: { type: string; id: string }; before?: unknown; after?: unknown; ip: string | null; }
  type AuditAction = 'auth.login.success'|'auth.login.failure'|'auth.mfa.failure'|'auth.logout'|'auth.logout_all'|'auth.password_reset'|'auth.totp.enrolled'|'auth.recovery.regenerated'|'auth.passkey.added'|'auth.passkey.removed'
    |'roadmap.create'|'roadmap.delete'|'roadmap.transfer'|'invite.create'|'invite.accept'|'invite.revoke'|'member.role_change'|'member.remove';
  interface AuditLog {
    record(s: ScopedDb, e: AuditInput): Promise<void>;                // timestamp = now
    list(s: ScopedDb, q: { roadmapId: string; action?: AuditAction; actorId?: string; from?: Date; to?: Date; cursor?: string; limit?: number /* default 50, max 200 */ })
      : Promise<{ items: AuditEventDoc[]; nextCursor: string | null }>; // newest first
  }
  export function createAuditLog(): AuditLog;
  ```
  Later plans add their own action strings to `AuditAction`. `before` and `after` must never include `passwordHash`, `totpSecret`, token hashes or recovery-code hashes. `record` strips them using a fixed list of keys: `passwordHash`, `totp`, `recoveryCodes`, `tokenHash`, `passkeys`.

- [ ] **Step 1: Write the failing tests:**
  - `'Audit log: record then list newest first with cursor paging'` inserts 3 events, then `list({limit:2})` returns 2 items, newest first, with a `nextCursor`, and the next page returns 1 item.
  - `'Audit log: filters by action, actor and date range'`.
  - `'Audit log: list is scoped to tenant and roadmap'` checks that an event in tenant B, or in roadmap R2, does not appear.
  - `'Audit log: secrets are stripped from before/after'` checks that `record(..., { after: { name: 'x', passwordHash: 'h' } })` stores `after` without `passwordHash`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test audit`. Expected: FAIL.
- [ ] **Step 3: Implement.** The cursor is base64url of `${timestamp.toISOString()}|${_id}`, using a `(timestamp, _id)` descending sort. Add the index `{ tenantId: 1, roadmapId: 1, timestamp: -1 }` in `ensureIndexes`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): append-only audit log service`.

---

### Task 5: Sessions, CSRF, security headers and the deny-by-default auth hook

**Files:**
- Create: `apps/api/src/auth/tokens.ts`, `src/auth/sessions.ts`, `src/policy/hook.ts`, `src/errors.ts`
- Modify: `apps/api/src/app.ts` (register helmet, rate-limit, cookie, authPlugin, error handler), `src/db/types.ts` (`SessionDoc`)
- Test: `apps/api/test/auth/sessions.test.ts`, `apps/api/test/policy/hook.test.ts`

**Interfaces:**
- Produces: `newToken(): { token: string; hash: string }` (32 random bytes, base64url, with a SHA-256 hex hash) and `hashToken(token: string): string`.
- Produces: `SessionDoc = { _id, tenantId, userId, tokenHash, state: 'pending_mfa'|'pending_enroll'|'full', csrfToken: string, createdAt, lastSeenAt, expiresAt, ip, userAgent, webauthnChallenge?: string }`.
- Produces `createSessionStore(db: Db, opts?: { now?: () => Date })`, returning:
  - `create(s: ScopedDb, userId: string, state: SessionDoc['state'], meta: { ip: string; userAgent: string }): Promise<{ token: string; session: SessionDoc }>`. A `full` session has `expiresAt = now + 12 h` and a pending one has `now + 10 min`.
  - `resolve(token: string): Promise<SessionDoc | null>`. It returns null if the session is missing, past `expiresAt`, or idle for more than 30 min. It updates `lastSeenAt` at most once per 60 s.
  - `upgrade(s: ScopedDb, sessionId: string, state: 'full'|'pending_enroll'): Promise<{ token: string }>`. It **rotates the token** (session fixation defense) and resets `expiresAt` for the new state.
  - `revoke(s: ScopedDb, sessionId: string): Promise<void>` and `revokeAllForUser(s: ScopedDb, userId: string): Promise<number>`.
- Produces: `setSessionCookie(reply, token)` and `clearSessionCookie(reply)`, which set or clear `__Host-sid`.
- Produces: the Fastify route option `config.auth: { level: 'public' } | { level: 'pending'; states: Array<SessionDoc['state']> /* may include 'full' */ } | { level: 'full'; action?: Action; roadmapParam?: string; ctx?: (req) => Promise<PolicyContext> }`.
  `authPlugin` sets `req.actor = { userId, tenantId, sessionId, role: Role | null, db: ScopedDb }` and then works as follows:
  - A route registered without `config.auth` fails startup: `app.ready()` throws `route_without_auth_config: <method> <url>`.
  - No or invalid session on a non-public route returns `401 unauthenticated`.
  - A session whose state isn't allowed returns `403 mfa_required`.
  - Non-GET requests to non-public routes without `x-csrf-token === session.csrfToken` return `403 csrf`. Public routes skip the check, because the `SameSite=Lax` cookie is not sent on cross-site POSTs.
  - On `public` routes a valid session cookie is still resolved, so `req.actor` is set when one is present and is `null` otherwise.
  - For `action`, it loads the membership for `req.params[roadmapParam]` in the actor's tenant. No membership returns `404 not_found`, which doesn't reveal that the roadmap exists. Otherwise, `can({ role, action, ctx })` false returns `403 forbidden`.
- Produces: `HttpError(status: number, code: string)` and a handler that maps zod errors to `400 { error: 'validation', issues }`. Unknown errors become `500 { error: 'internal' }`, with no stack trace in production.
- Produces: `AppDeps = { config: Config; db: Db; now?: () => Date }`. Update `health.test.ts` to build the app through `makeTestApp`.
- Produces in `test/helpers.ts`: `Seeder = { tenant(name?): Promise<TenantDoc>; user(tenantId, o?: { email?: string; password?: string; totp?: boolean }): Promise<UserDoc & { totpSecret?: string }>; roadmap(tenantId, ownerId, name?): Promise<RoadmapDoc>; member(tenantId, roadmapId, userId, role: Role): Promise<MembershipDoc> }`. Each method gains fields as later tasks add them to the document types.
- Produces in `test/helpers.ts`: `makeTestApp(opts?): Promise<{ app; db; seed: Seeder; close() }>` (Task 9 adds `mail: MemoryMailer`), and `signInAs(app, db, userId): Promise<{ cookie: string; csrf: string }>`, which creates a `full` session directly through the session store.

- [ ] **Step 1: Write the failing tests.**
  - `sessions.test.ts` (fake clock):
    - Idle 31 min resolves to null.
    - Active use every 20 min still dies at 12 h.
    - A pending session dies at 10 min.
    - `upgrade` gives a new token, and the old token resolves to null.
    - `'Review focus 5: revokeAllForUser kills every session of that user only'`: 3 sessions for user U and 1 for user V. After the call, all of U's tokens resolve to null and V's still resolves.
  - `hook.test.ts` registers test-only routes in `makeTestApp` and checks:
    - A route without `config.auth` makes `ready()` throw.
    - A `full` route with no cookie returns 401.
    - A `pending_mfa` session on a `full` route returns 403 `mfa_required`.
    - A POST without `x-csrf-token` returns 403 `csrf`.
    - `'Tenant isolation: member of roadmap in tenant A gets 404 for tenant B roadmap id'`.
    - A contributor on an `audit.view` route returns 403.
    - Response headers include a CSP containing `default-src 'self'`, `frame-ancestors 'none'`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
    - The 11th request to `/api/auth/*` from the same IP within a minute returns 429.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test sessions hook`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the cookie helpers, `authPlugin` (an `onRoute` hook collects routes missing `config.auth`, and an `onReady` hook throws), helmet with CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, rate-limit scoped to the `/api/auth` prefix, and the error handler. Add `config.auth: { level: 'public' }` to `/api/health`. The audit write for logout happens in Task 6's routes.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): sessions, CSRF, security headers and deny-by-default authorization`.

---

### Task 6: Passwords, sign-in, lockout, logout and /me

**Files:**
- Create: `apps/api/src/auth/passwords.ts`, `src/auth/lockout.ts`, `src/auth/routes.ts`, `packages/shared/src/schemas.ts`
- Modify: `src/db/types.ts` (`UserDoc` gets `failedLogins: number; lockedUntil: Date | null`), `src/app.ts`
- Test: `apps/api/test/auth/passwords.test.ts`, `apps/api/test/auth/login.test.ts`

**Interfaces:**
- Produces (shared): `emailSchema = z.string().trim().toLowerCase().email().max(254)` and `passwordSchema = z.string().min(12).max(128)`.
- Produces: `hashPassword(pw: string): Promise<string>` (argon2id; `memoryCost: 19456, timeCost: 2, parallelism: 1`, the OWASP minimum) and `verifyPassword(hash: string, pw: string): Promise<boolean>`.
- Produces: `isBreached(pw: string, fetchFn?: typeof fetch): Promise<boolean>`. It sends a GET to `https://api.pwnedpasswords.com/range/<first 5 hex chars of SHA-1, uppercase>` with the header `Add-Padding: true` and matches the suffix. On a network error it returns `false` and logs `warn`. It is skipped when `config.hibpEnabled` is false.
- Produces: `assertNewPasswordAllowed(pw: string, deps): Promise<void>`. It throws `HttpError(422, 'password_too_short' | 'password_breached')`. Task 9 and Task 10 use it.
- Produces: `recordFailure(s, userId)`, which locks the account at 5 failures for 15 min; `recordSuccess(s, userId)`, which resets the counter; and `isLocked(user, now): boolean`.
- Produces the routes, all `public` unless noted:
  - `POST /api/auth/login {email, password}` returns `200 { next: 'mfa' | 'enroll', csrfToken }` and sets a session cookie with state `pending_mfa` (if the user has TOTP or a passkey) or `pending_enroll`. Bad credentials, an unknown email, or a locked account all return `401 invalid_credentials`. To keep timing equal for unknown emails, it verifies against a fixed dummy argon2 hash.
  - `POST /api/auth/logout` (`full` or pending) revokes the session and clears the cookie, returning 204.
  - `POST /api/auth/logout-all` (`full`) calls `revokeAllForUser` and returns 204.
  - `GET /api/me` (`full`) returns `{ user: { id, email, name, timezone, hasTotp: boolean, passkeys: { id, name, createdAt }[] }, csrfToken, memberships: { roadmapId, roadmapName, role }[] }`, where memberships exclude archived roadmaps and are sorted by name.
- Audit: `auth.login.failure` (only for a known user, with target that user), `auth.logout`, `auth.logout_all`. `auth.login.success` is recorded in Task 7 or Task 8 once the second factor passes.

- [ ] **Step 1: Write the failing tests.**
  - `passwords.test.ts`:
    - The hash starts with `$argon2id$`, and verify returns true for the right password and false for a wrong one.
    - `isBreached` works with a stubbed fetch, returning a padded body that contains the suffix with count 3 (true), or count 0 for a padding row (false).
    - A fetch that throws returns false.
    - An 11-character password gives `password_too_short`.
  - `login.test.ts` (Testcontainers):
    - A correct password with TOTP set gives `next: 'mfa'`, and `/api/me` with that cookie returns 403 `mfa_required`.
    - A user without TOTP gives `next: 'enroll'`.
    - A wrong password gives 401 `invalid_credentials`, and so does an unknown email.
    - `'lockout: 5 failures lock for 15 min even with the right password'` checks that a correct password then returns 401, and after the fake clock moves 15 min it succeeds.
    - `'Review focus 1: login email is case- and space-insensitive'`: a user stored as `lance@example.com` can log in with `"  Lance@Example.COM "`.
    - `logout-all` makes every other cookie of that user get 401 on `/api/me`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test passwords login`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): password sign-in with lockout and logout`.

---

### Task 7: TOTP enrollment, verification and recovery codes

**Files:**
- Create: `apps/api/src/auth/crypto.ts`, `src/auth/totp.ts`, `src/auth/recovery.ts`
- Modify: `src/auth/routes.ts`, `src/db/types.ts` (`UserDoc` gets `totp: { secretEnc: string; lastStep: number } | null; pendingTotpSecretEnc: string | null; recoveryCodes: { hash: string; usedAt: Date | null }[]`)
- Test: `apps/api/test/auth/totp.test.ts`, `apps/api/test/auth/mfa-routes.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plain: string, key: Buffer): string` and `decryptSecret(enc: string, key: Buffer): string`. They use AES-256-GCM, store `iv.tag.ciphertext` in base64url, and decrypt throws on tamper.
- Produces: `verifyTotp(secret: string, code: string, lastStep: number, now: Date): { ok: true; step: number } | { ok: false }`. It uses otplib `authenticator` with `{ step: 30, window: 1, digits: 6 }`, computes the step as `floor(now/30s) + delta`, and rejects `step <= lastStep`.
- Produces: `generateRecoveryCodes(): { codes: string[]; hashes: string[] }` (10 codes in `XXXXX-XXXXX` Crockford base32, hashed with SHA-256 after removing the dash and uppercasing) and `consumeRecoveryCode(s, userId, code): Promise<boolean>`, an atomic `findOneAndUpdate` on an unused hash.
- Produces the routes:
  - `POST /api/auth/totp/enroll/start` (`pending_enroll` or `full`) returns `{ secret, otpauthUrl }`. The secret is stored encrypted in `pendingTotpSecretEnc`, and `otpauthUrl` uses the issuer `config.webauthnRpName`.
  - `POST /api/auth/totp/enroll/confirm {code}` (same levels) verifies against the pending secret, moves it to `totp`, issues recovery codes, and upgrades the session to `full`. It returns `{ recoveryCodes: string[], csrfToken }`, and the codes are shown once. A wrong code returns `422 invalid_code`. Audit: `auth.totp.enrolled`.
  - `POST /api/auth/mfa/totp {code}` (`pending_mfa`) succeeds by calling `upgrade(full)` and returning `{ csrfToken }`. Failure calls `recordFailure` and returns `401 invalid_code`. Audit: `auth.login.success` or `auth.mfa.failure`.
  - `POST /api/auth/mfa/recovery {code}` (`pending_mfa`) works the same way, and the response includes `{ remainingRecoveryCodes: number }`.
  - `POST /api/auth/recovery-codes` (`full`, which requires the current TOTP `code` in the body) replaces all codes and returns `{ recoveryCodes }`. Audit: `auth.recovery.regenerated`.

- [ ] **Step 1: Write the failing tests.**
  - `totp.test.ts`:
    - Encrypt then decrypt round-trips, and one flipped ciphertext byte throws.
    - A current code is ok.
    - `'Review focus 4: a code one step old is accepted, the same code twice is rejected'` checks that the first `verifyTotp` gives `{ok:true, step:n}`, and a second call with `lastStep:n` and the same code gives `{ok:false}`.
    - A code 2 steps old is rejected.
    - The 10 recovery codes are unique and match `/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/`.
  - `mfa-routes.test.ts`:
    - Full flow: login, enroll start, confirm with a code generated by otplib from the returned secret, then `/api/me` returns 200 with `hasTotp: true`, and the session token has rotated (the pre-enroll cookie gets 401).
    - A recovery code works once, and the second use returns 401.
    - 5 wrong TOTP codes lock the account.
    - The stored user doc's `totp.secretEnc` does not contain the plain secret.
    - `POST /api/auth/mfa/totp` with a `full` session returns 403.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test totp mfa-routes`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): TOTP MFA with replay guard and recovery codes`.

---

### Task 8: Passkeys (WebAuthn)

**Files:**
- Create: `apps/api/src/auth/passkeys.ts`, `src/auth/passkey-routes.ts`
- Modify: `src/db/types.ts` (`UserDoc` gets `passkeys: { id: string; credentialId: string; publicKey: string; counter: number; transports: string[]; name: string; createdAt: Date }[]`, and `WebauthnChallengeDoc = { _id, challenge, expiresAt }`, which has no `tenantId` because it exists before any user is known, with a 5-minute TTL)
- Test: `apps/api/test/auth/passkeys.test.ts`

**Interfaces:**
- Consumes: `@simplewebauthn/server` with `rpID = config.webauthnRpId` and `origin = config.appOrigin`, `userVerification: 'required'`, and `residentKey: 'required'`.
- Produces: `createPasskeys(deps: { verifyReg: typeof verifyRegistrationResponse; verifyAuth: typeof verifyAuthenticationResponse })`, so tests can stub the two verifiers.
- Produces the routes:
  - `POST /api/auth/passkeys/register/options` (`full`) returns the creation options, with the challenge stored on the session.
  - `POST /api/auth/passkeys/register/verify {response, name}` (`full`) adds the passkey and returns `{ id }`. Audit: `auth.passkey.added`.
  - `DELETE /api/auth/passkeys/:id` (`full`) returns 204. Audit: `auth.passkey.removed`.
  - `POST /api/auth/passkeys/login/options` (`public`) returns request options. If a `pending_mfa` session cookie is present, `allowCredentials` is that user's passkeys and the challenge goes on the session. Otherwise this is passwordless: it uses discoverable credentials, stores the challenge in `webauthnChallenges`, and sets the cookie `__Host-wa=<challengeId>` (5 min).
  - `POST /api/auth/passkeys/login/verify {response}` (`public`) verifies the challenge and updates `counter`. In the second-factor case it upgrades the pending session to `full`. In the passwordless case it looks up the user with `unscoped.findUserByCredentialId` and creates a `full` session. It respects `isLocked`, and failure calls `recordFailure` and returns `401 invalid_credentials`. Audit: `auth.login.success` or `auth.mfa.failure`.

- [ ] **Step 1: Write the failing tests** (`passkeys.test.ts`). Stub `verifyRegistrationResponse` and `verifyAuthenticationResponse` via dependency injection (`createPasskeys({ verifyReg, verifyAuth })`), because real ceremonies are covered in the Task 12 E2E. The tests check:
  - Registering requires a `full` session (a pending session gets 403).
  - Passwordless verify creates a `full` session.
  - Second-factor verify upgrades the pending session and rotates the token.
  - A challenge older than 5 min is rejected.
  - A credential belonging to user V can't complete the second factor for user U's pending session (`allowCredentials` mismatch returns 401).
  - A locked user can't sign in with a passkey.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test passkeys`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): passkey sign-in and second factor`.

---

### Task 9: Mailer, password reset and tenant bootstrap

**Files:**
- Create: `apps/api/src/mail/mailer.ts`, `src/mail/templates.ts`, `src/auth/reset-routes.ts`, `src/cli/bootstrap.ts`
- Modify: `src/db/types.ts` (`ResetTokenDoc = { _id, tenantId, userId, tokenHash, expiresAt, usedAt: Date | null }`), `src/app.ts` (`AppDeps` gets `mailer: Mailer`), `apps/api/package.json` (adds a `"bootstrap"` script)
- Test: `apps/api/test/mail/mailer.test.ts`, `apps/api/test/auth/reset.test.ts`, `apps/api/test/cli/bootstrap.test.ts`

**Interfaces:**
- Produces: `interface Mailer { send(m: { to: string; subject: string; text: string; html: string }): Promise<void> }`, and `createMailer(config): Mailer`, which returns one of:
  - `SesMailer` (SESv2 `SendEmail`)
  - `FileMailer` (appends JSON lines to `mailOutboxFile`; used by E2E)
  - `MemoryMailer` (`{ sent: Msg[] }`; used by API tests)
- Produces: `inviteEmail({ roadmapName, inviterName, url }): {subject,text,html}` and `resetEmail({ url, expiresInMinutes }): {subject,text,html}`. All interpolated values are HTML-escaped.
- Produces: `issueResetToken(s: ScopedDb, userId: string, ttlMs: number): Promise<string>`. It returns the URL `${appOrigin}/reset/${token}`, and Task 10 and the CLI use it.
- Produces the routes (`public`):
  - `POST /api/auth/password-reset/request {email}` always returns `202`. If the user exists, it emails a reset link valid for 1 h.
  - `POST /api/auth/password-reset/confirm {token, password}` checks `assertNewPasswordAllowed`, sets the hash, marks the token used, clears lockout, and calls `revokeAllForUser`. It returns 204. An invalid, used or expired token returns `410 token_invalid`. Audit: `auth.password_reset`.
- Produces: `bootstrap({ tenantName, email, name }, deps): Promise<{ tenantId, userId, setupUrl }>`. It refuses if the email already exists. It creates the tenant and a passwordless user, then issues a 24 h reset token. The CLI is `pnpm --filter @roadmap/api bootstrap --tenant <name> --email <email> --name <name>`, and it prints the setup URL. This is how the first Owner exists, since there is no self-sign-up.

- [ ] **Step 1: Write the failing tests.**
  - `mailer.test.ts`: `FileMailer` appends one JSON line per send. `inviteEmail` escapes `<script>` in `roadmapName`.
  - `reset.test.ts`:
    - An unknown email gets 202 and no mail is sent.
    - A known email gets 202 and one mail containing `/reset/`.
    - Confirm with that token, then log in with the new password.
    - A token used twice returns 410, and so does a token after 61 min.
    - A breached password returns 422 `password_breached` (stub `isBreached`).
    - `'Review focus 5: password reset signs out every existing session'` checks that a cookie from before the reset gets 401 on `/api/me`.
    - `'Review focus 1: reset request email is case-insensitive'`.
  - `bootstrap.test.ts`: it creates a tenant and user, and the setup URL's token works with password-reset/confirm. Running it twice with the same email throws `email_exists`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test mailer reset bootstrap`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): mailer, password reset and tenant bootstrap`.

---

### Task 10: Roadmaps and invitations (FR-1.1)

**Files:**
- Create: `apps/api/src/roadmaps/routes.ts`, `src/invites/routes.ts`
- Modify: `src/db/types.ts` (`RoadmapDoc = { _id, tenantId, name, description, ownerId, archived: boolean, createdAt }`, `MembershipDoc = { _id, tenantId, roadmapId, userId, role: Role, createdAt }`, `InviteDoc = { _id, tenantId, roadmapId, email, role: 'admin'|'contributor', tokenHash, invitedBy, expiresAt, acceptedAt: Date|null, revokedAt: Date|null }`)
- Test: `apps/api/test/roadmaps/roadmaps.test.ts`, `apps/api/test/invites/invites.test.ts`

**Interfaces:**
- Produces the routes:
  - `POST /api/roadmaps {name (1–120), description? (≤2000)}` (`full`, no action: any signed-in user may create one) creates the roadmap and an `owner` membership in one transaction. It returns `201 { id }`. Audit: `roadmap.create`.
  - `GET /api/roadmaps` (`full`) returns the same list as `/api/me` memberships. This is the FR-1.1 picker source.
  - `POST /api/roadmaps/:roadmapId/invites {email, role}` (`member.invite`, `ctx: { newRole: body.role }`). It returns `409 already_member` if that email already has a membership. It revokes any open invite for the same email and roadmap, creates the invite (7 days), and emails `${appOrigin}/invite/${token}`. It returns `201 { id }`. Audit: `invite.create`.
  - `GET /api/invites/:token` (`public`) returns `{ roadmapName, email, role, accountExists: boolean }`, or `410 invite_invalid`.
  - `POST /api/invites/:token/accept` (`public`). The body is `{ name, password }` when there's no account, or empty when the caller is signed in.
    - The invite is claimed atomically with `findOneAndUpdate({ tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { $gt: now } }, { $set: { acceptedAt: now } })`. No match returns `410 invite_invalid`.
    - An existing account requires a `full` session of a user whose email matches the invite. Otherwise it returns `401 sign_in_required` and releases the claim (sets `acceptedAt` back to null).
    - With no account, it runs `assertNewPasswordAllowed`, creates the user (`timezone` from the body, default `'UTC'`), creates a `pending_enroll` session, and sets the cookie.
    - It creates the membership, and a unique-index violation maps to `409 already_member`. It returns `200 { roadmapId, next: 'enroll' | 'done' }`. Audit: `invite.accept`.

- [ ] **Step 1: Write the failing tests.**
  - `roadmaps.test.ts`:
    - Creating a roadmap makes the caller its owner, and it appears in `GET /api/roadmaps`.
    - `'Tenant isolation: GET /api/roadmaps never lists another tenant roadmaps'`.
    - An unauthenticated request returns 401.
  - `invites.test.ts`:
    - `'Permissions (member.invite): owner may invite admin or contributor, admin may invite admin or contributor, contributor gets 403, nobody may invite owner'`. Inviting with role owner is a 400 from zod, since role is an enum of admin|contributor.
    - New user: invite, read the link from `mail.sent`, `GET` the info, accept with name and password, get `next: 'enroll'`, finish enrollment, then `/api/me` lists the roadmap with role contributor.
    - Existing user: accept without a session gives 401 `sign_in_required`. After signing in, accept gives `next: 'done'`. Signed in as a different user gives 401.
    - `'Review focus 2: expired, revoked and used invites return 410'`.
    - `'Review focus 2: inviting an existing member returns 409'`.
    - `'Review focus 2: two concurrent accepts create exactly one membership'` runs `Promise.all` of 2 accepts on the same token. One returns 200, the other 410, and the membership count is 1.
    - Re-inviting revokes the earlier link.
    - `'Review focus 1: invite email is normalized'`: inviting `"Bob@Example.com "` stores `bob@example.com`.
    - `'Tenant isolation: admin of tenant A roadmap cannot invite to tenant B roadmap'` returns 404.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test roadmaps invites`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): roadmaps and invite-only membership (FR-1.1)`.

---

### Task 11: Member management, ownership transfer, roadmap deletion and the audit API

**Files:**
- Create: `apps/api/src/members/routes.ts`, `src/audit/routes.ts`
- Modify: `src/roadmaps/routes.ts`
- Test: `apps/api/test/members/members.test.ts`, `apps/api/test/audit/audit-routes.test.ts`

**Interfaces:**
- Produces the routes:
  - `GET /api/roadmaps/:roadmapId/members` (`roadmap.view`) returns `{ userId, name, email, role }[]` plus open invites `{ id, email, role, expiresAt }[]`.
  - `PATCH /api/roadmaps/:roadmapId/members/:userId {role: 'admin'|'contributor'}` (`member.changeRole`, `ctx: { targetRole: <target's current role>, newRole }`) returns 204. Audit: `member.role_change`, with before and after roles.
  - `DELETE /api/roadmaps/:roadmapId/members/:userId` (`member.remove`, `ctx: { targetRole }`) deletes the membership, revokes nothing else, and returns 204. Audit: `member.remove`.
  - `DELETE /api/roadmaps/:roadmapId/invites/:inviteId` (`member.invite`, `ctx: { newRole: invite.role }`) revokes the invite and returns 204. Audit: `invite.revoke`.
  - `POST /api/roadmaps/:roadmapId/transfer {userId}` (`roadmap.transfer`). If the target isn't a member it returns `422 not_a_member`. In one transaction, the target becomes `owner`, the old owner becomes `admin`, and `ownerId` is updated. It returns 204. Audit: `roadmap.transfer`.
  - `DELETE /api/roadmaps/:roadmapId {confirmName}` (`roadmap.delete`). If `confirmName !== name` it returns `422 confirm_mismatch`. It deletes the roadmap, its memberships and its invites in one transaction, and returns 204. Audit: `roadmap.delete`. Later plans extend this with projects and other child data.
  - `GET /api/roadmaps/:roadmapId/audit?action&actorId&from&to&cursor&limit` (`audit.view`) returns the `AuditLog.list` result, with actors resolved to `{ type, userId?, name? }`.
- The policy denies any `targetRole: 'owner'` (Task 3). When `targetRole` is owner, the route translates the resulting 403 into `409 owner_immutable`, so the client sees why.

- [ ] **Step 1: Write the failing tests.**
  - `members.test.ts`. Seed a roadmap with an owner O, admins A1 and A2, and contributors C1 and C2.
    - `'Permissions (member.changeRole/remove)'` is table-driven over actor ∈ {O, A1, C1} × target ∈ {A2, C2} × op ∈ {promote, demote, remove}. The expected results come from the Task 3 table: O and A1 are allowed and C1 always gets 403.
    - `'Review focus 3: owner cannot be demoted or removed by anyone, including themselves'` returns 409 `owner_immutable`.
    - `'Review focus 3: transfer to a non-member returns 422'`.
    - Transfer to A1 makes A1 the owner and O an admin. O can no longer `DELETE` the roadmap (403).
    - Delete with the wrong `confirmName` returns 422. Delete with the correct name returns 204, and the roadmap is gone from every member's `/api/me`.
    - An admin attempting delete or transfer gets 403.
    - `'Tenant isolation: tenant B owner gets 404 on tenant A members routes'`.
  - `audit-routes.test.ts`:
    - After invite, accept and role-change, `GET audit` as O lists the events newest first, with actor names.
    - Filter `action=member.role_change` returns only those events.
    - C1 gets 403.
    - The audit entries contain no `passwordHash`, `totp` or `tokenHash` anywhere (scan the JSON response body for those keys).
- [ ] **Step 2: Run** `pnpm --filter @roadmap/api test members audit-routes`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run the full suite `pnpm --filter @roadmap/api test --coverage`, which must PASS with at least 80% coverage.
- [ ] **Step 5: Add the OpenAPI document.** Register `@fastify/swagger` with the zod transform and serve `GET /api/openapi.json` (`public`). Add the test `'OpenAPI lists every /api route'`, which compares `app.printRoutes()` with the document paths.
- [ ] **Step 6: Commit** `feat(api): member management, transfer, delete and audit API`.

---

## UI/UX plan (Tasks 12 and 13)

This section and all on-screen copy follow the `mobbin:plain-writing` rules: name the thing, sentence case, straight quotes, no exclamation marks, no buzzwords, no em dashes. Tasks 12 and 13 build to it, and their E2E tests assert the copy below word for word.

No reference screens were looked at for this plan, so the layout and copy below are my opinion. Before building a screen, the implementer can run `mobbin:search` for screens of the same kind (sign-in with a code, member list with roles, audit log). A reference that changes a screen gets its link in the PR.

**Layout rules**

- Sign-in screens use one column, 400 px wide at most, centred. App screens are 960 px wide at most. Both keep a 16 px side gutter at 375 px.
- Each screen has one primary button. On sign-in screens it is full width below 600 px.
- Buttons, links in lists and form controls are at least 44 px tall.
- Labels sit above their fields. No placeholder stands in for a label.
- A field error shows under the field as text with an icon. A form error shows above the form in an alert with `role="alert"`.
- Buttons stay enabled. A missing step shows an error when the button is pressed.
- A destructive button is red, sits apart from the primary button, and opens a confirm dialog.

**Screens and copy**

| Screen | On it | Primary button | Messages |
| --- | --- | --- | --- |
| Sign in (`/login`) | Heading "Sign in". Fields "Email", "Password". Link "Forgot password?". Second button "Sign in with a passkey". | "Sign in" | Wrong details or locked account: "Email or password is incorrect." |
| Second step (`/login/mfa`) | Heading "Enter your 6-digit code". Field "Code from your authenticator app". Links "Use a recovery code", "Use a passkey". | "Verify" | "That code didn't work. Try the next one your app shows." |
| Set up authenticator (`/setup/totp`), step 1 | Heading "Set up your authenticator app". QR code. Text "Can't scan? Enter this key:" with the key. Field "6-digit code". | "Turn on" | "That code didn't work. Try the next one your app shows." |
| Set up authenticator, step 2 | Heading "Save your recovery codes". Text "Each code works once. You need one if you lose your phone." The 10 codes. Button "Download codes". Checkbox "I saved these codes". | "Continue" | Box not ticked: "Tick the box to confirm you saved your codes." |
| Forgot password (`/forgot`) | Heading "Reset your password". Field "Email". | "Send reset link" | After sending: "If an account exists for that email, a reset link is on its way. It works for 1 hour." |
| New password (`/reset/:token`) | Heading "Choose a new password". Field "New password" with hint "At least 12 characters." | "Save password" | "Use at least 12 characters." "This password has appeared in a data breach. Choose a different one." Bad link: "This link has expired or was already used." with link "Send a new link". |
| Invite (`/invite/:token`) | Heading "Join {roadmap name}". Text "You were invited as {role} with {email}." New account: fields "Name", "Password". Existing account: no fields. | "Create account" or "Sign in to join" | Bad link: "This invite has expired or was replaced. Ask the person who invited you for a new one." |
| Roadmaps (`/`) | Heading "Roadmaps". One row per roadmap with its name and a role badge. | "New roadmap" | Empty: "You don't have a roadmap yet." |
| Members (`/r/:id/members`) | Member table: name, email, role select, "Remove". Pending invites with "Revoke". Invite form: "Email", "Role". Owner only, under "Danger zone": "Transfer ownership", "Delete roadmap". | "Send invite" | Remove: "Remove {name} from {roadmap name}? They lose access right away." Delete: "Type {roadmap name} to delete it. This can't be undone." Already a member: "{email} is already a member." |
| Audit log (`/r/:id/audit`) | Filters "Action", "From", "To". One row per event: time, then a sentence such as "Maria changed Bob's role from Contributor to Admin." | "Load more" | Empty: "No events in this range." |
| Security (`/settings/security`) | Section "Passkeys": list with "Remove", button "Add a passkey". Section "Recovery codes": button "Make new codes", text "Your old codes stop working." Section "Sessions": button "Sign out everywhere". | None | After sign out everywhere: the sign-in screen. |

One element keeps one name everywhere: "roadmap", "member", "invite", "recovery code", "passkey", "authenticator app".

### Task 12: Web: app shell and sign-in screens

**Files:**
- Create: `apps/web/src/api/client.ts`, `src/auth/{LoginPage,MfaPage,EnrollTotpPage,ForgotPage,ResetPage,InvitePage,RequireAuth}.tsx`, `src/ui/{Layout,Field,Button,Alert}.tsx`, `src/styles.css`
- Create: `apps/web/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/helpers.ts`, `e2e/auth.spec.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: every API route from Tasks 6–10, and `@simplewebauthn/browser` (`startAuthentication`).
- Produces: `api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T>`. It sends `credentials: 'same-origin'` and attaches `x-csrf-token` from an in-memory store, which is set from the login, MFA and `/api/me` responses. It throws `ApiError { status, code }`. A `401` from any call other than the auth calls redirects to `/login?next=<path>`.
- Produces: `useMe()` (a TanStack Query wrapper for `GET /api/me`) and `<RequireAuth>`.
- Routes: `/login`, `/login/mfa` (TOTP code field, "Use a recovery code" toggle, "Use a passkey" button), `/setup/totp` (QR code rendered from `otpauthUrl` with the `qrcode` package, the secret shown as text for manual entry, then recovery codes shown once with a download-as-.txt button and an "I saved these" checkbox before continuing), `/forgot`, `/reset/:token`, `/invite/:token`.
  - The login page also has a "Sign in with a passkey" button for the passwordless path.
  - Every form has visible labels, error text tied to its field with `aria-describedby`, focus moved to the first error, and `autocomplete` attributes (`username`, `current-password`, `new-password`, `one-time-code`).
- E2E harness. `global-setup.ts` starts a MongoDB Testcontainer, starts the API (`node apps/api/dist/server.js`) with `MAILER=file`, `MAIL_OUTBOX_FILE=<tmp>`, `HIBP_ENABLED=false`, `APP_ORIGIN=http://localhost:5173`, `WEBAUTHN_RP_ID=localhost`, and serves the web app with `vite preview --port 5173` (a proxy sends `/api` to the API). `helpers.ts` exports:
  - `readLastMail(to: string): Promise<{ subject; text }>`
  - `totpFor(secret: string): string` (otplib)
  - `bootstrapUser(email, name): Promise<{ setupUrl }>` (calls `bootstrap` directly against the test DB)
  - `addVirtualAuthenticator(page): Promise<void>` (CDP `WebAuthn.enable` and `WebAuthn.addVirtualAuthenticator` with `{ protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true }`)
  - `expectNoA11yViolations(page): Promise<void>` (`@axe-core/playwright`, tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`)
- Playwright projects: `desktop` (Chromium 1280×800) and `mobile` (Chromium 375×667, `isMobile: true`).

- [ ] **Step 1: Write the failing E2E** `auth.spec.ts`:
  - `'Auth: bootstrap owner sets password, enrolls TOTP, saves recovery codes, lands on roadmap picker'`.
  - `'Auth: sign in with password + TOTP'`.
  - `'Auth: sign in with a recovery code'`.
  - `'Auth: forgot password → email link → reset → sign in'`.
  - `'Auth: add a passkey in settings, sign out, sign in passwordless with it'`. This one is chromium-only through the virtual authenticator, and it depends on Task 13's settings page, so mark it `test.fixme` until Task 13.
  - `'Auth: 5 wrong passwords show the generic error and the right password then fails'`.
  - `'Auth screens pass axe at 375px and 1280px'` calls `expectNoA11yViolations` on `/login`, `/login/mfa`, `/setup/totp`, `/forgot`, `/reset/x`, `/invite/x`.
  - The mobile project also asserts `document.documentElement.scrollWidth <= 375` on each screen, so there is no horizontal scroll.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e auth`. Expected: FAIL.
- [ ] **Step 3: Implement** the client, the pages and `App.tsx` routes, using the layout rules and exact copy in the UI/UX plan. Each E2E test above asserts the heading, button label and error message of its screen from that table. `/` shows a placeholder for the picker (Task 13).
- [ ] **Step 4: Run.** Expected: PASS, except the one fixme test.
- [ ] **Step 5: Add unit tests** with Vitest + Testing Library for `api/client.ts`: it attaches the CSRF header on POST and not on GET, maps an error body to `ApiError`, and redirects on 401. Run `pnpm --filter @roadmap/web test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): sign-in, MFA enrollment, reset and invite screens`.

---

### Task 13: Web: roadmap picker, members, audit log and security settings

**Files:**
- Create: `apps/web/src/roadmaps/{PickerPage,CreateRoadmapDialog,RoadmapLayout}.tsx`, `src/members/MembersPage.tsx`, `src/audit/AuditPage.tsx`, `src/settings/SecurityPage.tsx`
- Create: `apps/web/e2e/{roadmaps,members,audit,settings}.spec.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/e2e/auth.spec.ts` (remove `fixme`)

**Interfaces:**
- Consumes: the routes from Tasks 6–11 and `useMe()`.
- Routes:
  - `/` (picker: the list of roadmaps with role badges, plus "New roadmap")
  - `/r/:roadmapId` (a `RoadmapLayout` with a header picker for switching roadmaps per FR-1.1, and nav tabs: Members, plus Audit log for owner or admin only. Later plans add Projects and views here.)
  - `/r/:roadmapId/members` (member table: name, email, role select, remove button; pending invites with revoke; an invite form with email and role; Transfer ownership and Delete roadmap in an owner-only "Danger zone" that requires typing the name)
  - `/r/:roadmapId/audit` (filter by action and date range, a list with "Load more" using `nextCursor`, timestamps in the user's timezone)
  - `/settings/security` (passkeys list with add/remove, regenerate recovery codes after a TOTP prompt, sign out of all sessions)
- The UI hides controls the role can't use. It decides this by calling the shared `can()` from `packages/shared`. **Move `can` from `apps/api/src/policy/policy.ts` to `packages/shared/src/policy.ts`** and re-export it from the API's policy module, so both sides use one implementation. The server still enforces, and the hidden controls are only a convenience.
- Destructive actions use a confirm dialog that traps focus and returns focus to the trigger.

- [ ] **Step 1: Write the failing E2E specs:**
  - `roadmaps.spec.ts`: `'FR-1.1: user creates two roadmaps and switches between them from the picker'`.
  - `members.spec.ts`:
    - `'Owner invites a contributor by email; contributor accepts, enrolls, sees roadmap'`.
    - `'Contributor sees no invite form, no role selects, no audit tab'`.
    - `'Permissions: contributor calling PATCH members via fetch gets 403'`. This one uses `page.request` with the contributor's cookies.
    - `'Owner transfers ownership; former owner loses Danger zone'`.
    - `'Owner deletes roadmap after typing its name'`.
  - `audit.spec.ts`: `'Admin sees invite and role change events in the audit log and can filter by action'`.
  - `settings.spec.ts`: `'Sign out of all sessions logs out a second browser context'`.
  - Remove `fixme` from the passkey test.
  - Add axe checks and the 375 px no-horizontal-scroll check for `/`, `/r/:id/members`, `/r/:id/audit`, `/settings/security`.
- [ ] **Step 2: Run** `pnpm --filter @roadmap/web test:e2e`. Expected: FAIL.
- [ ] **Step 3: Move `can` to shared** and run `pnpm --filter @roadmap/api test policy`. Expected: still PASS.
- [ ] **Step 4: Implement** the pages, using the layout rules and exact copy in the UI/UX plan, and assert that copy in the E2E specs. On mobile the member table collapses to stacked cards below 600 px.
- [ ] **Step 5: Run** `pnpm test && pnpm test:e2e`. Expected: all PASS.
- [ ] **Step 6: Commit** `feat(web): roadmap picker, members, audit log and security settings`.

---

### Task 14: POC deployment with Docker Compose and Caddy

**Files:**
- Create: `apps/api/Dockerfile`, `deploy/poc/caddy.Dockerfile`, `deploy/poc/Caddyfile`, `deploy/poc/docker-compose.yml`, `deploy/poc/.env.example`, `scripts/smoke.sh`
- Modify: `.github/workflows/ci.yml` (adds the image build, Trivy scan and smoke job)

**Interfaces:**
- Consumes: `apps/api` build output, `apps/web` `dist/`, and the bootstrap CLI.
- Images:
  - `apps/api/Dockerfile` is a multi-stage build on `node:24-alpine`. It runs `pnpm deploy --prod` for `@roadmap/api` and runs as a non-root `node` user with a read-only root filesystem (`/tmp` is tmpfs). The entry is `node dist/server.js`, and `node dist/cli/bootstrap.js` is available.
  - `deploy/poc/caddy.Dockerfile` builds the web app with `node:24-alpine`, then `caddy:2-builder` runs `xcaddy build --with github.com/mholt/caddy-ratelimit`. The final image is `caddy:2-alpine` with `/srv/web` holding the web `dist/`.
- `Caddyfile`: site `{$DOMAIN}`. It sends `/api/*` to `api:3000` with `rate_limit` (zone `api`, 100 events per 1 min per `{remote_host}`; zone `auth` on `/api/auth/*`, 10 per 1 min). Everything else uses `file_server` with `try_files {path} /index.html`. Headers: the same CSP as Task 5, `Strict-Transport-Security "max-age=31536000; includeSubDomains"`, `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, and `-Server`.
- `docker-compose.yml` has three services:
  - `mongo`: `mongo:8.0` with auth enabled through `MONGO_INITDB_ROOT_*`, the volume `/srv/mongo:/data/db` (the separate EBS data volume), and no published ports.
  - `api`: reads `env_file: .env` and depends on `mongo`. Only Caddy reaches it.
  - `caddy`: publishes `80:80` and `443:443`, with volumes `caddy_data` and `caddy_config`.
  All three set `restart: unless-stopped`. Nothing except `mongo` and Caddy's certificate storage writes to disk.
- `scripts/smoke.sh [base_url]` (default `https://localhost`, using `curl -k` locally) asserts:
  - `GET /api/health` returns `{"status":"ok"}`.
  - `GET /` returns 200 with `text/html` and contains `<div id="root">`.
  - The response headers include `content-security-policy` and `strict-transport-security`.
  - `GET /api/me` returns 401.
  - It exits non-zero on any failure.

- [ ] **Step 1: Write `scripts/smoke.sh`** and run it against nothing. Expected: FAIL (connection refused).
- [ ] **Step 2: Implement** the Dockerfiles, Caddyfile and compose file. Locally, use `DOMAIN=localhost`, so Caddy issues its internal CA certificate.
- [ ] **Step 3: Run** `docker compose -f deploy/poc/docker-compose.yml --env-file deploy/poc/.env.example up -d --build && scripts/smoke.sh`. Expected: PASS.
- [ ] **Step 4: Run** `docker compose -f deploy/poc/docker-compose.yml exec api node dist/cli/bootstrap.js --tenant Test --email you@example.com --name You`. Expected: a printed `https://localhost/reset/<token>` URL. Opening it in a browser and completing setup lands on the roadmap picker.
- [ ] **Step 5: Add CI jobs.** Build both images, scan them with `aquasecurity/trivy-action` (`severity: CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`), then bring up compose and run `scripts/smoke.sh`. Push a branch and confirm that CI passes.
- [ ] **Step 6: Commit** `feat(deploy): POC Docker Compose stack with Caddy`.

---

## Next plans (v1)

These are written after this plan is executed, each against the code that exists by then:

1. Projects and views: FR-1.2–1.9, the data model's Project, Milestone and Note entities and their rules, the "only assigned items" policy context, and the list, timeline and board views.
2. Snapshots and PDF: FR-3. This adds the SQS-style worker. On the POC it is an in-process queue behind the same interface.
3. Calendar feed: FR-4.
4. Notifications: FR-5 (email only), with a notification center and digests.
5. POC infrastructure: Terraform for EC2 t4g.medium, EBS, SSM, IMDSv2, Data Lifecycle Manager snapshots, nightly mongodump to S3, and the deploy workflow over SSM with GitHub OIDC.
6. Release hardening: the OWASP ZAP baseline scan before each release, OpenTelemetry tracing and CloudWatch alerts, the quarterly restore test, and a profile page for name and timezone.

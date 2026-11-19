import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { LOCK_MS } from '../../src/auth/lockout.ts';
import { SESSION_COOKIE } from '../../src/auth/sessions.ts';
import { scoped, type ScopedDb } from '../../src/db/scoped.ts';
import type { UserDoc } from '../../src/db/types.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

// Lets one test run code after the password check has started, i.e. after the user lookup.
const verifyHook = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../../src/auth/passwords.ts', async (orig) => {
  const actual = await orig<typeof import('../../src/auth/passwords.ts')>();
  return {
    ...actual,
    verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
      const hook = verifyHook.run;
      verifyHook.run = null;
      await hook?.();
      return actual.verifyPassword(...args);
    },
  };
});

const MIN = 60_000;
const PASSWORD = 'correct horse battery';

let clock = new Date('2026-01-01T00:00:00Z');
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

let t: TestApp;
let tenantId: string;
let s: ScopedDb;
let n = 0;
// Distinct IP per call keeps the 10/min auth rate limit out of the way of lockout tests.
const ip = () => `10.1.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
  tenantId = (await t.seed.tenant())._id;
  s = scoped(t.db, tenantId);
}, 120_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  clock = new Date('2026-01-01T00:00:00Z');
});

const login = (email: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip(), payload: { email, password } });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};
const newUser = (o: { totp?: boolean; email?: string; password?: string } = {}) =>
  t.seed.user(tenantId, { password: PASSWORD, ...o });
const auditFor = (userId: string, action: string) =>
  s.audit.find({ action, 'target.id': userId }, { sort: { timestamp: 1 }, limit: 50 });

describe('POST /api/auth/login (FR-1)', () => {
  test('a correct password with TOTP set gives next mfa, a pending cookie, and /api/me is 403 mfa_required', async () => {
    const u = await newUser({ totp: true });
    const res = await login(u.email, PASSWORD);
    expect(res.statusCode).toBe(200);
    const { next, csrfToken } = res.json<{ next: string; csrfToken: string }>();
    expect(next).toBe('mfa');
    expect(csrfToken).toHaveLength(43);
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: cookieOf(res)! } });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual({ error: 'mfa_required' });
    const stored = await s.collection('sessions').findOne({ userId: u._id, state: 'pending_mfa' });
    expect(stored?.csrfToken).toBe(csrfToken);
  });

  test('a user with a passkey and no TOTP also gets next mfa', async () => {
    const u = await newUser();
    await t.db
      .collection<UserDoc>('users')
      .updateOne({ _id: u._id }, { $set: { passkeys: [{ id: 'p1', credentialId: 'c', publicKey: 'k', counter: 0, transports: [], name: 'k', createdAt: new Date() }] } });
    const res = await login(u.email, PASSWORD);
    expect(res.json()).toMatchObject({ next: 'mfa' });
  });

  test('a user without TOTP gives next enroll and a pending_enroll session', async () => {
    const u = await newUser();
    const res = await login(u.email, PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ next: 'enroll' });
    expect(await s.collection('sessions').findOne({ userId: u._id, state: 'pending_enroll' })).not.toBeNull();
  });

  test('a wrong password gives 401 invalid_credentials, sets no cookie, and audits a failure against the user', async () => {
    const u = await newUser();
    const res = await login(u.email, 'wrong password here');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieOf(res)).toBeUndefined();
    const [ev, ...rest] = await auditFor(u._id, 'auth.login.failure');
    expect(rest).toHaveLength(0);
    expect(ev).toMatchObject({ actor: { type: 'system' }, target: { type: 'user', id: u._id } });
    expect(ev).not.toHaveProperty('roadmapId');
  });

  test('an unknown email gives the same 401 and writes no audit event', async () => {
    const before = await s.audit.find({ action: 'auth.login.failure' }, { sort: { _id: 1 }, limit: 500 });
    const res = await login('nobody@example.com', PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    const after = await s.audit.find({ action: 'auth.login.failure' }, { sort: { _id: 1 }, limit: 500 });
    expect(after).toHaveLength(before.length);
  });

  test('a user with no password set cannot sign in', async () => {
    const u = await t.seed.user(tenantId);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
  });

  test('lockout: 5 failures lock for 15 min even with the right password', async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) expect((await login(u.email, 'wrong password here')).statusCode).toBe(401);
    const locked = await login(u.email, PASSWORD);
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toEqual({ error: 'invalid_credentials' });
    advance(14 * MIN);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
    advance(1 * MIN);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(200);
  });

  test('lockout: a correct password is refused when the account locks between the user lookup and the post-verify check', async () => {
    const u = await newUser();
    verifyHook.run = async () => {
      await s
        .collection('users')
        .updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(clock.getTime() + LOCK_MS) } });
    };
    const res = await login(u.email, PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieOf(res)).toBeUndefined();
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });

  test('4 failures do not lock the account', async () => {
    const u = await newUser();
    for (let i = 0; i < 4; i++) await login(u.email, 'wrong password here');
    expect((await login(u.email, PASSWORD)).statusCode).toBe(200);
  });

  test('lockout: a correct password does not reset the failure counter', async () => {
    const u = await newUser();
    for (let i = 0; i < 4; i++) await login(u.email, 'wrong password here');
    expect((await login(u.email, PASSWORD)).statusCode).toBe(200); // password only: no completed sign-in
    await login(u.email, 'wrong password here'); // the 5th consecutive failure
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
  });

  test('lockout: a parallel burst of wrong passwords locks the account and a correct password is then refused', async () => {
    const u = await newUser();
    const burst = await Promise.all(Array.from({ length: 10 }, () => login(u.email, 'wrong password here')));
    for (const r of burst) expect(r.statusCode).toBe(401);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });

  test('after a lockout expires the user gets a fresh set of 5 attempts', async () => {
    const u = await newUser();
    for (let i = 0; i < 5; i++) await login(u.email, 'wrong password here');
    advance(15 * MIN);
    await login(u.email, 'wrong password here'); // failure 1 of a new run, not an instant re-lock
    expect((await login(u.email, PASSWORD)).statusCode).toBe(200);
    expect((await t.db.collection<UserDoc>('users').findOne({ _id: u._id }))?.failedLogins).toBe(1);
  });

  test('Review focus 1: login email is case- and space-insensitive', async () => {
    const u = await newUser({ email: 'lance@example.com' });
    const res = await login('  Lance@Example.COM ', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(await s.collection('sessions').findOne({ userId: u._id })).not.toBeNull();
  });

  test('a malformed body is 400 validation', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/auth/logout and logout-all (FR-1)', () => {
  test('logout revokes the session, clears the cookie, returns 204 and audits', async () => {
    const u = await newUser();
    const { cookie, csrf } = await signInAs(t.app, t.db, u._id);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(await auditFor(u._id, 'auth.logout')).toHaveLength(1);
  });

  test('a pending session can log out too', async () => {
    const u = await newUser({ totp: true });
    const l = await login(u.email, PASSWORD);
    const cookie = cookieOf(l)!;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': l.json<{ csrfToken: string }>().csrfToken },
    });
    expect(res.statusCode).toBe(204);
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });

  test('logout without a CSRF token is 403 csrf and without a session is 401', async () => {
    const u = await newUser();
    const { cookie } = await signInAs(t.app, t.db, u._id);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(401);
  });

  test('logout-all makes every other cookie of that user get 401 on /api/me, and leaves other users alone', async () => {
    const u = await newUser();
    const other = await newUser();
    const a = await signInAs(t.app, t.db, u._id);
    const b = await signInAs(t.app, t.db, u._id);
    const o = await signInAs(t.app, t.db, other._id);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: a.cookie, 'x-csrf-token': a.csrf },
    });
    expect(res.statusCode).toBe(204);
    for (const c of [a, b]) {
      expect((await t.app.inject({ url: '/api/me', headers: { cookie: c.cookie } })).statusCode).toBe(401);
    }
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: o.cookie } })).statusCode).toBe(200);
    expect(await auditFor(u._id, 'auth.logout_all')).toHaveLength(1);
  });

  test('logout-all refuses a pending session with 403 mfa_required', async () => {
    const u = await newUser({ totp: true });
    const l = await login(u.email, PASSWORD);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: cookieOf(l)!, 'x-csrf-token': l.json<{ csrfToken: string }>().csrfToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/me (FR-1)', () => {
  test('returns the user, csrf token, and memberships sorted by name without archived roadmaps', async () => {
    const u = await newUser();
    const other = await newUser();
    const rB = await t.seed.roadmap(tenantId, u._id, 'Beta');
    const rA = await t.seed.roadmap(tenantId, other._id, 'Alpha');
    await t.seed.member(tenantId, rA._id, u._id, 'contributor');
    const rX = await t.seed.roadmap(tenantId, u._id, 'Archived');
    await s.collection('roadmaps').updateOne({ _id: rX._id }, { $set: { archivedAt: new Date() } });
    await t.seed.roadmap(tenantId, other._id, 'Not mine');
    const { cookie, csrf } = await signInAs(t.app, t.db, u._id);
    const res = await t.app.inject({ url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: u._id, email: u.email, name: 'Test User', timezone: 'UTC', hasTotp: false, passkeys: [] },
      csrfToken: csrf,
      memberships: [
        { roadmapId: rA._id, roadmapName: 'Alpha', role: 'contributor' },
        { roadmapId: rB._id, roadmapName: 'Beta', role: 'owner' },
      ],
    });
  });

  test('hasTotp is true and passkeys are listed without secrets once the user has them', async () => {
    const u = await newUser({ totp: true });
    const created = new Date('2026-01-01T00:00:00Z');
    const passkey = { id: 'pk-1', credentialId: 'secret-cred', publicKey: 'pk', counter: 0, transports: [], name: 'Laptop', createdAt: created };
    await t.db.collection<UserDoc>('users').updateOne({ _id: u._id }, { $set: { passkeys: [passkey] } });
    const { cookie } = await signInAs(t.app, t.db, u._id);
    const body = (await t.app.inject({ url: '/api/me', headers: { cookie } })).json<{
      user: { hasTotp: boolean; passkeys: unknown[] };
    }>();
    expect(body.user.hasTotp).toBe(true);
    expect(body.user.passkeys).toEqual([{ id: 'pk-1', name: 'Laptop', createdAt: created.toISOString() }]);
    expect(JSON.stringify(body)).not.toContain('"pk"');
  });

  test('without a session it is 401', async () => {
    expect((await t.app.inject({ url: '/api/me' })).statusCode).toBe(401);
  });

  test('Tenant isolation: memberships never include another tenant roadmaps', async () => {
    const u = await newUser();
    const other = await t.seed.tenant('Other');
    const ou = await t.seed.user(other._id);
    await t.seed.roadmap(other._id, ou._id, 'Theirs');
    const { cookie } = await signInAs(t.app, t.db, u._id);
    const body = (await t.app.inject({ url: '/api/me', headers: { cookie } })).json<{ memberships: unknown[] }>();
    expect(body.memberships).toEqual([]);
  });
});

import { authenticator } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { decryptSecret } from '../../src/auth/crypto.ts';
import { consumeRecoveryCode } from '../../src/auth/recovery.ts';
import { SESSION_COOKIE } from '../../src/auth/sessions.ts';
import { scoped, type ScopedDb } from '../../src/db/scoped.ts';
import type { UserDoc } from '../../src/db/types.ts';
import { makeTestApp, signInAs, TEST_TOTP_KEY, type TestApp } from '../helpers.ts';

const PASSWORD = 'correct horse battery';
const STEP_MS = 30_000;

let clock = new Date('2026-03-01T12:00:10Z');
const advanceSteps = (n: number) => void (clock = new Date(clock.getTime() + n * STEP_MS));
const codeFor = (secret: string, offsetSteps = 0) =>
  authenticator.clone({ epoch: clock.getTime() + offsetSteps * STEP_MS }).generate(secret);
const wrongCode = (secret: string) => (codeFor(secret) === '000000' ? '000001' : '000000');

let t: TestApp;
let tenantId: string;
let s: ScopedDb;
let n = 0;
const ip = () => `10.2.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
  tenantId = (await t.seed.tenant())._id;
  s = scoped(t.db, tenantId);
}, 120_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  clock = new Date('2026-03-01T12:00:10Z');
});

interface Pending {
  cookie: string;
  csrf: string;
}
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  return c ? `${SESSION_COOKIE}=${c.value}` : undefined;
};
const login = async (email: string): Promise<Pending> => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: ip(),
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res)!, csrf: res.json<{ csrfToken: string }>().csrfToken };
};
const post = (url: string, p: Pending, payload?: Record<string, unknown>) =>
  t.app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: { cookie: p.cookie, 'x-csrf-token': p.csrf },
    ...(payload ? { payload } : {}),
  });
const newUser = (o: { totp?: boolean } = {}) => t.seed.user(tenantId, { password: PASSWORD, ...o });
const userDoc = async (id: string) => (await s.collection('users').findOne({ _id: id }))!;
const auditFor = (userId: string, action: string) =>
  s.audit.find({ action, 'target.id': userId }, { sort: { timestamp: 1 }, limit: 50 });

/** Signs in and enrolls TOTP through the routes; returns the secret, codes and the resulting full session. */
async function enroll(email: string) {
  const p = await login(email);
  const start = await post('/api/auth/totp/enroll/start', p);
  const { secret } = start.json<{ secret: string }>();
  const res = await post('/api/auth/totp/enroll/confirm', p, { code: codeFor(secret) });
  return { secret, p, res };
}

describe('TOTP enrollment (FR-1)', () => {
  test('full flow: login, enroll start, confirm, then /api/me is 200 with hasTotp and the old cookie is dead', async () => {
    const u = await newUser();
    const p = await login(u.email);

    const start = await post('/api/auth/totp/enroll/start', p);
    expect(start.statusCode).toBe(200);
    const { secret, otpauthUrl } = start.json<{ secret: string; otpauthUrl: string }>();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Roadmap:/);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl).toContain('issuer=Roadmap');
    expect(decryptSecret((await userDoc(u._id)).pendingTotpSecretEnc!, TEST_TOTP_KEY)).toBe(secret);

    const res = await post('/api/auth/totp/enroll/confirm', p, { code: codeFor(secret) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ recoveryCodes: string[]; csrfToken: string }>();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.csrfToken).toHaveLength(43);
    expect(body.csrfToken).not.toBe(p.csrf);
    const fullCookie = cookieOf(res)!;
    expect(fullCookie).not.toBe(p.cookie);

    expect((await t.app.inject({ url: '/api/me', headers: { cookie: p.cookie } })).statusCode).toBe(401);
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: fullCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { hasTotp: true }, csrfToken: body.csrfToken });
    expect(await auditFor(u._id, 'auth.totp.enrolled')).toHaveLength(1);
  });

  test('the stored user doc holds the secret only encrypted, and recovery codes only hashed', async () => {
    const u = await newUser();
    const { secret, res } = await enroll(u.email);
    const { recoveryCodes } = res.json<{ recoveryCodes: string[] }>();
    const doc = await userDoc(u._id);
    expect(doc.totp!.secretEnc).not.toContain(secret);
    expect(decryptSecret(doc.totp!.secretEnc, TEST_TOTP_KEY)).toBe(secret);
    expect(doc.pendingTotpSecretEnc).toBeNull();
    expect(doc.recoveryCodes).toHaveLength(10);
    const stored = JSON.stringify(doc);
    expect(stored).not.toContain(secret);
    for (const c of recoveryCodes) expect(stored).not.toContain(c.replace('-', ''));
    expect(doc.totp!.lastStep).toBe(Math.floor(clock.getTime() / STEP_MS));
  });

  test('a wrong confirm code is 422 invalid_code and the session stays pending_enroll', async () => {
    const u = await newUser();
    const p = await login(u.email);
    const { secret } = (await post('/api/auth/totp/enroll/start', p)).json<{ secret: string }>();
    const res = await post('/api/auth/totp/enroll/confirm', p, { code: wrongCode(secret) });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'invalid_code' });
    expect(cookieOf(res)).toBeUndefined();
    expect((await userDoc(u._id)).totp).toBeNull();
    expect(await s.collection('sessions').findOne({ userId: u._id, state: 'pending_enroll' })).not.toBeNull();
    expect(await auditFor(u._id, 'auth.totp.enrolled')).toHaveLength(0);
  });

  test('confirm without a started enrollment is 409 enroll_not_started', async () => {
    const u = await newUser();
    const p = await login(u.email);
    const res = await post('/api/auth/totp/enroll/confirm', p, { code: '123456' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'enroll_not_started' });
  });

  test('a code is not accepted for a secret that was replaced by a second enroll start', async () => {
    const u = await newUser();
    const p = await login(u.email);
    const first = (await post('/api/auth/totp/enroll/start', p)).json<{ secret: string }>().secret;
    await post('/api/auth/totp/enroll/start', p);
    const res = await post('/api/auth/totp/enroll/confirm', p, { code: codeFor(first) });
    expect(res.statusCode).toBe(422);
  });

  test('a malformed code is 400 validation', async () => {
    const u = await newUser();
    const p = await login(u.email);
    await post('/api/auth/totp/enroll/start', p);
    expect((await post('/api/auth/totp/enroll/confirm', p, { code: 'abc' })).statusCode).toBe(400);
    expect((await post('/api/auth/totp/enroll/confirm', p, {})).statusCode).toBe(400);
  });

  test('a pending_mfa session cannot enroll (403), and no session is 401', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    expect((await post('/api/auth/totp/enroll/start', p)).statusCode).toBe(403);
    expect((await post('/api/auth/totp/enroll/confirm', p, { code: '123456' })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/totp/enroll/start' })).statusCode).toBe(401);
  });

  test('confirming from pending_enroll completes the sign-in, so it resets the failure counter', async () => {
    const u = await newUser();
    await s.collection('users').updateOne({ _id: u._id }, { $set: { failedLogins: 3 } });
    await enroll(u.email);
    expect(await userDoc(u._id)).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  test('re-enroll: a full session with TOTP cannot start enrollment without the current code', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    const none = await post('/api/auth/totp/enroll/start', full);
    expect(none.statusCode).toBe(422);
    expect(none.json()).toEqual({ error: 'invalid_code' });
    const wrong = await post('/api/auth/totp/enroll/start', full, { code: wrongCode(u.totpSecret!) });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toEqual({ error: 'invalid_code' });
    const doc = await userDoc(u._id);
    expect(doc.pendingTotpSecretEnc).toBeNull();
    expect(doc.failedLogins).toBe(0);
  });

  test('re-enroll: with the current code, start then confirm replaces the secret and recovery codes', async () => {
    const u = await newUser({ totp: true });
    const old = await userDoc(u._id);
    const full = await signInAs(t.app, t.db, u._id);
    const start = await post('/api/auth/totp/enroll/start', full, { code: codeFor(u.totpSecret!) });
    expect(start.statusCode).toBe(200);
    const { secret } = start.json<{ secret: string }>();
    advanceSteps(1); // the new secret has no replay history; only the old step is spent
    const res = await post('/api/auth/totp/enroll/confirm', full, { code: codeFor(secret) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ recoveryCodes: string[]; csrfToken: string }>()).toMatchObject({ csrfToken: full.csrf });
    expect(res.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
    expect(cookieOf(res)).toBeUndefined();
    const doc = await userDoc(u._id);
    expect(decryptSecret(doc.totp!.secretEnc, TEST_TOTP_KEY)).toBe(secret);
    expect(doc.recoveryCodes.map((c) => c.hash)).not.toContain(old.recoveryCodes[0]!.hash);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: full.cookie } })).statusCode).toBe(200);
  });

  test('re-enroll: the code used to start cannot be replayed on recovery-codes', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    const code = codeFor(u.totpSecret!);
    expect((await post('/api/auth/totp/enroll/start', full, { code })).statusCode).toBe(200);
    const replay = await post('/api/auth/recovery-codes', full, { code });
    expect(replay.statusCode).toBe(422);
    expect(replay.json()).toEqual({ error: 'invalid_code' });
  });

  test('a full session whose user has no TOTP can start enrollment without a code', async () => {
    const u = await newUser();
    const full = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/totp/enroll/start', full)).statusCode).toBe(200);
  });
});

describe('POST /api/auth/mfa/totp (FR-1)', () => {
  test('a correct code upgrades to full, rotates cookie and csrf, and audits login.success', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    const res = await post('/api/auth/mfa/totp', p, { code: codeFor(u.totpSecret!) });
    expect(res.statusCode).toBe(200);
    const { csrfToken } = res.json<{ csrfToken: string }>();
    expect(csrfToken).not.toBe(p.csrf);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: p.cookie } })).statusCode).toBe(401);
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: cookieOf(res)! } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ csrfToken });
    expect(await auditFor(u._id, 'auth.login.success')).toHaveLength(1);
  });

  test('a code from the previous step is accepted', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    expect((await post('/api/auth/mfa/totp', p, { code: codeFor(u.totpSecret!, -1) })).statusCode).toBe(200);
  });

  test('Review focus 4: a code that was already used is refused on a second sign-in', async () => {
    const u = await newUser({ totp: true });
    const code = codeFor(u.totpSecret!);
    expect((await post('/api/auth/mfa/totp', await login(u.email), { code })).statusCode).toBe(200);
    const again = await post('/api/auth/mfa/totp', await login(u.email), { code });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_code' });
    // The next step's code works.
    advanceSteps(1);
    expect((await post('/api/auth/mfa/totp', await login(u.email), { code: codeFor(u.totpSecret!) })).statusCode).toBe(200);
  });

  test('Review focus 4: two simultaneous requests with the same code cannot both succeed', async () => {
    const u = await newUser({ totp: true });
    const code = codeFor(u.totpSecret!);
    const [a, b] = [await login(u.email), await login(u.email)];
    const results = await Promise.all([post('/api/auth/mfa/totp', a, { code }), post('/api/auth/mfa/totp', b, { code })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  test('a wrong code is 401 invalid_code, sets no cookie, keeps the session pending and audits mfa.failure', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    const res = await post('/api/auth/mfa/totp', p, { code: wrongCode(u.totpSecret!) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_code' });
    expect(cookieOf(res)).toBeUndefined();
    expect(await s.collection('sessions').findOne({ userId: u._id, state: 'pending_mfa' })).not.toBeNull();
    expect((await userDoc(u._id)).failedLogins).toBe(1);
    expect(await auditFor(u._id, 'auth.mfa.failure')).toHaveLength(1);
  });

  test('a correct code resets the failure counter', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    for (let i = 0; i < 3; i++) await post('/api/auth/mfa/totp', p, { code: wrongCode(u.totpSecret!) });
    expect((await userDoc(u._id)).failedLogins).toBe(3);
    expect((await post('/api/auth/mfa/totp', p, { code: codeFor(u.totpSecret!) })).statusCode).toBe(200);
    expect((await userDoc(u._id)).failedLogins).toBe(0);
  });

  test('5 wrong codes lock the account: the right code and the password are then refused', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/auth/mfa/totp', p, { code: wrongCode(u.totpSecret!) })).statusCode).toBe(401);
    }
    expect((await userDoc(u._id)).lockedUntil).not.toBeNull();
    const right = await post('/api/auth/mfa/totp', p, { code: codeFor(u.totpSecret!) });
    expect(right.statusCode).toBe(401);
    expect(right.json()).toEqual({ error: 'invalid_code' });
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip(),
      payload: { email: u.email, password: PASSWORD },
    });
    expect(again.statusCode).toBe(401);
  });

  test('a password login in between does not reset the counter: 4 wrong, fresh login, 1 wrong locks', async () => {
    const u = await newUser({ totp: true });
    const first = await login(u.email);
    for (let i = 0; i < 4; i++) await post('/api/auth/mfa/totp', first, { code: wrongCode(u.totpSecret!) });
    const fresh = await login(u.email);
    expect((await post('/api/auth/mfa/totp', fresh, { code: wrongCode(u.totpSecret!) })).statusCode).toBe(401);
    expect((await userDoc(u._id)).lockedUntil).not.toBeNull();
    expect((await post('/api/auth/mfa/totp', fresh, { code: codeFor(u.totpSecret!) })).statusCode).toBe(401);
  });

  test('a user with no TOTP (passkey only) gets 401 invalid_code', async () => {
    const u = await newUser();
    const p = await login(u.email);
    await t.db
      .collection<UserDoc>('users')
      .updateOne({ _id: u._id }, { $set: { passkeys: [{ credentialId: 'c', name: 'k', createdAt: new Date() }] } });
    const pending = await s.collection('sessions').findOne({ userId: u._id });
    await s.collection('sessions').updateOne({ _id: pending!._id }, { $set: { state: 'pending_mfa' } });
    const res = await post('/api/auth/mfa/totp', p, { code: '123456' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_code' });
  });

  test('a full session gets 403, no session gets 401, a missing CSRF token gets 403', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/mfa/totp', full, { code: codeFor(u.totpSecret!) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/mfa/totp', payload: { code: '123456' } })).statusCode).toBe(401);
    const p = await login(u.email);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/totp',
      remoteAddress: ip(),
      headers: { cookie: p.cookie },
      payload: { code: codeFor(u.totpSecret!) },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  test('a malformed code is 400 validation', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    expect((await post('/api/auth/mfa/totp', p, { code: '12345' })).statusCode).toBe(400);
    expect((await post('/api/auth/mfa/totp', p, { code: 123456 })).statusCode).toBe(400);
  });
});

describe('POST /api/auth/mfa/recovery (FR-1)', () => {
  test('a recovery code works once; the second use is 401; the response counts what is left', async () => {
    const u = await newUser({ totp: true });
    const code = u.plainRecoveryCodes![0]!;
    const res = await post('/api/auth/mfa/recovery', await login(u.email), { code });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ remainingRecoveryCodes: 9 });
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: cookieOf(res)! } });
    expect(me.statusCode).toBe(200);
    const again = await post('/api/auth/mfa/recovery', await login(u.email), { code });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_code' });
    expect(await auditFor(u._id, 'auth.login.success')).toHaveLength(1);
    expect(await auditFor(u._id, 'auth.mfa.failure')).toHaveLength(1);
  });

  test('the code is accepted lowercase and without the dash', async () => {
    const u = await newUser({ totp: true });
    const code = u.plainRecoveryCodes![1]!.replace('-', '').toLowerCase();
    expect((await post('/api/auth/mfa/recovery', await login(u.email), { code })).statusCode).toBe(200);
  });

  test('two simultaneous uses of one code: exactly one succeeds', async () => {
    const u = await newUser({ totp: true });
    const code = u.plainRecoveryCodes![2]!;
    const [a, b] = [await login(u.email), await login(u.email)];
    const results = await Promise.all([post('/api/auth/mfa/recovery', a, { code }), post('/api/auth/mfa/recovery', b, { code })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  test('a recovery code resets the failure counter', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    for (let i = 0; i < 3; i++) await post('/api/auth/mfa/recovery', p, { code: 'AAAAA-AAAAA' });
    expect((await userDoc(u._id)).failedLogins).toBe(3);
    expect((await post('/api/auth/mfa/recovery', p, { code: u.plainRecoveryCodes![3]! })).statusCode).toBe(200);
    expect((await userDoc(u._id)).failedLogins).toBe(0);
  });

  test('5 wrong recovery codes lock the account, and a valid code is then refused with the same 401', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/auth/mfa/recovery', p, { code: 'AAAAA-AAAAA' });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid_code' });
    }
    const right = await post('/api/auth/mfa/recovery', p, { code: u.plainRecoveryCodes![4]! });
    expect(right.statusCode).toBe(401);
    expect(right.json()).toEqual({ error: 'invalid_code' });
    expect((await userDoc(u._id)).recoveryCodes.filter((c) => c.usedAt).length).toBe(0);
  });

  test('a full session gets 403', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/mfa/recovery', full, { code: u.plainRecoveryCodes![0]! })).statusCode).toBe(403);
  });

  test('Tenant isolation: a recovery code cannot be consumed through another tenant scope', async () => {
    const u = await newUser({ totp: true });
    const other = await t.seed.tenant('Other');
    const code = u.plainRecoveryCodes![5]!;
    expect(await consumeRecoveryCode(scoped(t.db, other._id), u._id, code)).toBe(false);
    expect(await consumeRecoveryCode(s, u._id, code)).toBe(true);
    expect(await consumeRecoveryCode(s, u._id, code)).toBe(false);
  });
});

describe('POST /api/auth/recovery-codes (FR-1)', () => {
  test('a full session with the current TOTP code gets 10 new codes and every old one stops working', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    const res = await post('/api/auth/recovery-codes', full, { code: codeFor(u.totpSecret!) });
    expect(res.statusCode).toBe(200);
    const { recoveryCodes } = res.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.some((c) => u.plainRecoveryCodes!.includes(c))).toBe(false);
    expect(await auditFor(u._id, 'auth.recovery.regenerated')).toHaveLength(1);
    expect((await post('/api/auth/mfa/recovery', await login(u.email), { code: u.plainRecoveryCodes![0]! })).statusCode).toBe(401);
    expect((await post('/api/auth/mfa/recovery', await login(u.email), { code: recoveryCodes[0]! })).statusCode).toBe(200);
  });

  test('a wrong TOTP code is 422 invalid_code and the old codes still work', async () => {
    const u = await newUser({ totp: true });
    const full = await signInAs(t.app, t.db, u._id);
    const res = await post('/api/auth/recovery-codes', full, { code: wrongCode(u.totpSecret!) });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'invalid_code' });
    expect(await auditFor(u._id, 'auth.recovery.regenerated')).toHaveLength(0);
    expect((await userDoc(u._id)).recoveryCodes.map((c) => c.hash)).toHaveLength(10);
  });

  test('a TOTP code that was already used cannot authorize regeneration', async () => {
    const u = await newUser({ totp: true });
    const code = codeFor(u.totpSecret!);
    expect((await post('/api/auth/mfa/totp', await login(u.email), { code })).statusCode).toBe(200);
    const full = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/recovery-codes', full, { code })).statusCode).toBe(422);
  });

  test('a user without TOTP gets 422 invalid_code', async () => {
    const u = await newUser();
    const full = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/recovery-codes', full, { code: '123456' })).statusCode).toBe(422);
  });

  test('a pending session gets 403', async () => {
    const u = await newUser({ totp: true });
    const p = await login(u.email);
    expect((await post('/api/auth/recovery-codes', p, { code: codeFor(u.totpSecret!) })).statusCode).toBe(403);
  });
});

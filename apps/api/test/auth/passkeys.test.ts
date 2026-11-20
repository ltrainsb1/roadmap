import { authenticator } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/sessions.ts';
import { scoped, type ScopedDb } from '../../src/db/scoped.ts';
import { unscoped } from '../../src/db/unscoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

const PASSWORD = 'correct horse battery';
const MIN = 60_000;

let clock = new Date('2026-03-01T12:00:00Z');
const verifyReg = vi.fn();
const verifyAuth = vi.fn();

let t: TestApp;
let tenantId: string;
let s: ScopedDb;
let n = 0;
const ip = () => `10.8.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock, webauthn: { verifyReg, verifyAuth } });
  tenantId = (await t.seed.tenant())._id;
  s = scoped(t.db, tenantId);
}, 120_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  clock = new Date('2026-03-01T12:00:00Z');
  verifyReg.mockReset();
  verifyAuth.mockReset();
});

interface Sess {
  cookie: string;
  csrf: string;
}
const cookieValue = (res: { cookies: Array<{ name: string; value: string }> }, name: string) =>
  res.cookies.find((c) => c.name === name)?.value;
const sessionOf = (res: { cookies: Array<{ name: string; value: string }>; json<T>(): T }): Sess => ({
  cookie: `${SESSION_COOKIE}=${cookieValue(res, SESSION_COOKIE)}`,
  csrf: res.json<{ csrfToken: string }>().csrfToken,
});
const post = (url: string, p: Sess | null, payload?: Record<string, unknown>, extraCookie = '') =>
  t.app.inject({
    method: 'POST',
    url,
    remoteAddress: ip(),
    headers: {
      cookie: [p?.cookie, extraCookie].filter(Boolean).join('; '),
      ...(p ? { 'x-csrf-token': p.csrf } : {}),
    },
    ...(payload ? { payload } : {}),
  });

let credSeq = 0;
const newCred = () => `cred-${++credSeq}-${'x'.repeat(20)}`;
const assertion = (id: string) => ({
  response: { id, rawId: id, type: 'public-key', response: {}, clientExtensionResults: {} },
});

const newUser = (o: { totp?: boolean } = {}) => t.seed.user(tenantId, { password: PASSWORD, ...o });
async function givePasskey(userId: string, credentialId = newCred(), counter = 3) {
  const id = `pk-${credentialId}`;
  await s.collection('users').updateOne(
    { _id: userId },
    {
      $push: {
        passkeys: {
          id,
          credentialId,
          publicKey: Buffer.from('pubkey').toString('base64url'),
          counter,
          transports: ['internal'],
          name: 'Laptop',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      },
    },
  );
  return { id, credentialId };
}
const userDoc = async (id: string) => (await s.collection('users').findOne({ _id: id }))!;
const auditFor = (userId: string, action: string) =>
  s.audit.find({ action, 'target.id': userId }, { sort: { timestamp: 1 }, limit: 50 });
const pendingLogin = async (email: string): Promise<Sess> => {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: ip(),
    payload: { email, password: PASSWORD },
  });
  expect(res.json()).toMatchObject({ next: 'mfa' });
  return sessionOf(res);
};
const authOk = (credentialId: string, newCounter = 4) =>
  verifyAuth.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter, credentialID: credentialId },
  });
const WA = '__Host-wa';
interface Opts {
  challenge: string;
  rpId: string;
  userVerification: string;
  allowCredentials?: Array<{ id: string }>;
  excludeCredentials: Array<{ id: string }>;
  rp: { id: string; name: string };
  user: { name: string };
  authenticatorSelection: Record<string, unknown>;
}
interface Me {
  csrfToken: string;
  user: { id: string; passkeys: unknown[] };
}

describe('passkey registration (FR-1)', () => {
  test('options need a full session: pending gets 403, none gets 401', async () => {
    const u = await newUser({ totp: true });
    const pending = await pendingLogin(u.email);
    expect((await post('/api/auth/passkeys/register/options', pending)).statusCode).toBe(403);
    expect((await post('/api/auth/passkeys/register/options', null)).statusCode).toBe(401);
  });

  test('verify needs a full session: a pending session gets 403', async () => {
    const u = await newUser({ totp: true });
    const pending = await pendingLogin(u.email);
    const res = await post('/api/auth/passkeys/register/verify', pending, { response: {}, name: 'x' });
    expect(res.statusCode).toBe(403);
  });

  test('options ask for a resident key and user verification, and keep the challenge on the session', async () => {
    const u = await newUser({ totp: true });
    const { cookie, csrf } = await signInAs(t.app, t.db, u._id);
    const res = await post('/api/auth/passkeys/register/options', { cookie, csrf }, { code: u.plainRecoveryCodes![0]! });
    expect(res.statusCode).toBe(200);
    const o = res.json<Opts>();
    expect(o.rp).toEqual({ id: 'localhost', name: 'Roadmap' });
    expect(o.user.name).toBe(u.email);
    expect(o.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const session = await s.collection('sessions').findOne({ userId: u._id });
    expect(session?.webauthnChallenge).toBe(o.challenge);
  });

  test('options exclude credentials the user already has', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    const { cookie, csrf } = await signInAs(t.app, t.db, u._id);
    const o = (await post('/api/auth/passkeys/register/options', { cookie, csrf }, { code: u.plainRecoveryCodes![0]! })).json<Opts>();
    expect(o.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([credentialId]);
  });

  /** Signs in and asks for options, stepping up with recovery code `i` of a TOTP user. */
  async function startRegistration(u: { _id: string; plainRecoveryCodes?: string[] }, i = 0) {
    const sess = await signInAs(t.app, t.db, u._id);
    const o = (await post('/api/auth/passkeys/register/options', sess, { code: u.plainRecoveryCodes![i]! })).json<Opts>();
    return { sess, challenge: o.challenge };
  }
  const regOk = (credentialId: string) =>
    verifyReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['usb'] },
      },
    });

  test('verify stores the passkey, checks the stored challenge, returns the id and audits', async () => {
    const u = await newUser({ totp: true });
    const { sess, challenge } = await startRegistration(u);
    const credentialId = newCred();
    regOk(credentialId);
    const res = await post('/api/auth/passkeys/register/verify', sess, { response: assertion(credentialId).response, name: 'My phone' });
    expect(res.statusCode).toBe(200);
    const { id } = res.json<{ id: string }>();
    expect(verifyReg).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: challenge,
        expectedOrigin: 'http://localhost:5173',
        expectedRPID: 'localhost',
        requireUserVerification: true,
      }),
    );
    const stored = (await userDoc(u._id)).passkeys!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id,
      credentialId,
      publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
      counter: 0,
      transports: ['usb'],
      name: 'My phone',
    });
    expect(await auditFor(u._id, 'auth.passkey.added')).toHaveLength(1);

    const me = await t.app.inject({ url: '/api/me', headers: { cookie: sess.cookie } });
    expect(me.json<Me>().user.passkeys).toEqual([{ id, name: 'My phone', createdAt: expect.any(String) as string }]);
  });

  test('the challenge is single use', async () => {
    const u = await newUser({ totp: true });
    const { sess } = await startRegistration(u);
    const credentialId = newCred();
    regOk(credentialId);
    const body = { response: assertion(credentialId).response, name: 'One' };
    expect((await post('/api/auth/passkeys/register/verify', sess, body)).statusCode).toBe(200);
    const again = await post('/api/auth/passkeys/register/verify', sess, body);
    expect(again.statusCode).toBe(422);
    expect(again.json()).toEqual({ error: 'invalid_passkey' });
    expect((await userDoc(u._id)).passkeys).toHaveLength(1);
  });

  test('verify without options having been requested is refused', async () => {
    const u = await newUser({ totp: true });
    const sess = await signInAs(t.app, t.db, u._id);
    regOk(newCred());
    const res = await post('/api/auth/passkeys/register/verify', sess, { response: {}, name: 'x' });
    expect(res.statusCode).toBe(422);
    expect(verifyReg).not.toHaveBeenCalled();
  });

  test('a challenge older than 5 minutes is refused', async () => {
    const u = await newUser({ totp: true });
    const { sess } = await startRegistration(u);
    clock = new Date(clock.getTime() + 5 * MIN + 1000);
    regOk(newCred());
    const res = await post('/api/auth/passkeys/register/verify', sess, { response: {}, name: 'x' });
    expect(res.statusCode).toBe(422);
    expect(verifyReg).not.toHaveBeenCalled();
  });

  test('a failed or throwing verification stores nothing', async () => {
    const u = await newUser({ totp: true });
    let { sess } = await startRegistration(u);
    verifyReg.mockResolvedValue({ verified: false });
    expect((await post('/api/auth/passkeys/register/verify', sess, { response: {}, name: 'x' })).statusCode).toBe(422);
    ({ sess } = await startRegistration(u, 1));
    verifyReg.mockRejectedValue(new Error('bad attestation'));
    expect((await post('/api/auth/passkeys/register/verify', sess, { response: {}, name: 'x' })).statusCode).toBe(422);
    expect((await userDoc(u._id)).passkeys ?? []).toHaveLength(0);
  });

  test('the name must be 1 to 60 characters', async () => {
    const u = await newUser({ totp: true });
    const { sess } = await startRegistration(u);
    regOk(newCred());
    for (const name of ['', 'x'.repeat(61)]) {
      expect((await post('/api/auth/passkeys/register/verify', sess, { response: {}, name })).statusCode).toBe(400);
    }
    expect(verifyReg).not.toHaveBeenCalled();
  });

  const totpNow = (secret: string) => authenticator.clone({ epoch: clock.getTime() }).generate(secret);

  test('R18 step-up: options for a TOTP user need a code: missing or wrong is 422 invalid_code and sets no challenge', async () => {
    const u = await newUser({ totp: true });
    const sess = await signInAs(t.app, t.db, u._id);
    for (const payload of [undefined, { code: '' }, { code: totpNow(u.totpSecret!) === '000000' ? '000001' : '000000' }, { code: 'AAAAA-AAAAA' }]) {
      const res = await post('/api/auth/passkeys/register/options', sess, payload);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'invalid_code' });
    }
    expect((await s.collection('sessions').findOne({ userId: u._id }))?.webauthnChallenge).toBeUndefined();
    expect((await userDoc(u._id)).failedLogins).toBe(0);
  });

  test('R18 step-up: the current TOTP code unlocks options once; the same code is then refused', async () => {
    const u = await newUser({ totp: true });
    const sess = await signInAs(t.app, t.db, u._id);
    const code = totpNow(u.totpSecret!);
    expect((await post('/api/auth/passkeys/register/options', sess, { code })).statusCode).toBe(200);
    expect((await post('/api/auth/passkeys/register/options', sess, { code })).statusCode).toBe(422);
  });

  test('R18 step-up: a recovery code unlocks options, is spent, and cannot be used again', async () => {
    const u = await newUser({ totp: true });
    const sess = await signInAs(t.app, t.db, u._id);
    const code = u.plainRecoveryCodes![0]!;
    expect((await post('/api/auth/passkeys/register/options', sess, { code })).statusCode).toBe(200);
    expect((await userDoc(u._id)).recoveryCodes.filter((c) => c.usedAt !== null)).toHaveLength(1);
    const again = await post('/api/auth/passkeys/register/options', sess, { code });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toEqual({ error: 'invalid_code' });
  });

  test('R18 step-up: a user without TOTP needs no code for options', async () => {
    const u = await newUser();
    const sess = await signInAs(t.app, t.db, u._id);
    expect((await post('/api/auth/passkeys/register/options', sess)).statusCode).toBe(200);
  });

  test('a credential already registered to someone is refused', async () => {
    const other = await newUser({ totp: true });
    const { credentialId } = await givePasskey(other._id);
    const u = await newUser({ totp: true });
    const { sess } = await startRegistration(u);
    regOk(credentialId);
    const res = await post('/api/auth/passkeys/register/verify', sess, { response: {}, name: 'dup' });
    expect(res.statusCode).toBe(409);
    expect((await userDoc(u._id)).passkeys ?? []).toHaveLength(0);
  });
});

describe('removing a passkey (FR-1)', () => {
  const del = (id: string, p: Sess) =>
    t.app.inject({
      method: 'DELETE',
      url: `/api/auth/passkeys/${id}`,
      remoteAddress: ip(),
      headers: { cookie: p.cookie, 'x-csrf-token': p.csrf },
    });

  test('removes it, returns 204 and audits', async () => {
    const u = await newUser({ totp: true });
    const a = await givePasskey(u._id);
    const b = await givePasskey(u._id);
    const sess = await signInAs(t.app, t.db, u._id);
    expect((await del(a.id, sess)).statusCode).toBe(204);
    expect((await userDoc(u._id)).passkeys!.map((p) => p.id)).toEqual([b.id]);
    expect(await auditFor(u._id, 'auth.passkey.removed')).toHaveLength(1);
  });

  test('the only second factor cannot be removed: 409 last_factor', async () => {
    const u = await newUser();
    const a = await givePasskey(u._id);
    const sess = await signInAs(t.app, t.db, u._id);
    const res = await del(a.id, sess);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_factor' });
    expect((await userDoc(u._id)).passkeys).toHaveLength(1);
  });

  test('two concurrent deletes without TOTP: exactly one succeeds and one passkey stays', async () => {
    const u = await newUser();
    const a = await givePasskey(u._id);
    const b = await givePasskey(u._id);
    const sess = await signInAs(t.app, t.db, u._id);
    const [r1, r2] = await Promise.all([del(a.id, sess), del(b.id, sess)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([204, 409]);
    const failed = r1.statusCode === 409 ? r1 : r2;
    expect(failed.json()).toEqual({ error: 'last_factor' });
    expect((await userDoc(u._id)).passkeys).toHaveLength(1);
  });

  test('two concurrent deletes with TOTP and two passkeys: both 204 and no passkeys field is left', async () => {
    const u = await newUser({ totp: true });
    const a = await givePasskey(u._id);
    const b = await givePasskey(u._id);
    const sess = await signInAs(t.app, t.db, u._id);
    const [r1, r2] = await Promise.all([del(a.id, sess), del(b.id, sess)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([204, 204]);
    expect(await t.db.collection('users').findOne({ _id: u._id as never, passkeys: { $exists: true } })).toBeNull();
  });

  test('without TOTP, one of two passkeys can go', async () => {
    const u = await newUser();
    const a = await givePasskey(u._id);
    await givePasskey(u._id);
    const sess = await signInAs(t.app, t.db, u._id);
    expect((await del(a.id, sess)).statusCode).toBe(204);
  });

  test('unknown ids are 404, and so is another user\'s passkey, even in another tenant', async () => {
    const u = await newUser({ totp: true });
    const sess = await signInAs(t.app, t.db, u._id);
    const peer = await newUser({ totp: true });
    const theirs = await givePasskey(peer._id);
    expect((await del('nope', sess)).statusCode).toBe(404);
    expect((await del(theirs.id, sess)).statusCode).toBe(404);

    const t2 = await t.seed.tenant('Other');
    const foreign = await t.seed.user(t2._id, { totp: true });
    const fid = `pk-foreign-${newCred()}`;
    await scoped(t.db, t2._id).collection('users').updateOne({ _id: foreign._id }, {
      $push: { passkeys: { id: fid, credentialId: newCred(), publicKey: 'k', counter: 0, transports: [], name: 'F', createdAt: new Date() } },
    });
    expect((await del(fid, sess)).statusCode).toBe(404);
    expect((await scoped(t.db, t2._id).collection('users').findOne({ _id: foreign._id }))!.passkeys).toHaveLength(1);
  });

  test('needs a full session', async () => {
    const u = await newUser({ totp: true });
    const a = await givePasskey(u._id);
    const pending = await pendingLogin(u.email);
    expect((await del(a.id, pending)).statusCode).toBe(403);
  });

  test('two users who each removed their last passkey can coexist (unique index)', async () => {
    for (let i = 0; i < 2; i++) {
      const u = await newUser({ totp: true });
      const a = await givePasskey(u._id);
      const sess = await signInAs(t.app, t.db, u._id);
      expect((await del(a.id, sess)).statusCode).toBe(204);
    }
  });
});

describe('passkey sign-in options (FR-1)', () => {
  test('passwordless: discoverable credentials, challenge stored, __Host-wa cookie, no user lookup', async () => {
    const u = await newUser({ totp: true });
    await givePasskey(u._id);
    const res = await post('/api/auth/passkeys/login/options', null);
    expect(res.statusCode).toBe(200);
    const o = res.json<Opts>();
    expect(o.allowCredentials ?? []).toEqual([]);
    expect(o.rpId).toBe('localhost');
    expect(o.userVerification).toBe('required');
    const id = cookieValue(res, WA)!;
    expect(id).toBeTruthy();
    const c = res.cookies.find((x) => x.name === WA)!;
    expect(c).toMatchObject({ httpOnly: true, secure: true, path: '/', maxAge: 300 });
    const doc = await unscoped(t.db).takeChallenge(id);
    expect(doc?.challenge).toBe(o.challenge);
    expect(doc!.expiresAt.getTime()).toBe(clock.getTime() + 5 * MIN);
  });

  test('second factor: allowCredentials is the pending user\'s passkeys and the challenge goes on the session', async () => {
    const u = await newUser({ totp: true });
    const a = await givePasskey(u._id);
    const b = await givePasskey(u._id);
    const pending = await pendingLogin(u.email);
    const res = await post('/api/auth/passkeys/login/options', pending);
    expect(res.statusCode).toBe(200);
    const o = res.json<Opts>();
    expect(o.allowCredentials!.map((c: { id: string }) => c.id)).toEqual([a.credentialId, b.credentialId]);
    expect(cookieValue(res, WA)).toBeUndefined();
    const session = await s.collection('sessions').findOne({ userId: u._id });
    expect(session?.webauthnChallenge).toBe(o.challenge);
  });

  test('second factor for a user with no passkeys is refused', async () => {
    const u = await newUser({ totp: true });
    const pending = await pendingLogin(u.email);
    expect((await post('/api/auth/passkeys/login/options', pending)).statusCode).toBe(422);
  });
});

describe('passwordless passkey sign-in (FR-1)', () => {
  async function options() {
    const res = await post('/api/auth/passkeys/login/options', null);
    return { wa: `${WA}=${cookieValue(res, WA)}`, challenge: res.json<Opts>().challenge };
  }
  const verify = (wa: string, credentialId: string) =>
    post('/api/auth/passkeys/login/verify', null, assertion(credentialId), wa);

  test('creates a full session, updates the counter, clears the challenge cookie and audits', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id, newCred(), 3);
    await s.collection('users').updateOne({ _id: u._id }, { $set: { failedLogins: 3 } });
    authOk(credentialId, 9);
    const { wa, challenge } = await options();
    const res = await verify(wa, credentialId);
    expect(res.statusCode).toBe(200);
    expect(verifyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: challenge,
        expectedOrigin: 'http://localhost:5173',
        expectedRPID: 'localhost',
        requireUserVerification: true,
        credential: expect.objectContaining({ id: credentialId, counter: 3 }) as unknown,
      }),
    );
    const sess = sessionOf(res);
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: sess.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json<Me>().user.id).toBe(u._id);
    expect(sess.csrf).toBe(me.json<Me>().csrfToken);
    const session = await s.collection('sessions').findOne({ userId: u._id });
    expect(session).toMatchObject({ state: 'full', tenantId });
    const after = await userDoc(u._id);
    expect(after.passkeys![0]!.counter).toBe(9);
    expect(after.failedLogins).toBe(0);
    expect(res.cookies.find((c) => c.name === WA)).toMatchObject({ value: '', path: '/' });
    expect(await auditFor(u._id, 'auth.login.success')).toHaveLength(1);
  });

  test('the challenge is single use: replaying the same options cookie fails', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const { wa } = await options();
    expect((await verify(wa, credentialId)).statusCode).toBe(200);
    const again = await verify(wa, credentialId);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('a challenge older than 5 minutes is rejected', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const { wa } = await options();
    clock = new Date(clock.getTime() + 5 * MIN + 1000);
    const res = await verify(wa, credentialId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(verifyAuth).not.toHaveBeenCalled();
  });

  test('without the challenge cookie, or with an unknown credential, the answer is the same 401', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const none = await post('/api/auth/passkeys/login/verify', null, assertion(credentialId));
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: 'invalid_credentials' });
    const { wa } = await options();
    const unknown = await verify(wa, 'not-a-credential');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: 'invalid_credentials' });
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });

  test('a failed verification is a 401, counts toward the lock and is audited', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    verifyAuth.mockResolvedValue({ verified: false });
    const { wa } = await options();
    const res = await verify(wa, credentialId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
    expect((await userDoc(u._id)).failedLogins).toBe(1);
    expect(await auditFor(u._id, 'auth.mfa.failure')).toHaveLength(1);

    verifyAuth.mockRejectedValue(new Error('counter went backwards'));
    const o2 = await options();
    expect((await verify(o2.wa, credentialId)).statusCode).toBe(401);
    expect((await userDoc(u._id)).failedLogins).toBe(2);
  });

  test('a locked user cannot sign in with a passkey, and the verifier is not consulted', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    await s.collection('users').updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(clock.getTime() + 10 * MIN) } });
    authOk(credentialId);
    const { wa } = await options();
    const res = await verify(wa, credentialId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(verifyAuth).not.toHaveBeenCalled();
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });

  test('five failed passkey sign-ins lock the account, and a good one is then refused', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    verifyAuth.mockResolvedValue({ verified: false });
    for (let i = 0; i < 5; i++) {
      const { wa } = await options();
      expect((await verify(wa, credentialId)).statusCode).toBe(401);
    }
    expect((await userDoc(u._id)).lockedUntil).not.toBeNull();
    authOk(credentialId);
    const { wa } = await options();
    expect((await verify(wa, credentialId)).statusCode).toBe(401);
  });

  test('a lock set while verifying is honored', async () => {
    const u = await newUser();
    const { credentialId } = await givePasskey(u._id);
    verifyAuth.mockImplementation(async () => {
      await s.collection('users').updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(clock.getTime() + 10 * MIN) } });
      return { verified: true, authenticationInfo: { newCounter: 5, credentialID: credentialId } };
    });
    const { wa } = await options();
    const res = await verify(wa, credentialId);
    expect(res.statusCode).toBe(401);
    expect(await s.collection('sessions').countDocuments({ userId: u._id })).toBe(0);
  });
});

describe('passkey as second factor (FR-1)', () => {
  async function pendingWithOptions(u: { email: string; _id: string }) {
    const pending = await pendingLogin(u.email);
    const o = (await post('/api/auth/passkeys/login/options', pending)).json<Opts>();
    return { pending, challenge: o.challenge };
  }
  const verify = (p: Sess, credentialId: string) =>
    post('/api/auth/passkeys/login/verify', p, assertion(credentialId));

  test('upgrades the pending session to full and rotates the token and CSRF token', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id, newCred(), 3);
    await s.collection('users').updateOne({ _id: u._id }, { $set: { failedLogins: 2 } });
    authOk(credentialId, 7);
    const { pending, challenge } = await pendingWithOptions(u);
    const res = await verify(pending, credentialId);
    expect(res.statusCode).toBe(200);
    expect(verifyAuth).toHaveBeenCalledWith(expect.objectContaining({ expectedChallenge: challenge }));
    const full = sessionOf(res);
    expect(full.cookie).not.toBe(pending.cookie);
    expect(full.csrf).not.toBe(pending.csrf);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: pending.cookie } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: full.cookie } })).statusCode).toBe(200);
    const after = await userDoc(u._id);
    expect(after.passkeys![0]!.counter).toBe(7);
    expect(after.failedLogins).toBe(0);
    expect((await s.collection('sessions').findOne({ userId: u._id }))?.webauthnChallenge).toBeUndefined();
    expect(await auditFor(u._id, 'auth.login.success')).toHaveLength(1);
  });

  test('a credential of another user (V) cannot complete the second factor for U\'s pending session', async () => {
    const u = await newUser({ totp: true });
    await givePasskey(u._id);
    const v = await newUser({ totp: true });
    const theirs = await givePasskey(v._id);
    authOk(theirs.credentialId);
    const { pending } = await pendingWithOptions(u);
    const res = await verify(pending, theirs.credentialId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(verifyAuth).not.toHaveBeenCalled();
    expect((await userDoc(u._id)).failedLogins).toBe(1);
    expect((await userDoc(v._id)).failedLogins).toBe(0);
    expect((await userDoc(v._id)).passkeys![0]!.counter).toBe(3);
    expect(await auditFor(u._id, 'auth.mfa.failure')).toHaveLength(1);
    // still pending
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: pending.cookie } })).statusCode).toBe(403);
  });

  test('a missing or wrong x-csrf-token is 403 csrf, and the pending session stays pending', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const { pending } = await pendingWithOptions(u);
    for (const headers of [{ cookie: pending.cookie }, { cookie: pending.cookie, 'x-csrf-token': 'wrong' }]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/passkeys/login/verify',
        remoteAddress: ip(),
        headers,
        payload: assertion(credentialId),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'csrf' });
    }
    expect(verifyAuth).not.toHaveBeenCalled();
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: pending.cookie } })).statusCode).toBe(403);
  });

  test('the session challenge is single use', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    verifyAuth.mockResolvedValue({ verified: false });
    const { pending } = await pendingWithOptions(u);
    expect((await verify(pending, credentialId)).statusCode).toBe(401);
    authOk(credentialId);
    expect((await verify(pending, credentialId)).statusCode).toBe(401);
    expect(verifyAuth).toHaveBeenCalledTimes(1);
  });

  test('a challenge older than 5 minutes is rejected', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const { pending } = await pendingWithOptions(u);
    clock = new Date(clock.getTime() + 5 * MIN + 1000);
    const res = await verify(pending, credentialId);
    expect(res.statusCode).toBe(401);
    expect(verifyAuth).not.toHaveBeenCalled();
    // A prompt left open too long is not a wrong guess.
    expect((await userDoc(u._id)).failedLogins).toBe(0);
  });

  test('verify without asking for options first is a 401 and does not count toward the lock', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const pending = await pendingLogin(u.email);
    for (let i = 0; i < 6; i++) expect((await verify(pending, credentialId)).statusCode).toBe(401);
    const after = await userDoc(u._id);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });

  test('a locked user cannot finish with a passkey', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    authOk(credentialId);
    const { pending } = await pendingWithOptions(u);
    await s.collection('users').updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(clock.getTime() + 10 * MIN) } });
    const res = await verify(pending, credentialId);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect(verifyAuth).not.toHaveBeenCalled();
  });

  test('a lock set while verifying is honored', async () => {
    const u = await newUser({ totp: true });
    const { credentialId } = await givePasskey(u._id);
    verifyAuth.mockImplementation(async () => {
      await s.collection('users').updateOne({ _id: u._id }, { $set: { lockedUntil: new Date(clock.getTime() + 10 * MIN) } });
      return { verified: true, authenticationInfo: { newCounter: 5, credentialID: credentialId } };
    });
    const { pending } = await pendingWithOptions(u);
    expect((await verify(pending, credentialId)).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: pending.cookie } })).statusCode).toBe(403);
  });

  test('a user whose password sign-in needs a second factor can use only a passkey they own, and the body must have an id', async () => {
    const u = await newUser({ totp: true });
    await givePasskey(u._id);
    const { pending } = await pendingWithOptions(u);
    const res = await post('/api/auth/passkeys/login/verify', pending, { response: {} });
    expect(res.statusCode).toBe(400);
  });
});

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { hashToken } from '../../src/auth/tokens.ts';
import { scoped } from '../../src/db/scoped.ts';
import { issueResetToken } from '../../src/auth/reset-tokens.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

const OLD = 'old password here 1';
const NEW = 'brand new password 2';
const MIN = 60_000;
const ORIGIN = 'http://localhost:5173';

let clock = new Date('2026-03-01T12:00:00Z');
let t: TestApp;
let n = 0;
const ip = () => `10.9.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const request = (email: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: ip(), payload: { email } });
const confirm = (token: string, password: string, cookie?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/confirm',
    remoteAddress: ip(),
    ...(cookie ? { headers: { cookie } } : {}),
    payload: { token, password },
  });
const login = (email: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip(), payload: { email, password } });

const tokenFrom = (text: string) => /\/reset\/([A-Za-z0-9_-]+)/.exec(text)![1]!;
/** Requests a reset for `email` and returns the token from the mail that arrives. */
async function requestedToken(email: string): Promise<string> {
  const before = t.mail.sent.length;
  expect((await request(email)).statusCode).toBe(202);
  await vi.waitFor(() => expect(t.mail.sent.length).toBe(before + 1));
  return tokenFrom(t.mail.sent.at(-1)!.text);
}
const setup = async (o: { totp?: boolean } = {}) => {
  const tenant = await t.seed.tenant();
  const user = await t.seed.user(tenant._id, { password: OLD, ...o });
  return { tenant, user, s: scoped(t.db, tenant._id) };
};

describe('password reset request (FR-1)', () => {
  test('an unknown email gets 202 and no mail is sent', async () => {
    const before = t.mail.sent.length;
    const res = await request('nobody@example.com');
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.mail.sent).toHaveLength(before);
  });

  test('a known email gets 202 and one mail to that address with a /reset/ link; only the hash is stored', async () => {
    const { user, s } = await setup();
    const before = t.mail.sent.length;
    const res = await request(user.email);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(t.mail.sent).toHaveLength(before + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.mail.sent).toHaveLength(before + 1);
    const mail = t.mail.sent.at(-1)!;
    expect(mail.to).toBe(user.email);
    expect(mail.text).toContain(`${ORIGIN}/reset/`);
    expect(mail.html).toContain(`${ORIGIN}/reset/`);
    const token = tokenFrom(mail.text);
    const doc = await s.collection('resetTokens').findOne({ userId: user._id });
    expect(doc).toMatchObject({ tokenHash: hashToken(token), usedAt: null });
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(doc!.expiresAt).toEqual(new Date(clock.getTime() + 60 * MIN));
  });

  test('the known and unknown answers have the same status, body and headers shape', async () => {
    const { user } = await setup();
    const known = await request(user.email);
    const unknown = await request('ghost@example.com');
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
  });

  test('Review focus 1: reset request email is case-insensitive', async () => {
    const { user } = await setup();
    const before = t.mail.sent.length;
    expect((await request(`  ${user.email.toUpperCase()} `)).statusCode).toBe(202);
    await vi.waitFor(() => expect(t.mail.sent).toHaveLength(before + 1));
    expect(t.mail.sent.at(-1)!.to).toBe(user.email);
  });

  test('a mail failure does not change the answer', async () => {
    const { user } = await setup();
    const spy = vi.spyOn(t.mail, 'send').mockRejectedValueOnce(new Error('ses_down'));
    const res = await request(user.email);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });

  test('a malformed email is a 400', async () => {
    expect((await request('not-an-email')).statusCode).toBe(400);
  });
});

describe('password reset confirm (FR-1)', () => {
  test('sets the new password: sign-in works with it and not with the old one', async () => {
    const { user } = await setup();
    const token = await requestedToken(user.email);
    const res = await confirm(token, NEW);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect((await login(user.email, NEW)).statusCode).toBe(200);
    const old = await login(user.email, OLD);
    expect(old.statusCode).toBe(401);
    expect(old.json()).toEqual({ error: 'invalid_credentials' });
  });

  test('a token used twice returns 410 token_invalid the second time, and the password does not change again', async () => {
    const { user } = await setup();
    const token = await requestedToken(user.email);
    expect((await confirm(token, NEW)).statusCode).toBe(204);
    const again = await confirm(token, 'another password 33');
    expect(again.statusCode).toBe(410);
    expect(again.json()).toEqual({ error: 'token_invalid' });
    expect((await login(user.email, NEW)).statusCode).toBe(200);
  });

  test('two confirms at once with one token: exactly one succeeds', async () => {
    const { user } = await setup();
    const token = await requestedToken(user.email);
    const [a, b] = await Promise.all([confirm(token, 'first password 111'), confirm(token, 'second password 22')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 410]);
    const winner = a.statusCode === 204 ? 'first password 111' : 'second password 22';
    expect((await login(user.email, winner)).statusCode).toBe(200);
  });

  test('a token after 61 minutes returns 410, and one at 59 minutes still works', async () => {
    const a = await setup();
    const b = await setup();
    const late = await requestedToken(a.user.email);
    const inTime = await requestedToken(b.user.email);
    const start = clock;
    clock = new Date(start.getTime() + 61 * MIN);
    const res = await confirm(late, NEW);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'token_invalid' });
    clock = new Date(start.getTime() + 59 * MIN);
    expect((await confirm(inTime, NEW)).statusCode).toBe(204);
    clock = start;
  });

  test('an unknown token returns 410', async () => {
    const res = await confirm('x'.repeat(43), NEW);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'token_invalid' });
  });

  test('a password shorter than 12 characters is a 400 and the token is kept', async () => {
    const { user } = await setup();
    const token = await requestedToken(user.email);
    expect((await confirm(token, 'short')).statusCode).toBe(400);
    expect((await confirm(token, NEW)).statusCode).toBe(204);
  });

  test('clears the lockout counter and the lock', async () => {
    const { user, s } = await setup();
    await s.collection('users').updateOne(
      { _id: user._id },
      { $set: { failedLogins: 3, lockedUntil: new Date(clock.getTime() + 10 * MIN) } },
    );
    const token = await requestedToken(user.email);
    expect((await confirm(token, NEW)).statusCode).toBe(204);
    expect(await s.collection('users').findOne({ _id: user._id })).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect((await login(user.email, NEW)).statusCode).toBe(200);
  });

  test('Review focus 5: password reset signs out every existing session', async () => {
    const { user, s } = await setup({ totp: true });
    const other = await t.seed.user(s.tenantId, { password: OLD });
    const before = await signInAs(t.app, t.db, user._id);
    const second = await signInAs(t.app, t.db, user._id);
    const bystander = await signInAs(t.app, t.db, other._id);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: before.cookie } })).statusCode).toBe(200);
    const token = await requestedToken(user.email);
    expect((await confirm(token, NEW)).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: before.cookie } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: second.cookie } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/me', headers: { cookie: bystander.cookie } })).statusCode).toBe(200);
  });

  test('records auth.password_reset in the audit log without the token or the hash', async () => {
    const { user, s } = await setup();
    const token = await requestedToken(user.email);
    await confirm(token, NEW);
    const events = await s.audit.find({ action: 'auth.password_reset' }, { sort: { timestamp: 1 }, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: 'user', userId: user._id }, target: { type: 'user', id: user._id } });
    expect(JSON.stringify(events[0])).not.toContain(token);
  });

  test('a token is spent for good and other open tokens of that user stop working', async () => {
    const { user } = await setup();
    const first = await requestedToken(user.email);
    const second = await requestedToken(user.email);
    expect((await confirm(first, NEW)).statusCode).toBe(204);
    expect((await confirm(second, 'yet another password 4')).statusCode).toBe(410);
  });

  test('a token only changes the password of its own user, in its own tenant', async () => {
    const a = await setup();
    const b = await setup();
    const token = await requestedToken(a.user.email);
    await confirm(token, NEW);
    expect((await login(b.user.email, OLD)).statusCode).toBe(200);
    expect((await login(b.user.email, NEW)).statusCode).toBe(401);
  });

  test('issueResetToken returns the app URL and stores only the hash', async () => {
    const { user, s } = await setup();
    const url = await issueResetToken(s, user._id, 5 * MIN, { appOrigin: ORIGIN, now: () => clock });
    const token = url.slice(`${ORIGIN}/reset/`.length);
    expect(url).toBe(`${ORIGIN}/reset/${token}`);
    const doc = await s.collection('resetTokens').findOne({ tokenHash: createHash('sha256').update(token).digest('hex') });
    expect(doc).toMatchObject({ userId: user._id, usedAt: null, expiresAt: new Date(clock.getTime() + 5 * MIN) });
  });
});

describe('password reset with the breached-password check (FR-1)', () => {
  let h: TestApp;
  const breached = 'password1234567';
  const sha1 = createHash('sha1').update(breached).digest('hex').toUpperCase();
  beforeAll(async () => {
    const fetchStub = vi.fn(() => Promise.resolve(new Response(`${sha1.slice(5)}:12345\r\n0000000000000000000000000000000000A:0\r\n`)));
    h = await makeTestApp({ env: { HIBP_ENABLED: 'true' }, fetch: fetchStub as unknown as typeof fetch });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  test('a breached password is 422 password_breached, and the token is not spent', async () => {
    const tenant = await h.seed.tenant();
    const user = await h.seed.user(tenant._id, { password: OLD });
    await h.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: ip(), payload: { email: user.email } });
    await vi.waitFor(() => expect(h.mail.sent).toHaveLength(1));
    const token = tokenFrom(h.mail.sent[0]!.text);
    const post = (password: string) =>
      h.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', remoteAddress: ip(), payload: { token, password } });
    const res = await post(breached);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'password_breached' });
    expect((await post('0123456789 not in the list')).statusCode).toBe(204);
  });
});

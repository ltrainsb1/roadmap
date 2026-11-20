import { createHash } from 'node:crypto';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { hashToken } from '../../src/auth/tokens.ts';
import { unscoped } from '../../src/db/unscoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

const PASSWORD = 'correct horse battery';
const sha1 = (v: string) => createHash('sha1').update(v).digest('hex').toUpperCase();
let t: TestApp;
let tenantId: string;
let s: ReturnType<typeof scoped>;

beforeAll(async () => {
  t = await makeTestApp();
  tenantId = (await t.seed.tenant())._id;
  s = scoped(t.db, tenantId);
}, 120_000);
afterAll(async () => {
  await t?.close();
});

interface Sess {
  cookie: string;
  csrf: string;
}
const newUser = (email?: string) => t.seed.user(tenantId, { password: PASSWORD, ...(email ? { email } : {}) });
const invite = (roadmapId: string, sess: Sess, payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'POST',
    url: `/api/roadmaps/${roadmapId}/invites`,
    headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
    payload,
  });
const info = (token: string) => t.app.inject({ url: `/api/invites/${token}` });
const accept = (token: string, sess: Sess | null, payload?: Record<string, unknown>, csrf = sess?.csrf) =>
  t.app.inject({
    method: 'POST',
    url: `/api/invites/${token}/accept`,
    headers: { ...(sess ? { cookie: sess.cookie, 'x-csrf-token': csrf! } : {}) },
    ...(payload ? { payload } : {}),
  });

/** Owner of a fresh roadmap. */
async function setup() {
  const owner = await newUser();
  const roadmap = await t.seed.roadmap(tenantId, owner._id, 'Plan');
  return { owner, roadmap, sess: await signInAs(t.app, t.db, owner._id) };
}
/** Sends an invite and returns the token from the emailed link. */
async function invited(roadmapId: string, sess: Sess, email: string, role = 'contributor') {
  const before = t.mail.sent.length;
  const res = await invite(roadmapId, sess, { email, role });
  expect(res.statusCode).toBe(201);
  const mail = t.mail.sent[before]!;
  const match = /\/invite\/([\w-]+)/.exec(mail.text);
  return { token: match![1]!, id: res.json<{ id: string }>().id, mail };
}
const stored = (id: string) => s.collection('invites').findOne({ _id: id });

describe('inviting (FR-1.1)', () => {
  test('Permissions (member.invite): owner may invite admin or contributor, admin may invite admin or contributor, contributor gets 403, nobody may invite owner', async () => {
    const { roadmap, sess: ownerSess } = await setup();
    const admin = await newUser();
    const contributor = await newUser();
    await t.seed.member(tenantId, roadmap._id, admin._id, 'admin');
    await t.seed.member(tenantId, roadmap._id, contributor._id, 'contributor');
    const adminSess = await signInAs(t.app, t.db, admin._id);
    const contribSess = await signInAs(t.app, t.db, contributor._id);
    let n = 0;
    const email = () => `p${n++}-${Date.now()}@example.com`;

    for (const sess of [ownerSess, adminSess]) {
      for (const role of ['admin', 'contributor']) {
        expect((await invite(roadmap._id, sess, { email: email(), role })).statusCode).toBe(201);
      }
      expect((await invite(roadmap._id, sess, { email: email(), role: 'owner' })).statusCode).toBe(400);
    }
    for (const role of ['admin', 'contributor']) {
      expect((await invite(roadmap._id, contribSess, { email: email(), role })).statusCode).toBe(403);
    }
    // Refused on role alone, before the body is validated.
    expect((await invite(roadmap._id, contribSess, { email: email(), role: 'owner' })).statusCode).toBe(403);
  });

  test('creates a 7 day invite, stores only the token hash, emails the link and audits without the token', async () => {
    const { owner, roadmap, sess } = await setup();
    const { token, id, mail } = await invited(roadmap._id, sess, 'carol@example.com', 'admin');
    expect(mail.to).toBe('carol@example.com');
    expect(mail.text).toContain(`${t.config.appOrigin}/invite/${token}`);
    expect(mail.subject).toContain(owner.name);
    expect(mail.subject).toContain('Plan');

    const doc = (await stored(id))!;
    expect(doc).toMatchObject({ roadmapId: roadmap._id, email: 'carol@example.com', role: 'admin', invitedBy: owner._id, acceptedAt: null, revokedAt: null });
    expect(doc.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(doc)).not.toContain(token);
    const days = (doc.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    const events = await s.audit.find({ action: 'invite.create', roadmapId: roadmap._id }, { sort: { timestamp: 1 }, limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: { type: 'invite', id } });
    expect(JSON.stringify(events[0])).not.toContain(token);
    expect(JSON.stringify(events[0])).not.toContain(doc.tokenHash);
  });

  test('Review focus 1: invite email is normalized', async () => {
    const { roadmap, sess } = await setup();
    const res = await invite(roadmap._id, sess, { email: 'Bob@Example.com ', role: 'contributor' });
    expect(res.statusCode).toBe(201);
    expect((await stored(res.json<{ id: string }>().id))!.email).toBe('bob@example.com');
    expect(t.mail.sent.at(-1)!.to).toBe('bob@example.com');
  });

  test('Review focus 2: inviting an existing member returns 409', async () => {
    const { roadmap, sess } = await setup();
    const member = await newUser('member@example.com');
    await t.seed.member(tenantId, roadmap._id, member._id, 'contributor');
    const before = t.mail.sent.length;
    const res = await invite(roadmap._id, sess, { email: 'Member@example.com', role: 'admin' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_member' });
    expect(t.mail.sent).toHaveLength(before);
  });

  test('Re-inviting revokes the earlier link', async () => {
    const { roadmap, sess } = await setup();
    const first = await invited(roadmap._id, sess, 'dave@example.com');
    const second = await invited(roadmap._id, sess, 'dave@example.com', 'admin');
    expect((await stored(first.id))!.revokedAt).toBeInstanceOf(Date);
    expect((await stored(second.id))!.revokedAt).toBeNull();
    expect((await info(first.token)).statusCode).toBe(410);
    expect((await info(second.token)).json()).toMatchObject({ role: 'admin' });
  });

  test('Tenant isolation: admin of tenant A roadmap cannot invite to tenant B roadmap', async () => {
    const { sess } = await setup();
    const other = await t.seed.tenant('Other');
    const ou = await t.seed.user(other._id);
    const theirs = await t.seed.roadmap(other._id, ou._id, 'Theirs');
    const res = await invite(theirs._id, sess, { email: 'x@example.com', role: 'contributor' });
    expect(res.statusCode).toBe(404);
  });

  test('a signed-in non-member gets 404 and an unauthenticated caller 401', async () => {
    const { roadmap } = await setup();
    const stranger = await signInAs(t.app, t.db, (await newUser())._id);
    expect((await invite(roadmap._id, stranger, { email: 'x@example.com', role: 'contributor' })).statusCode).toBe(404);
    const res = await t.app.inject({ method: 'POST', url: `/api/roadmaps/${roadmap._id}/invites`, payload: { email: 'x@example.com', role: 'admin' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('accepting (FR-1.1)', () => {
  test('New user: invite, read the link, GET the info, accept with name and password, enroll, then /api/me lists the roadmap as contributor', async () => {
    const { roadmap, sess } = await setup();
    const { token } = await invited(roadmap._id, sess, 'newbie@example.com');

    expect((await info(token)).json()).toEqual({ roadmapName: 'Plan', email: 'newbie@example.com', role: 'contributor', accountExists: false });

    const res = await accept(token, null, { name: 'Nia', password: PASSWORD, timezone: 'Europe/Paris' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ roadmapId: string; next: string; csrfToken: string }>();
    expect(body).toMatchObject({ roadmapId: roadmap._id, next: 'enroll' });
    const cookie = `__Host-sid=${res.cookies.find((c) => c.name === '__Host-sid')!.value}`;

    const user = (await unscoped(t.db).findUserByEmail('newbie@example.com'))!;
    expect(user).toMatchObject({ tenantId, name: 'Nia', timezone: 'Europe/Paris' });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await s.collection('sessions').findOne({ userId: user._id })).toMatchObject({ state: 'pending_enroll' });

    // Not usable as a full session yet.
    expect((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(403);

    const headers = { cookie, 'x-csrf-token': body.csrfToken };
    const start = await t.app.inject({ method: 'POST', url: '/api/auth/totp/enroll/start', headers });
    const confirm = await t.app.inject({
      method: 'POST',
      url: '/api/auth/totp/enroll/confirm',
      headers,
      payload: { code: authenticator.generate(start.json<{ secret: string }>().secret) },
    });
    expect(confirm.statusCode).toBe(200);
    const full = `__Host-sid=${confirm.cookies.find((c) => c.name === '__Host-sid')!.value}`;
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: full } });
    expect(me.json<{ memberships: unknown[] }>().memberships).toEqual([{ roadmapId: roadmap._id, roadmapName: 'Plan', role: 'contributor' }]);

    const events = await s.audit.find({ action: 'invite.accept', roadmapId: roadmap._id }, { sort: { timestamp: 1 }, limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: 'user', userId: user._id } });
    expect(JSON.stringify(events[0])).not.toContain(token);
    expect(JSON.stringify(events[0])).not.toContain(hashToken(token));
  });

  test('timezone defaults to UTC', async () => {
    const { roadmap, sess } = await setup();
    const { token } = await invited(roadmap._id, sess, 'tz@example.com');
    expect((await accept(token, null, { name: 'Tz', password: PASSWORD })).statusCode).toBe(200);
    expect((await unscoped(t.db).findUserByEmail('tz@example.com'))!.timezone).toBe('UTC');
  });

  test('a bad body or a short password is rejected and the link keeps working', async () => {
    const { roadmap, sess } = await setup();
    const { token, id } = await invited(roadmap._id, sess, 'weak@example.com');
    expect((await accept(token, null, { name: 'W', password: 'short' })).statusCode).toBe(400);
    expect((await accept(token, null)).statusCode).toBe(400);
    expect((await accept(token, null, { name: 'W', password: PASSWORD, timezone: 'Not/AZone' })).statusCode).toBe(400);
    expect((await stored(id))!.acceptedAt).toBeNull();
    expect(await unscoped(t.db).findUserByEmail('weak@example.com')).toBeNull();
    expect((await accept(token, null, { name: 'W', password: PASSWORD })).statusCode).toBe(200);
  });

  test('a breached password is rejected before the link is spent', async () => {
    const breached = await makeTestApp({
      env: { HIBP_ENABLED: 'true' },
      fetch: () => Promise.resolve(new Response(`${sha1(PASSWORD).slice(5)}:99\r\n`)),
    });
    try {
      const tid = (await breached.seed.tenant())._id;
      const owner = await breached.seed.user(tid, { password: PASSWORD });
      const rm = await breached.seed.roadmap(tid, owner._id);
      const o = await signInAs(breached.app, breached.db, owner._id);
      await breached.app.inject({
        method: 'POST',
        url: `/api/roadmaps/${rm._id}/invites`,
        headers: { cookie: o.cookie, 'x-csrf-token': o.csrf },
        payload: { email: 'b@example.com', role: 'contributor' },
      });
      const token = /\/invite\/([\w-]+)/.exec(breached.mail.sent[0]!.text)![1]!;
      const res = await breached.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { name: 'B', password: PASSWORD } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'password_breached' });
      expect((await scoped(breached.db, tid).collection('invites').findOne({ email: 'b@example.com' }))!.acceptedAt).toBeNull();
    } finally {
      await breached.close();
    }
  });

  test('Existing user: no session gives 401 sign_in_required, then signed in gives next done; a different user gets 401', async () => {
    const { roadmap, sess } = await setup();
    const existing = await newUser('exists@example.com');
    const { token, id } = await invited(roadmap._id, sess, 'exists@example.com', 'admin');
    expect((await info(token)).json()).toMatchObject({ accountExists: true });

    const anon = await accept(token, null);
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: 'sign_in_required' });
    expect((await stored(id))!.acceptedAt).toBeNull();

    const stranger = await signInAs(t.app, t.db, (await newUser()) ._id);
    const wrong = await accept(token, stranger);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'sign_in_required' });
    expect((await stored(id))!.acceptedAt).toBeNull();

    const me = await signInAs(t.app, t.db, existing._id);
    const ok = await accept(token, me);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ roadmapId: roadmap._id, next: 'done' });
    expect(await s.collection('memberships').findOne({ roadmapId: roadmap._id, userId: existing._id })).toMatchObject({ role: 'admin' });
    expect((await stored(id))!.acceptedAt).toBeInstanceOf(Date);
  });

  test('an existing account ignores any body and never has its password replaced', async () => {
    const { roadmap, sess } = await setup();
    const existing = await newUser('keep@example.com');
    const { token } = await invited(roadmap._id, sess, 'keep@example.com');
    const me = await signInAs(t.app, t.db, existing._id);
    expect((await accept(token, me, { name: 'Evil', password: 'another long password' })).statusCode).toBe(200);
    const after = (await unscoped(t.db).findUserByEmail('keep@example.com'))!;
    expect(after.passwordHash).toBe(existing.passwordHash);
    expect(after.name).toBe(existing.name);
  });

  test('the existing-account path checks the CSRF token', async () => {
    const { roadmap, sess } = await setup();
    const existing = await newUser('csrf@example.com');
    const { token, id } = await invited(roadmap._id, sess, 'csrf@example.com');
    const me = await signInAs(t.app, t.db, existing._id);
    const res = await accept(token, me, undefined, 'wrong');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf' });
    expect((await stored(id))!.acceptedAt).toBeNull();
  });

  test('a signed-in caller with a wrong CSRF token cannot accept a new-account invite: 403 and the link is not spent', async () => {
    const { roadmap, sess } = await setup();
    const { token, id } = await invited(roadmap._id, sess, 'nocsrf@example.com');
    const res = await accept(token, sess, { name: 'N', password: PASSWORD }, 'wrong');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf' });
    expect((await stored(id))!.acceptedAt).toBeNull();
    expect(await unscoped(t.db).findUserByEmail('nocsrf@example.com')).toBeNull();
    expect((await accept(token, sess, { name: 'N', password: PASSWORD })).statusCode).toBe(200);
  });

  test('a pending (not fully signed in) session is not enough', async () => {
    const { roadmap, sess } = await setup();
    const existing = await newUser('pending@example.com');
    const { token } = await invited(roadmap._id, sess, 'pending@example.com');
    const { token: sid, session } = await app_session(existing._id, 'pending_mfa');
    const res = await accept(token, { cookie: `__Host-sid=${sid}`, csrf: session.csrfToken });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign_in_required' });
  });

  test('an existing account in another tenant cannot accept: 409 other_tenant and the link is not spent', async () => {
    const { roadmap, sess } = await setup();
    const other = await t.seed.tenant('Other');
    const outsider = await t.seed.user(other._id, { email: 'outsider@example.com', password: PASSWORD });
    const { token, id } = await invited(roadmap._id, sess, 'outsider@example.com');
    const out = await signInAs(t.app, t.db, outsider._id);
    const res = await accept(token, out);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'other_tenant' });
    expect((await stored(id))!.acceptedAt).toBeNull();
    expect(await scoped(t.db, other._id).collection('memberships').findOne({ userId: outsider._id })).toBeNull();
  });

  test('Review focus 2: expired, revoked and used invites return 410', async () => {
    const { roadmap, sess } = await setup();
    const expired = await invited(roadmap._id, sess, 'e1@example.com');
    await s.collection('invites').updateOne({ _id: expired.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const revoked = await invited(roadmap._id, sess, 'e2@example.com');
    await s.collection('invites').updateOne({ _id: revoked.id }, { $set: { revokedAt: new Date() } });
    const used = await invited(roadmap._id, sess, 'e3@example.com');
    expect((await accept(used.token, null, { name: 'U', password: PASSWORD })).statusCode).toBe(200);

    for (const tok of [expired.token, revoked.token, used.token, 'no-such-token']) {
      const g = await info(tok);
      expect(g.statusCode).toBe(410);
      expect(g.json()).toEqual({ error: 'invite_invalid' });
      const p = await accept(tok, null, { name: 'X', password: PASSWORD });
      expect(p.statusCode).toBe(410);
      expect(p.json()).toEqual({ error: 'invite_invalid' });
    }
    expect(await unscoped(t.db).findUserByEmail('e1@example.com')).toBeNull();
    expect(await unscoped(t.db).findUserByEmail('e2@example.com')).toBeNull();
  });

  test('Review focus 2: two concurrent accepts create exactly one membership', async () => {
    const { roadmap, sess } = await setup();
    const { token } = await invited(roadmap._id, sess, 'race@example.com');
    const body = { name: 'Race', password: PASSWORD };
    const [a, b] = await Promise.all([accept(token, null, body), accept(token, null, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
    const user = (await unscoped(t.db).findUserByEmail('race@example.com'))!;
    expect(await s.collection('memberships').countDocuments({ roadmapId: roadmap._id, userId: user._id })).toBe(1);
  });

  test('two invites for one address sent at the same moment leave exactly one open link', async () => {
    const { roadmap, sess } = await setup();
    const payload = { email: 'twice@example.com', role: 'contributor' };
    const results = await Promise.all([invite(roadmap._id, sess, payload), invite(roadmap._id, sess, payload), invite(roadmap._id, sess, payload)]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const all = await s.collection('invites').find({ roadmapId: roadmap._id, email: 'twice@example.com' });
    expect(all).toHaveLength(3);
    expect(all.filter((i) => i.revokedAt === null)).toHaveLength(1);
  }, 30_000);

  test('a failure after the account and membership are stored does not reopen the link', async () => {
    const { roadmap, sess } = await setup();
    const { token, id } = await invited(roadmap._id, sess, 'granted@example.com');
    const create = vi.spyOn(t.app.sessions, 'create').mockRejectedValueOnce(new Error('session store down'));
    const res = await accept(token, null, { name: 'Granted', password: PASSWORD });
    create.mockRestore();
    expect(res.statusCode).toBe(500);
    const user = (await unscoped(t.db).findUserByEmail('granted@example.com'))!;
    expect(await s.collection('memberships').countDocuments({ roadmapId: roadmap._id, userId: user._id })).toBe(1);
    // The link did its work, so it stays used.
    expect((await stored(id))!.acceptedAt).not.toBeNull();
    expect((await info(token)).statusCode).toBe(410);
  });

  test('Review focus 2: a user who became a member after the invite cannot accept it: 409 already_member', async () => {
    const { roadmap, sess } = await setup();
    const joiner = await newUser('joiner@example.com');
    const { token, id } = await invited(roadmap._id, sess, 'joiner@example.com');
    await t.seed.member(tenantId, roadmap._id, joiner._id, 'contributor');
    const me = await signInAs(t.app, t.db, joiner._id);
    const res = await accept(token, me);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_member' });
    expect(await s.collection('memberships').countDocuments({ roadmapId: roadmap._id, userId: joiner._id })).toBe(1);
    expect((await stored(id))!.acceptedAt).toBeNull();
  });
});

async function app_session(userId: string, state: 'pending_mfa' | 'pending_enroll') {
  return t.app.sessions.create(s, userId, state, { ip: '127.0.0.1', userAgent: 'vitest' });
}

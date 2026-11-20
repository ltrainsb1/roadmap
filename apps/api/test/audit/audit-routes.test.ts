import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

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

type Sess = { cookie: string; csrf: string };
const headers = (x: Sess) => ({ cookie: x.cookie, 'x-csrf-token': x.csrf });

async function named(name: string) {
  const u = await t.seed.user(tenantId, { email: `${name.toLowerCase().replaceAll(' ', '.')}-${crypto.randomUUID()}@example.com` });
  await s.collection('users').updateOne({ _id: u._id }, { $set: { name } });
  return { ...u, sess: await signInAs(t.app, t.db, u._id) };
}

async function world() {
  const O = await named('Olga Owner');
  const A1 = await named('Adam Admin');
  const C1 = await named('Cora Contributor');
  const roadmap = await t.seed.roadmap(tenantId, O._id, 'Plan');
  await t.seed.member(tenantId, roadmap._id, A1._id, 'admin');
  await t.seed.member(tenantId, roadmap._id, C1._id, 'contributor');
  const audit = (sess: Sess, query = '') =>
    t.app.inject({ url: `/api/roadmaps/${roadmap._id}/audit${query}`, headers: headers(sess) });
  return { O, A1, C1, roadmap, audit };
}

interface Item {
  action: string;
  actor: { type: string; userId?: string; name?: string | null };
  timestamp: string;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

describe('GET /api/roadmaps/:id/audit (audit.view)', () => {
  test('after invite, accept and role-change, the owner sees the events newest first with actor names', async () => {
    const w = await world();
    const joiner = await named('Jo Joiner');
    const inv = await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${w.roadmap._id}/invites`,
      headers: headers(w.O.sess),
      payload: { email: joiner.email, role: 'contributor' },
    });
    expect(inv.statusCode).toBe(201);
    const token = /\/invite\/([\w-]+)/.exec(t.mail.sent.at(-1)!.text)![1]!;
    const acc = await t.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: headers(joiner.sess) });
    expect(acc.statusCode).toBe(200);
    const change = await t.app.inject({
      method: 'PATCH',
      url: `/api/roadmaps/${w.roadmap._id}/members/${joiner._id}`,
      headers: headers(w.A1.sess),
      payload: { role: 'admin' },
    });
    expect(change.statusCode).toBe(204);

    const res = await w.audit(w.O.sess);
    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    expect(page.items.map((i) => i.action)).toEqual(['member.role_change', 'invite.accept', 'invite.create']);
    expect(page.items.map((i) => i.actor.name)).toEqual(['Adam Admin', 'Jo Joiner', 'Olga Owner']);
    expect(page.items[0]!.actor).toEqual({ type: 'user', userId: w.A1._id, name: 'Adam Admin' });
    const times = page.items.map((i) => i.timestamp);
    expect([...times].sort().reverse()).toEqual(times);
    expect(page.nextCursor).toBeNull();
    // An admin may read it too.
    expect((await w.audit(w.A1.sess)).statusCode).toBe(200);
  });

  test('action filter returns only those events', async () => {
    const w = await world();
    await t.app.inject({
      method: 'PATCH',
      url: `/api/roadmaps/${w.roadmap._id}/members/${w.C1._id}`,
      headers: headers(w.O.sess),
      payload: { role: 'admin' },
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${w.roadmap._id}/invites`,
      headers: headers(w.O.sess),
      payload: { email: 'x@example.com', role: 'admin' },
    });
    const page = (await w.audit(w.O.sess, '?action=member.role_change')).json<Page>();
    expect(page.items.map((i) => i.action)).toEqual(['member.role_change']);
    const byActor = (await w.audit(w.O.sess, `?actorId=${w.O._id}`)).json<Page>();
    expect(byActor.items.length).toBeGreaterThan(0);
    expect(byActor.items.every((i) => i.actor.userId === w.O._id)).toBe(true);
  });

  test('a contributor gets 403', async () => {
    const w = await world();
    const res = await w.audit(w.C1.sess);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  test('the response never contains passwordHash, totp or tokenHash anywhere', async () => {
    const w = await world();
    await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${w.roadmap._id}/invites`,
      headers: headers(w.O.sess),
      payload: { email: 'leak@example.com', role: 'admin' },
    });
    // Even if a caller handed the log a secret, the stored entry has none.
    const res = await w.audit(w.O.sess);
    for (const key of ['passwordHash', 'totp', 'tokenHash', 'recoveryCodes', 'passkeys']) {
      expect(res.body).not.toContain(`"${key}"`);
    }
    expect(res.json<Page>().items.map((i) => i.action)).toContain('invite.create');
  });

  test('pages with a cursor; a bad cursor is 400 invalid_cursor', async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) {
      await t.app.inject({
        method: 'POST',
        url: `/api/roadmaps/${w.roadmap._id}/invites`,
        headers: headers(w.O.sess),
        payload: { email: `p${i}@example.com`, role: 'contributor' },
      });
    }
    const first = (await w.audit(w.O.sess, '?limit=2')).json<Page>();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await w.audit(w.O.sess, `?limit=2&cursor=${first.nextCursor}`)).json<Page>();
    expect(second.items).toHaveLength(2);
    expect(second.items[0]!.timestamp <= first.items[1]!.timestamp).toBe(true);
    const bad = await w.audit(w.O.sess, '?cursor=garbage');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_cursor' });
  });

  test('query parameters are validated', async () => {
    const w = await world();
    for (const q of ['?limit=0', '?limit=201', '?limit=abc', '?from=yesterday', '?to=2026-13-45', '?action=nope']) {
      const res = await w.audit(w.O.sess, q);
      expect(res.statusCode, q).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('validation');
    }
    const ok = await w.audit(w.O.sess, '?limit=200&from=2020-01-01&to=2099-01-01T00:00:00Z&action=roadmap.create');
    expect(ok.statusCode).toBe(200);
    const future = await w.audit(w.O.sess, '?from=2099-01-01');
    expect(future.json<Page>().items).toEqual([]);
  });

  test('a date-only `to` covers that whole day, and a full instant is taken as given', async () => {
    const w = await world();
    await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${w.roadmap._id}/invites`,
      headers: headers(w.O.sess),
      payload: { email: 'today@example.com', role: 'contributor' },
    });
    // The event's own day, so the test holds across midnight.
    const today = (await w.audit(w.O.sess, '?action=invite.create')).json<Page>().items[0]!.timestamp.slice(0, 10);
    const day = (await w.audit(w.O.sess, `?from=${today}&to=${today}&action=invite.create`)).json<Page>();
    expect(day.items).toHaveLength(1);
    const midnight = (await w.audit(w.O.sess, `?to=${today}T00:00:00Z&action=invite.create`)).json<Page>();
    expect(midnight.items).toEqual([]);
  });

  test('actors resolve in bulk: deleted users show name null, ai shows who it acted for, system has no name', async () => {
    const w = await world();
    const ghost = 'ghost-user';
    const base = { roadmapId: w.roadmap._id, target: { type: 'roadmap', id: w.roadmap._id }, ip: null };
    const now = Date.now();
    await s.audit.insertOne({ _id: 'e1', timestamp: new Date(now + 1000), action: 'roadmap.create', actor: { type: 'user', userId: ghost }, ...base });
    await s.audit.insertOne({ _id: 'e2', timestamp: new Date(now + 2000), action: 'roadmap.create', actor: { type: 'ai', onBehalfOf: w.A1._id }, ...base });
    await s.audit.insertOne({ _id: 'e3', timestamp: new Date(now + 3000), action: 'roadmap.create', actor: { type: 'system' }, ...base });
    const items = (await w.audit(w.O.sess, '?limit=3')).json<Page>().items;
    expect(items[0]!.actor).toEqual({ type: 'system' });
    expect(items[1]!.actor).toEqual({ type: 'ai', userId: w.A1._id, name: 'Adam Admin' });
    expect(items[2]!.actor).toEqual({ type: 'user', userId: ghost, name: null });
  });

  test('Tenant isolation: a roadmap from another tenant has no audit view (404)', async () => {
    const w = await world();
    const tb = (await t.seed.tenant('B'))._id;
    const ownerB = await t.seed.user(tb);
    await t.seed.roadmap(tb, ownerB._id);
    const sess = await signInAs(t.app, t.db, ownerB._id);
    expect((await w.audit(sess)).statusCode).toBe(404);
  });
});

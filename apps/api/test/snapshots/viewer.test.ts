import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { SnapshotContent, SnapshotNote } from '@roadmap/shared';
import {
  RENDER_HEADER,
  RENDER_TOKEN_MS,
  SNAPSHOT_COOKIE,
  createSnapshotSession,
  snapshotAccess,
} from '../../src/snapshots/access.ts';
import { assertNotLocked, createLockout, recordFailure, recordSuccess } from '../../src/auth/lockout.ts';
import { scoped } from '../../src/db/scoped.ts';
import type { AuditEventDoc, SnapshotDoc, UserDoc } from '../../src/db/types.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { PASSWORD, world } from './world.ts';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const WRONG = 'not the password at all';

let clock = new Date();
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

let t: TestApp;
let limited: TestApp;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
  limited = await makeTestApp({ env: { AUTH_RATE_LIMIT_PER_MIN: '3' } });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await limited?.close();
});
beforeEach(() => {
  clock = new Date();
});

let n = 0;
// A different address per call keeps the per-IP limit on unlocking out of the way of the other tests.
const ip = () => `10.3.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

type World = Awaited<ReturnType<typeof world>>;

/** Creates a snapshot as the Admin; fails the test on anything but 201. */
async function make(w: World, over: Record<string, unknown> = {}): Promise<{ id: string; linkId: string }> {
  const res = await w.create('A', { asOf: clock.toISOString().slice(0, 10), ...over });
  if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string; linkId: string }>();
}

const unlock = (linkId: string, password: string, app: TestApp = t, remoteAddress = ip()) =>
  app.app.inject({ method: 'POST', url: `/api/snapshots/${linkId}/unlock`, remoteAddress, payload: { password } });

/** The `__Secure-snap=…` header value from an unlock that succeeded. */
async function open(linkId: string, app: TestApp = t): Promise<string> {
  const res = await unlock(linkId, PASSWORD, app);
  if (res.statusCode !== 204) throw new Error(`unlock: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === SNAPSHOT_COOKIE);
  if (!c) throw new Error('unlock: no cookie');
  return `${SNAPSHOT_COOKIE}=${c.value}`;
}

const get = (url: string, cookie?: string, app: TestApp = t, headers: Record<string, string> = {}) =>
  app.app.inject({ method: 'GET', url, headers: { ...(cookie !== undefined && { cookie }), ...headers } });
const content = (linkId: string, cookie?: string, query = '') => get(`/api/snapshots/${linkId}/content${query}`, cookie);
const notesOf = (linkId: string, itemId: string, cookie?: string) =>
  get(`/api/snapshots/${linkId}/items/${itemId}/notes`, cookie);

const events = (app: TestApp, tenantId: string, action: string) =>
  app.db.collection<AuditEventDoc>('auditEvents').find({ tenantId, action }).toArray();
const stored = (id: string, app: TestApp = t) => app.db.collection<SnapshotDoc>('snapshots').findOne({ _id: id });

describe('unlocking', () => {
  test('FR-3.2: the right password opens the snapshot for 12 hours', async () => {
    const w = await world(t);
    await w.item();
    const { linkId } = await make(w);
    const res = await unlock(linkId, PASSWORD);
    expect(res.statusCode).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    const header = String(res.headers['set-cookie']);
    expect(header.startsWith(`${SNAPSHOT_COOKIE}=`)).toBe(true);
    const attrs = header.split(';').map((a) => a.trim());
    expect(attrs).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', `Path=/api/snapshots/${linkId}`, 'Max-Age=43200']),
    );
    const cookie = header.split(';')[0]!;

    const status = await get(`/api/snapshots/${linkId}`, cookie);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ unlocked: true });
    expect((await get(`/api/snapshots/${linkId}`)).json()).toEqual({ unlocked: false });

    const ok = await content(linkId, cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    advance(12 * HOUR - 1);
    expect((await content(linkId, cookie)).statusCode).toBe(200);
    advance(2);
    const late = await content(linkId, cookie);
    expect(late.statusCode).toBe(401);
    expect(late.json()).toEqual({ error: 'password_required' });
  });

  test('FR-3.2: without the cookie, content and notes answer 401 and say nothing about the roadmap', async () => {
    const w = await world(t);
    const item = await w.item({ title: 'Secret launch' });
    await w.note(item._id, w.ids.A, { body: 'Secret note' });
    const { linkId } = await make(w, { include: { notes: true, assignees: true } });
    // A signed-in member's own session makes no difference.
    const member = w.headers('A').cookie;
    for (const cookie of [undefined, member, `${SNAPSHOT_COOKIE}=not-a-token`]) {
      for (const res of [await content(linkId, cookie, '?notes=all'), await notesOf(linkId, item._id, cookie)]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'password_required' });
        expect(res.headers['cache-control']).toBe('no-store');
      }
    }
    const status = await get(`/api/snapshots/${linkId}`, member);
    expect(status.json()).toEqual({ unlocked: false });
    expect(status.body).not.toContain('Launch plan');
  });

  test('FR-3.2: an unknown link is 404 and an expired one is 410, with or without a session', async () => {
    const w = await world(t);
    for (const res of [
      await get('/api/snapshots/no-such-link-at-all-here'),
      await unlock('no-such-link-at-all-here', PASSWORD),
      await content('no-such-link-at-all-here'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }

    const { linkId } = await make(w, { expiresAt: new Date(clock.getTime() + HOUR).toISOString() });
    const cookie = await open(linkId);
    expect((await content(linkId, cookie)).statusCode).toBe(200);
    advance(HOUR);
    for (const res of [
      await get(`/api/snapshots/${linkId}`),
      await get(`/api/snapshots/${linkId}`, cookie),
      await unlock(linkId, PASSWORD),
      await content(linkId),
      await content(linkId, cookie),
    ]) {
      expect(res.statusCode).toBe(410);
      expect(res.json()).toEqual({ error: 'snapshot_expired' });
    }
  });

  test("FR-3.2: a revoked snapshot's session stops working", async () => {
    const w = await world(t);
    const { id, linkId } = await make(w);
    const cookie = await open(linkId);
    expect((await content(linkId, cookie)).statusCode).toBe(200);
    expect((await w.call('A', 'DELETE', `/snapshots/${id}`)).statusCode).toBe(204);
    for (const res of [await content(linkId, cookie), await get(`/api/snapshots/${linkId}`, cookie)]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  test('FR-3.2: a session for one snapshot does not open another', async () => {
    const w = await world(t);
    const a = await make(w, { name: 'A' });
    const b = await make(w, { name: 'B' });
    const cookieA = await open(a.linkId);
    expect((await content(a.linkId, cookieA)).statusCode).toBe(200);
    const res = await content(b.linkId, cookieA);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'password_required' });
  });

  test('FR-3.2: a render token opens one snapshot for 2 minutes, through its header', async () => {
    const w = await world(t);
    const a = await make(w, { name: 'A' });
    const b = await make(w, { name: 'B' });
    const token = await createSnapshotSession(scoped(t.db, w.tenantId), a.id, 'render', clock);
    const render = { [RENDER_HEADER]: token };

    expect((await get(`/api/snapshots/${a.linkId}/content`, undefined, t, render)).statusCode).toBe(200);
    expect((await get(`/api/snapshots/${b.linkId}/content`, undefined, t, render)).statusCode).toBe(401);
    // A render token is not a viewer cookie, and a viewer cookie's token is not a render token.
    expect((await content(a.linkId, `${SNAPSHOT_COOKIE}=${token}`)).statusCode).toBe(401);
    const viewer = (await open(a.linkId)).split('=')[1]!;
    expect((await get(`/api/snapshots/${a.linkId}/content`, undefined, t, { [RENDER_HEADER]: viewer })).statusCode).toBe(401);

    const req = (headers: Record<string, string>, cookies: Record<string, string> = {}) =>
      ({ params: { linkId: a.linkId }, headers, cookies }) as unknown as FastifyRequest;
    expect((await snapshotAccess(req(render), t.db, clock, { render: true })).via).toBe('render');
    // Where a render token is not accepted, it counts for nothing.
    await expect(snapshotAccess(req(render), t.db, clock)).rejects.toMatchObject({ status: 401 });
    const both = await snapshotAccess(req({}, { [SNAPSHOT_COOKIE]: viewer }), t.db, clock);
    expect(both).toMatchObject({ via: 'viewer', snapshot: { _id: a.id } });
    expect(both.db.tenantId).toBe(w.tenantId);

    advance(RENDER_TOKEN_MS);
    expect((await get(`/api/snapshots/${a.linkId}/content`, undefined, t, render)).statusCode).toBe(401);
  });

  test('FR-3.2: a successful unlock is recorded in the audit log, without the password or the link', async () => {
    const w = await world(t);
    const { id, linkId } = await make(w);
    const address = ip();
    expect((await unlock(linkId, PASSWORD, t, address)).statusCode).toBe(204);
    const [event, ...more] = await events(t, w.tenantId, 'snapshot.access');
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor: { type: 'system' },
      roadmapId: w.roadmap._id,
      target: { type: 'snapshot', id },
      ip: address,
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(linkId);
    const doc = (await stored(id))!;
    expect(doc).toMatchObject({ openCount: 1, lastOpenedAt: clock, failedUnlocks: 0 });
  });
});

describe('wrong passwords', () => {
  test('FR-3.6: the fifth wrong password locks the link for 15 minutes, and the right password is refused until then', async () => {
    const w = await world(t);
    const { id, linkId } = await make(w);
    for (let i = 0; i < 4; i++) {
      const res = await unlock(linkId, WRONG);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'wrong_password' });
    }
    const fifth = await unlock(linkId, WRONG);
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toEqual({ error: 'snapshot_locked' });
    const [locked, ...more] = await events(t, w.tenantId, 'snapshot.locked');
    expect(more).toEqual([]);
    expect(locked).toMatchObject({ actor: { type: 'system' }, target: { type: 'snapshot', id } });
    expect(JSON.stringify(locked)).not.toContain(linkId);

    advance(15 * MIN - SEC);
    const early = await unlock(linkId, PASSWORD);
    expect(early.statusCode).toBe(423);
    expect(early.json()).toEqual({ error: 'snapshot_locked' });
    expect(early.cookies).toEqual([]);
    advance(SEC);
    expect((await unlock(linkId, PASSWORD)).statusCode).toBe(204);
  });

  test('FR-3.6: twenty wrong passwords at once leave the link locked', { timeout: 60_000 }, async () => {
    const w = await world(t);
    const { id, linkId } = await make(w);
    const burst = await Promise.all(Array.from({ length: 20 }, () => unlock(linkId, WRONG)));
    for (const r of burst) expect([401, 423]).toContain(r.statusCode);
    expect((await stored(id))!.lockedUntil).not.toBeNull();
    const res = await unlock(linkId, PASSWORD);
    expect(res.statusCode).toBe(423);
    expect(res.cookies).toEqual([]);
  });

  test('FR-3.6: a right password resets the count', async () => {
    const w = await world(t);
    const { id, linkId } = await make(w);
    for (let i = 0; i < 4; i++) expect((await unlock(linkId, WRONG)).statusCode).toBe(401);
    expect((await unlock(linkId, PASSWORD)).statusCode).toBe(204);
    for (let i = 0; i < 4; i++) expect((await unlock(linkId, WRONG)).statusCode).toBe(401);
    expect((await stored(id))!).toMatchObject({ failedUnlocks: 4, lockedUntil: null });
    expect((await unlock(linkId, PASSWORD)).statusCode).toBe(204);
  });

  test('FR-3.6: the unlock route is rate-limited per IP', async () => {
    const w = await world(limited);
    const res = await w.create('A');
    const { linkId } = res.json<{ linkId: string }>();
    const address = '10.9.9.9';
    const first = await unlock(linkId, PASSWORD, limited, address);
    expect(first.statusCode).toBe(204);
    const cookie = `${SNAPSHOT_COOKIE}=${first.cookies.find((c) => c.name === SNAPSHOT_COOKIE)!.value}`;
    expect((await unlock(linkId, WRONG, limited, address)).statusCode).toBe(401);
    expect((await unlock(linkId, WRONG, limited, address)).statusCode).toBe(401);
    const fourth = await unlock(linkId, PASSWORD, limited, address);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toEqual({ error: 'rate_limited' });
    for (let i = 0; i < 5; i++) {
      const got = await limited.app.inject({
        method: 'GET',
        url: `/api/snapshots/${linkId}/content`,
        remoteAddress: address,
        headers: { cookie },
      });
      expect(got.statusCode).toBe(200);
    }
  });
});

describe('content', () => {
  test("FR-3.3: content has the roadmap's name, the as-of date and every frozen item in order", async () => {
    const w = await world(t);
    const p = await w.item({ title: 'Platform', status: 'in_progress', startDate: '2026-01-05', endDate: '2026-03-01' });
    const q = await w.item({ title: 'Quality' });
    const c1 = await w.item({ parentId: p._id, title: 'Child one' });
    const c2 = await w.item({ parentId: p._id, title: 'Child two' });
    await w.item({ title: 'Old', archived: true });
    const { linkId } = await make(w, { asOf: '2026-01-15' });
    const res = await content(linkId, await open(linkId), '?notes=all');
    expect(res.statusCode).toBe(200);
    const body = res.json<SnapshotContent>();
    expect(body).toMatchObject({ roadmapName: 'Launch plan', asOf: '2026-01-15', include: { notes: false, assignees: false } });
    expect(Number.isNaN(Date.parse(body.frozenAt))).toBe(false);
    expect(body.items.map((i) => i.id)).toEqual([p._id, q._id, c1._id, c2._id]);
    expect(body.items[0]).toEqual({
      id: p._id,
      parentId: null,
      depth: 1,
      title: 'Platform',
      description: '',
      status: 'in_progress',
      startDate: '2026-01-05',
      endDate: '2026-03-01',
      milestones: [],
      tags: [],
      links: [],
      blockedBy: [],
      priorityLabel: null,
      rank: 0,
    });
    expect(body.items[2]).toMatchObject({ parentId: p._id, depth: 2 });
    expect(body).not.toHaveProperty('notes');
  });

  test('FR-3.5: content and the notes route give no notes when the snapshot has none, even with ?notes=all', async () => {
    const w = await world(t);
    const item = await w.item();
    await w.note(item._id, w.ids.A, { body: 'Not copied' });
    const { linkId } = await make(w);
    const cookie = await open(linkId);
    const res = await content(linkId, cookie, '?notes=all');
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('notes');
    expect(res.body).not.toContain('Not copied');
    const notes = await notesOf(linkId, item._id, cookie);
    expect(notes.statusCode).toBe(404);
    expect(notes.json()).toEqual({ error: 'not_found' });
  });

  test('FR-3.5: an item\'s notes come oldest first with author names and no ids of people', async () => {
    const w = await world(t);
    const item = await w.item();
    const other = await w.item({ title: 'Other' });
    const later = await w.note(item._id, w.ids.C, {
      body: 'Later',
      createdAt: new Date('2026-02-02T00:00:00Z'),
      mentions: [{ userId: w.ids.O, name: 'Olive Owner' }],
    });
    const first = await w.note(item._id, w.ids.A, { body: 'First', createdAt: new Date('2026-02-01T00:00:00Z') });
    await w.note(item._id, w.ids.O, { body: 'Reply', parentId: first._id, createdAt: new Date('2026-02-03T00:00:00Z') });
    await w.note(other._id, w.ids.A, { body: 'Elsewhere' });
    const { linkId } = await make(w, { include: { notes: true, assignees: true } });
    const cookie = await open(linkId);

    const res = await notesOf(linkId, item._id, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const notes = res.json<{ notes: SnapshotNote[] }>().notes;
    expect(notes.map((x) => [x.body, x.authorName])).toEqual([
      ['First', 'Ann Admin'],
      ['Later', 'Cal Contributor'],
      ['Reply', 'Olive Owner'],
    ]);
    expect(notes[0]).toEqual({
      id: first._id,
      itemId: item._id,
      parentId: null,
      authorName: 'Ann Admin',
      body: 'First',
      mentions: [],
      createdAt: '2026-02-01T00:00:00.000Z',
      edited: false,
      deleted: false,
    });
    expect(notes[1]).toMatchObject({ id: later._id, mentions: ['Olive Owner'] });
    expect(notes[2]).toMatchObject({ parentId: first._id });
    for (const id of Object.values(w.ids)) expect(res.body).not.toContain(id);

    const all = await content(linkId, cookie, '?notes=all');
    const body = all.json<SnapshotContent>();
    expect(body.notes?.map((x) => x.body).sort()).toEqual(['Elsewhere', 'First', 'Later', 'Reply']);
    for (const id of Object.values(w.ids)) expect(all.body).not.toContain(id);
    expect(body.items.find((i) => i.id === item._id)).toMatchObject({ noteCount: 3, assignees: [] });
    expect((await content(linkId, cookie)).json()).not.toHaveProperty('notes');

    const missing = await notesOf(linkId, 'no-such-item', cookie);
    expect(missing.statusCode).toBe(404);
  });
});

describe('Tenant isolation', () => {
  test('Tenant isolation: a snapshot in another tenant is reached only through its own link, and its rows are never read through another link', async () => {
    const w1 = await world(t);
    const w2 = await world(t);
    const i1 = await w1.item({ title: 'Tenant one item' });
    const i2 = await w2.item({ title: 'Tenant two item' });
    await w1.note(i1._id, w1.ids.A, { body: 'Tenant one note' });
    await w2.note(i2._id, w2.ids.A, { body: 'Tenant two note' });
    const s1 = await make(w1, { include: { notes: true, assignees: false } });
    const s2 = await make(w2, { include: { notes: true, assignees: false } });
    const c1 = await open(s1.linkId);
    const c2 = await open(s2.linkId);

    const one = await content(s1.linkId, c1, '?notes=all');
    expect(one.json<SnapshotContent>().items.map((i) => i.title)).toEqual(['Tenant one item']);
    expect(one.body).not.toContain('Tenant two');
    const two = await content(s2.linkId, c2, '?notes=all');
    expect(two.json<SnapshotContent>().items.map((i) => i.title)).toEqual(['Tenant two item']);
    expect(two.body).not.toContain('Tenant one');

    // One tenant's session and item ids lead nowhere through the other tenant's link.
    expect((await content(s2.linkId, c1)).statusCode).toBe(401);
    expect((await notesOf(s2.linkId, i1._id, c2)).statusCode).toBe(404);
    expect((await notesOf(s1.linkId, i2._id, c1)).statusCode).toBe(404);
    expect((await events(t, w1.tenantId, 'snapshot.access')).map((e) => e.target.id)).toEqual([s1.id]);
    expect((await events(t, w2.tenantId, 'snapshot.access')).map((e) => e.target.id)).toEqual([s2.id]);
  });
});

describe('sign-in lockout', () => {
  test('FR-3.6: sign-in lockout still behaves as before', async () => {
    // The sign-in tests in test/auth pass unchanged; this checks the shared algorithm keeps the users' fields.
    const users = createLockout('users', 'failedLogins');
    const s = scoped(t.db, (await t.seed.tenant())._id);
    const u = await t.seed.user(s.tenantId);
    const user = async () => (await t.db.collection<UserDoc>('users').findOne({ _id: u._id }))!;
    for (let i = 0; i < 4; i++) expect(await users.recordFailure(s, u._id, clock)).toEqual({ lockedNow: false });
    expect(await users.recordFailure(s, u._id, clock)).toEqual({ lockedNow: true });
    expect(await user()).toMatchObject({ failedLogins: 0, lockedUntil: new Date(clock.getTime() + 15 * MIN) });
    expect(await assertNotLocked(s, u._id, clock)).toBe(false);
    await recordSuccess(s, u._id);
    expect(await users.assertNotLocked(s, u._id, clock)).toBe(true);
    expect(await recordFailure(s, u._id, clock)).toBeUndefined();
    expect(await user()).toMatchObject({ failedLogins: 1, lockedUntil: null });
  });
});

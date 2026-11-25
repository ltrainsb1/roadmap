import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_PREFS, type NotificationPage, type PrefsResponse } from '@roadmap/shared';
import type { AuditEventDoc, NotificationDoc, ProjectDoc, RoadmapDoc, UserDoc } from '../../src/db/types.ts';
import { runPass } from '../../src/worker/run.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';
import { workerDeps } from '../worker/fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

type Session = { cookie: string; csrf: string };

const base = new Date('2026-06-01T12:00:00Z');

/** A roadmap "Launch" owned by Olive, with Cal as a contributor; both signed in. */
async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const olive = await t.seed.user(tenantId);
  const cal = await t.seed.user(tenantId);
  await t.db.collection<UserDoc>('users').updateOne({ _id: olive._id }, { $set: { name: 'Olive' } });
  await t.db.collection<UserDoc>('users').updateOne({ _id: cal._id }, { $set: { name: 'Cal' } });
  const roadmap = await t.seed.roadmap(tenantId, olive._id, 'Launch');
  await t.seed.member(tenantId, roadmap._id, cal._id, 'contributor');
  const project = await t.seed.project(tenantId, roadmap._id, { title: 'Item' });
  const sess = { olive: await signInAs(t.app, t.db, olive._id), cal: await signInAs(t.app, t.db, cal._id) };
  return { tenantId, olive, cal, roadmap, project, sess };
}

type World = Awaited<ReturnType<typeof world>>;

/** A row for `userId`, inserted straight into the collection. */
async function row(
  w: Pick<World, 'tenantId' | 'roadmap' | 'project'>,
  userId: string,
  o: { createdAt?: Date; actorId?: string | null; roadmapId?: string; readAt?: Date | null; _id?: string } = {},
): Promise<string> {
  const _id = o._id ?? uuidv7();
  const createdAt = o.createdAt ?? base;
  await t.db.collection<NotificationDoc>('notifications').insertOne({
    _id,
    tenantId: w.tenantId,
    roadmapId: o.roadmapId ?? w.roadmap._id,
    userId,
    type: 'assigned',
    actorId: o.actorId === undefined ? null : o.actorId,
    projectId: w.project._id,
    projectTitle: 'Item',
    detail: { kind: 'assigned' },
    createdAt,
    readAt: o.readAt ?? null,
    email: { state: 'pending', attempts: 0, nextAttemptAt: createdAt, leaseUntil: null, sentAt: null },
  });
  return _id;
}

const get = (sess: Session, url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: sess.cookie } });
const post = (sess: Session, url: string, csrf = true) =>
  t.app.inject({
    method: 'POST',
    url,
    headers: { cookie: sess.cookie, ...(csrf && { 'x-csrf-token': sess.csrf }) },
  });
const putPrefs = (sess: Session, payload: Record<string, unknown>) =>
  t.app.inject({
    method: 'PUT',
    url: '/api/me/notification-prefs',
    headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
    payload,
  });
const page = async (sess: Session, query = ''): Promise<NotificationPage> => {
  const res = await get(sess, `/api/notifications${query}`);
  expect(res.statusCode).toBe(200);
  return res.json<NotificationPage>();
};
const unread = async (sess: Session): Promise<number> => {
  const res = await get(sess, '/api/notifications/unread-count');
  expect(res.statusCode).toBe(200);
  return res.json<{ unread: number }>().unread;
};

describe('notification list', () => {
  test('FR-5.3: the list is newest first, 30 at a time, and the cursor continues where it stopped with nothing repeated or skipped', async () => {
    const w = await world();
    const ids: string[] = [];
    // 65 rows a second apart, except rows 29 and 30 (the first page's boundary), which share a timestamp. Their ids are
    // fixed, so the tie is broken the same way every run: 29's id is the larger, so it ends page one.
    const tied: Record<number, string> = {
      29: '00000000-0000-7000-8000-000000000002',
      30: '00000000-0000-7000-8000-000000000001',
    };
    for (let i = 0; i < 65; i++) {
      const createdAt = new Date(base.getTime() - (i === 30 ? 29 : i) * 1000);
      ids.push(await row(w, w.cal._id, { createdAt, ...(tied[i] !== undefined && { _id: tied[i] }) }));
    }
    // A row of Olive's never shows in Cal's list.
    await row(w, w.olive._id);

    const seen: NotificationPage['items'] = [];
    const first = await page(w.sess.cal);
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    seen.push(...first.items);
    expect(first.items[29]!.id).toBe(tied[29]);
    const second = await page(w.sess.cal, `?cursor=${first.nextCursor!}`);
    expect(second.items).toHaveLength(30);
    expect(second.items[0]!.id).toBe(tied[30]);
    seen.push(...second.items);
    const third = await page(w.sess.cal, `?cursor=${second.nextCursor!}`);
    expect(third.items).toHaveLength(5);
    expect(third.nextCursor).toBeNull();
    seen.push(...third.items);

    const seenIds = seen.map((n) => n.id);
    expect(new Set(seenIds).size).toBe(65);
    expect(new Set(seenIds)).toEqual(new Set(ids));
    // Newest first, ties broken by id (newest id first).
    for (let i = 1; i < seen.length; i++) {
      const [a, b] = [seen[i - 1]!, seen[i]!];
      expect(a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)).toBe(true);
    }
    expect(first.unread).toBe(65);

    const small = await page(w.sess.cal, '?limit=50');
    expect(small.items).toHaveLength(50);
    expect((await get(w.sess.cal, '/api/notifications?limit=51')).statusCode).toBe(400);
    expect((await get(w.sess.cal, '/api/notifications?limit=0')).statusCode).toBe(400);
  });

  test('FR-5.3: the unread count and the list\'s unread figure agree, and marking one or all as read lowers them', async () => {
    const w = await world();
    const a = await row(w, w.cal._id, { createdAt: new Date(base.getTime() - 3000) });
    await row(w, w.cal._id, { createdAt: new Date(base.getTime() - 2000) });
    await row(w, w.cal._id, { createdAt: new Date(base.getTime() - 1000) });
    // A row for a roadmap Cal does not belong to: neither listed nor counted.
    const other = await t.seed.roadmap(w.tenantId, w.olive._id, 'Other');
    await row(w, w.cal._id, { roadmapId: other._id });

    expect(await unread(w.sess.cal)).toBe(3);
    const p = await page(w.sess.cal);
    expect(p.items).toHaveLength(3);
    expect(p.unread).toBe(3);
    expect(p.items.every((n) => !n.read)).toBe(true);

    expect((await post(w.sess.cal, `/api/notifications/${a}/read`)).statusCode).toBe(204);
    expect(await unread(w.sess.cal)).toBe(2);
    const after = await page(w.sess.cal);
    expect(after.unread).toBe(2);
    expect(after.items.find((n) => n.id === a)!.read).toBe(true);
    // Marking it again is fine and keeps the first read time.
    const firstReadAt = (await t.db.collection<NotificationDoc>('notifications').findOne({ _id: a }))!.readAt;
    expect((await post(w.sess.cal, `/api/notifications/${a}/read`)).statusCode).toBe(204);
    expect((await t.db.collection<NotificationDoc>('notifications').findOne({ _id: a }))!.readAt).toEqual(firstReadAt);

    // Without the CSRF header both marks are refused.
    const b = p.items.find((n) => n.id !== a)!.id;
    expect((await post(w.sess.cal, `/api/notifications/${b}/read`, false)).statusCode).toBe(403);
    expect((await post(w.sess.cal, '/api/notifications/read-all', false)).statusCode).toBe(403);
    expect(await unread(w.sess.cal)).toBe(2);

    expect((await post(w.sess.cal, '/api/notifications/read-all')).statusCode).toBe(204);
    expect(await unread(w.sess.cal)).toBe(0);
    const all = await page(w.sess.cal);
    expect(all.unread).toBe(0);
    expect(all.items.every((n) => n.read)).toBe(true);
  });

  test('FR-5.3: a roadmap\'s current name and an actor\'s current name are shown; a deleted actor is null', async () => {
    const w = await world();
    const ann = await t.seed.user(w.tenantId);
    await t.db.collection<UserDoc>('users').updateOne({ _id: ann._id }, { $set: { name: 'Ann' } });
    // A real assignment writes Cal a row with Olive as the actor.
    const assigned = await t.app.inject({
      method: 'PUT',
      url: `/api/roadmaps/${w.roadmap._id}/projects/${w.project._id}/assignees`,
      headers: { cookie: w.sess.olive.cookie, 'x-csrf-token': w.sess.olive.csrf },
      payload: { userIds: [w.cal._id] },
    });
    expect(assigned.statusCode).toBeLessThan(300);
    const byAnn = await row(w, w.cal._id, { actorId: ann._id, createdAt: new Date(base.getTime() - 1000) });
    const noActor = await row(w, w.cal._id, { actorId: null, createdAt: new Date(base.getTime() - 2000) });

    await t.db.collection<UserDoc>('users').updateOne({ _id: w.olive._id }, { $set: { name: 'Olive Renamed' } });
    await t.db.collection<RoadmapDoc>('roadmaps').updateOne({ _id: w.roadmap._id }, { $set: { name: 'Launch 2' } });
    await t.db.collection<UserDoc>('users').deleteOne({ _id: ann._id });

    const items = (await page(w.sess.cal)).items;
    expect(items).toHaveLength(3);
    const byOlive = items.find((n) => n.id !== byAnn && n.id !== noActor)!;
    expect(byOlive).toMatchObject({
      type: 'assigned',
      roadmapId: w.roadmap._id,
      roadmapName: 'Launch 2',
      projectId: w.project._id,
      projectTitle: 'Item',
      actorName: 'Olive Renamed',
      hasActor: true,
      detail: { kind: 'assigned' },
      read: false,
    });
    expect(items.find((n) => n.id === byAnn)).toMatchObject({ actorName: null, hasActor: true, roadmapName: 'Launch 2' });
    expect(items.find((n) => n.id === noActor)).toMatchObject({ actorName: null, hasActor: false });
  });

  test('FR-5.3: the list leaves out rows whose item or roadmap has just gone', async () => {
    const w = await world();
    const kept = await row(w, w.cal._id, { createdAt: new Date(base.getTime() - 1000) });
    // A row whose item was deleted a moment ago (a due-soon reminder written just after the delete).
    const goneItem = await t.seed.project(w.tenantId, w.roadmap._id, { title: 'Gone' });
    await row({ ...w, project: goneItem }, w.cal._id, { createdAt: new Date(base.getTime() - 2000) });
    await t.db.collection<ProjectDoc>('projects').deleteOne({ _id: goneItem._id });
    // A row on a roadmap deleted during the request: its cascade has not reached the row or the membership yet.
    const vanishing = await t.seed.roadmap(w.tenantId, w.olive._id, 'Vanishing');
    await t.seed.member(w.tenantId, vanishing._id, w.cal._id, 'contributor');
    await row(w, w.cal._id, { roadmapId: vanishing._id, createdAt: new Date(base.getTime() - 3000) });
    await t.db.collection<RoadmapDoc>('roadmaps').deleteOne({ _id: vanishing._id });

    const p = await page(w.sess.cal);
    expect(p.items.map((n) => n.id)).toEqual([kept]);
    expect(p.items.every((n) => n.roadmapName !== '')).toBe(true);
  });

  test('FR-5.3: after one worker pass, the unread count matches the list again when a row\'s item has gone', async () => {
    const w = await world();
    // Emails for these are off: the row still goes.
    await t.db.collection<UserDoc>('users').updateOne({ _id: w.cal._id }, { $set: { notificationPrefs: { assigned: 'off' } } });
    await row(w, w.cal._id, { createdAt: new Date(base.getTime() - 1000) });
    const goneItem = await t.seed.project(w.tenantId, w.roadmap._id, { title: 'Gone' });
    await row({ ...w, project: goneItem }, w.cal._id, { createdAt: new Date(base.getTime() - 2000) });
    await t.db.collection<ProjectDoc>('projects').deleteOne({ _id: goneItem._id });
    // Between the delete and the next pass, the list's own filter hides the row.
    expect((await page(w.sess.cal)).items).toHaveLength(1);

    await runPass(workerDeps(t, { now: () => base }));
    const p = await page(w.sess.cal);
    expect(p.items).toHaveLength(1);
    expect(p.unread).toBe(1);
    expect(await unread(w.sess.cal)).toBe(1);
  });

  test('FR-5.3: someone else\'s notification id, a made-up id and a cursor from another person\'s list change and reveal nothing', async () => {
    const w = await world();
    const olives: string[] = [];
    for (let i = 0; i < 31; i++) olives.push(await row(w, w.olive._id, { createdAt: new Date(base.getTime() - i * 1000) }));

    // Cal cannot mark Olive's row read, and a made-up id is the same 404.
    const theirs = await post(w.sess.cal, `/api/notifications/${olives[0]!}/read`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual({ error: 'not_found' });
    expect((await post(w.sess.cal, `/api/notifications/${uuidv7()}/read`)).statusCode).toBe(404);
    expect((await post(w.sess.cal, '/api/notifications/read-all')).statusCode).toBe(204);
    expect(await unread(w.sess.olive)).toBe(31);

    // Olive's cursor shows Cal nothing of Olive's.
    const cursor = (await page(w.sess.olive)).nextCursor!;
    expect(await page(w.sess.cal, `?cursor=${cursor}`)).toEqual({ items: [], nextCursor: null, unread: 0 });

    // Cursors that don't decode are 400.
    for (const bad of ['not-a-cursor', Buffer.from('2026-01-01T00:00:00Z').toString('base64url'), Buffer.from('nope|x').toString('base64url')]) {
      const res = await get(w.sess.cal, `/api/notifications?cursor=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'bad_cursor' });
    }
  });
});

describe('notification preferences', () => {
  test('FR-5.2: preferences start at the defaults, save, and come back as saved; an unknown mode is 400', async () => {
    const w = await world();
    await t.db.collection<UserDoc>('users').updateOne({ _id: w.cal._id }, { $set: { timezone: 'Europe/London' } });
    const first = await get(w.sess.cal, '/api/me/notification-prefs');
    expect(first.statusCode).toBe(200);
    expect(first.json<PrefsResponse>()).toEqual({ prefs: DEFAULT_PREFS, timezone: 'Europe/London', emailBlocked: null });

    // Stored values win over the defaults, even when only some are stored.
    await t.db.collection<UserDoc>('users').updateOne({ _id: w.cal._id }, { $set: { notificationPrefs: { due_soon: 'off' } } });
    expect((await get(w.sess.cal, '/api/me/notification-prefs')).json<PrefsResponse>().prefs).toEqual({
      ...DEFAULT_PREFS,
      due_soon: 'off',
    });

    const next = { assigned: 'digest', mentioned: 'off', dates_changed: 'instant', due_soon: 'digest' } as const;
    const saved = await putPrefs(w.sess.cal, next);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PrefsResponse>()).toEqual({ prefs: next, timezone: 'Europe/London', emailBlocked: null });
    expect((await get(w.sess.cal, '/api/me/notification-prefs')).json<PrefsResponse>().prefs).toEqual(next);
    // Olive's are untouched.
    expect((await get(w.sess.olive, '/api/me/notification-prefs')).json<PrefsResponse>().prefs).toEqual(DEFAULT_PREFS);

    expect((await putPrefs(w.sess.cal, { ...next, assigned: 'weekly' })).statusCode).toBe(400);
    expect((await putPrefs(w.sess.cal, { assigned: 'off' })).statusCode).toBe(400);
    const noCsrf = await t.app.inject({
      method: 'PUT',
      url: '/api/me/notification-prefs',
      headers: { cookie: w.sess.cal.cookie },
      payload: DEFAULT_PREFS,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await get(w.sess.cal, '/api/me/notification-prefs')).json<PrefsResponse>().prefs).toEqual(next);
    expect((await t.app.inject({ method: 'GET', url: '/api/me/notification-prefs' })).statusCode).toBe(401);
  });

  test('FR-5.2: changing preferences writes an audit event with before and after', async () => {
    const w = await world();
    const next = { ...DEFAULT_PREFS, mentioned: 'off' } as const;
    expect((await putPrefs(w.sess.cal, next)).statusCode).toBe(200);
    const events = await t.db
      .collection<AuditEventDoc>('auditEvents')
      .find({ tenantId: w.tenantId, action: 'user.notification_prefs' })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: 'user', userId: w.cal._id },
      target: { type: 'user', id: w.cal._id },
      before: { prefs: DEFAULT_PREFS },
      after: { prefs: next },
    });
    expect(events[0]!.roadmapId).toBeUndefined();
  });
});

describe('tenant isolation', () => {
  test('Tenant isolation: another tenant\'s member sees none of these notifications and can\'t mark them read', async () => {
    const w = await world();
    const id = await row(w, w.cal._id);
    const tb = (await t.seed.tenant('B'))._id;
    const ownerB = await t.seed.user(tb);
    const roadmapB = await t.seed.roadmap(tb, ownerB._id);
    // A row in tenant B that happens to name Cal's user id is not Cal's either.
    const projectB = await t.seed.project(tb, roadmapB._id);
    await row({ tenantId: tb, roadmap: roadmapB, project: projectB }, w.cal._id);
    const sessB = await signInAs(t.app, t.db, ownerB._id);

    expect(await page(sessB)).toEqual({ items: [], nextCursor: null, unread: 0 });
    expect(await unread(sessB)).toBe(0);
    expect((await post(sessB, `/api/notifications/${id}/read`)).statusCode).toBe(404);
    expect((await post(sessB, '/api/notifications/read-all')).statusCode).toBe(204);
    const cal = await page(w.sess.cal);
    expect(cal.items.map((n) => n.id)).toEqual([id]);
    expect(cal.unread).toBe(1);
  });
});

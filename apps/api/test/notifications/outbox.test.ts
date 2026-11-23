import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { NotificationDoc, UserDoc } from '../../src/db/types.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

type Who = 'O' | 'A' | 'C' | 'D';

/** A roadmap with owner O (Olive), admin A (Ann), contributors C (Cal) and D (Dee), and outsider X (same tenant). */
async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const users = {
    O: await t.seed.user(tenantId),
    A: await t.seed.user(tenantId),
    C: await t.seed.user(tenantId),
    D: await t.seed.user(tenantId),
  };
  const X = await t.seed.user(tenantId);
  const names: Record<Who, string> = { O: 'Olive', A: 'Ann', C: 'Cal', D: 'Dee' };
  for (const who of Object.keys(users) as Who[]) {
    await t.db.collection<UserDoc>('users').updateOne({ _id: users[who]._id }, { $set: { name: names[who] } });
  }
  const roadmap = await t.seed.roadmap(tenantId, users.O._id, 'Launch');
  await t.seed.member(tenantId, roadmap._id, users.A._id, 'admin');
  await t.seed.member(tenantId, roadmap._id, users.C._id, 'contributor');
  await t.seed.member(tenantId, roadmap._id, users.D._id, 'contributor');
  const sess = {
    O: await signInAs(t.app, t.db, users.O._id),
    A: await signInAs(t.app, t.db, users.A._id),
    C: await signInAs(t.app, t.db, users.C._id),
    D: await signInAs(t.app, t.db, users.D._id),
  };
  const ids = { O: users.O._id, A: users.A._id, C: users.C._id, D: users.D._id, X: X._id };
  const send = (who: Who, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      ...(payload ? { payload } : {}),
    });
  const itemUrl = (projectId: string) => `/api/roadmaps/${roadmap._id}/projects/${projectId}`;
  const assign = (who: Who, projectId: string, userIds: string[]) =>
    send(who, 'PUT', `${itemUrl(projectId)}/assignees`, { userIds });
  const edit = (who: Who, projectId: string, payload: Record<string, unknown>) =>
    send(who, 'PATCH', itemUrl(projectId), payload);
  const addNote = (who: Who, projectId: string, payload: Record<string, unknown>) =>
    send(who, 'POST', `${itemUrl(projectId)}/notes`, payload);
  const editNote = (who: Who, projectId: string, noteId: string, payload: Record<string, unknown>) =>
    send(who, 'PATCH', `${itemUrl(projectId)}/notes/${noteId}`, payload);
  const item = (o: Parameters<TestApp['seed']['project']>[2] = {}) => t.seed.project(tenantId, roadmap._id, o);
  const rows = (filter: Record<string, unknown> = {}) =>
    t.db
      .collection<NotificationDoc>('notifications')
      .find({ tenantId, ...filter }, { sort: { _id: 1 } })
      .toArray();
  return { tenantId, ids, roadmap, send, itemUrl, assign, edit, addNote, editNote, item, rows };
}

const now = new Date('2026-01-01T00:00:00Z');
/** A row inserted straight into the collection, for the deletion tests. */
async function seedRow(tenantId: string, roadmapId: string, projectId: string, userId: string): Promise<string> {
  const _id = uuidv7();
  await t.db.collection<NotificationDoc>('notifications').insertOne({
    _id,
    tenantId,
    roadmapId,
    userId,
    type: 'assigned',
    actorId: null,
    projectId,
    projectTitle: 'Item',
    detail: { kind: 'assigned' },
    createdAt: now,
    readAt: null,
    email: { state: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null, sentAt: null },
  });
  return _id;
}

describe('assigned', () => {
  test('FR-5.1: assigning two people writes one "assigned" row each, and none for the actor who assigned themselves', async () => {
    const w = await world();
    const item = await w.item({ title: 'Billing' });
    const res = await w.assign('A', item._id, [w.ids.A, w.ids.C, w.ids.D]);
    expect(res.statusCode).toBe(200);
    const rows = await w.rows();
    expect(rows.map((r) => r.userId).sort()).toEqual([w.ids.C, w.ids.D].sort());
    for (const r of rows) {
      expect(r).toMatchObject({
        tenantId: w.tenantId,
        roadmapId: w.roadmap._id,
        type: 'assigned',
        actorId: w.ids.A,
        projectId: item._id,
        projectTitle: 'Billing',
        detail: { kind: 'assigned' },
        readAt: null,
        email: { state: 'pending', attempts: 0, leaseUntil: null, sentAt: null },
      });
      expect(r.email.nextAttemptAt).toEqual(r.createdAt);
      expect(r.dedupeKey).toBeUndefined();
    }
  });

  test('FR-5.1: removing an assignee writes nothing, and re-saving the same assignees writes nothing', async () => {
    const w = await world();
    const item = await w.item({ assigneeIds: [w.ids.C, w.ids.D] });
    expect((await w.assign('A', item._id, [w.ids.C])).statusCode).toBe(200);
    expect((await w.assign('A', item._id, [w.ids.C])).statusCode).toBe(200);
    expect(await w.rows()).toEqual([]);
    // Adding one back to a list with someone already on it notifies only the one added.
    expect((await w.assign('A', item._id, [w.ids.D, w.ids.C])).statusCode).toBe(200);
    expect((await w.rows()).map((r) => r.userId)).toEqual([w.ids.D]);
  });
});

describe('dates changed', () => {
  test("FR-5.1: changing an item's end date notifies its assignees with the old and new dates, but not the person who changed it", async () => {
    const w = await world();
    const item = await w.item({ startDate: '2026-03-01', endDate: '2026-03-31', assigneeIds: [w.ids.C, w.ids.D] });
    const res = await w.edit('C', item._id, { version: 1, endDate: '2026-04-15', title: 'Billing v2' });
    expect(res.statusCode).toBe(200);
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: w.ids.D,
      type: 'dates_changed',
      actorId: w.ids.C,
      projectId: item._id,
      projectTitle: 'Billing v2',
      detail: {
        kind: 'dates',
        before: { startDate: '2026-03-01', endDate: '2026-03-31' },
        after: { startDate: '2026-03-01', endDate: '2026-04-15' },
      },
    });
  });

  test('FR-5.1: adding, moving and removing milestones writes one row each; renaming one writes none; changing the title writes none', async () => {
    const w = await world();
    const item = await w.item({ assigneeIds: [w.ids.D] });
    // D is assigned and O is not, so adding two milestones writes two rows for D.
    const first = await w.edit('O', item._id, {
      version: 1,
      milestones: [
        { name: 'Beta', date: '2026-02-01' },
        { name: 'GA', date: '2026-03-01' },
      ],
    });
    expect(first.statusCode).toBe(200);
    const [beta, ga] = first.json<{ milestones: Array<{ id: string; name: string; date: string }> }>().milestones;
    expect((await w.rows()).map((r) => r.detail)).toEqual([
      { kind: 'milestone', change: 'added', name: 'Beta', date: '2026-02-01' },
      { kind: 'milestone', change: 'added', name: 'GA', date: '2026-03-01' },
    ]);
    await t.db.collection('notifications').deleteMany({ tenantId: w.tenantId });

    // Rename Beta, move GA, add RC, and change the title: one "moved" and one "added".
    const second = await w.edit('O', item._id, {
      version: 2,
      title: 'Renamed',
      milestones: [
        { id: beta!.id, name: 'Beta 1', date: '2026-02-01' },
        { id: ga!.id, name: 'GA', date: '2026-03-15' },
        { name: 'RC', date: '2026-03-08' },
      ],
    });
    expect(second.statusCode).toBe(200);
    expect((await w.rows()).map((r) => r.detail)).toEqual([
      { kind: 'milestone', change: 'moved', name: 'GA', date: '2026-03-15' },
      { kind: 'milestone', change: 'added', name: 'RC', date: '2026-03-08' },
    ]);
    await t.db.collection('notifications').deleteMany({ tenantId: w.tenantId });

    // Remove Beta 1: one "removed", with the date it had.
    const third = await w.edit('O', item._id, {
      version: 3,
      milestones: second
        .json<{ milestones: Array<{ id: string; name: string; date: string }> }>()
        .milestones.filter((m) => m.id !== beta!.id),
    });
    expect(third.statusCode).toBe(200);
    expect((await w.rows()).map((r) => [r.userId, r.type, r.detail])).toEqual([
      [w.ids.D, 'dates_changed', { kind: 'milestone', change: 'removed', name: 'Beta 1', date: '2026-02-01' }],
    ]);
    await t.db.collection('notifications').deleteMany({ tenantId: w.tenantId });

    // Rename only, and title only: nothing.
    const milestones = third.json<{ milestones: Array<{ id: string; name: string; date: string }> }>().milestones;
    const renamed = milestones.map((m) => ({ ...m, name: `${m.name}!` }));
    expect((await w.edit('O', item._id, { version: 4, milestones: renamed })).statusCode).toBe(200);
    expect((await w.edit('O', item._id, { version: 5, title: 'Again', description: 'x' })).statusCode).toBe(200);
    expect(await w.rows()).toEqual([]);
  });
});

describe('mentioned', () => {
  test('FR-5.1: a note that mentions two members writes one "mentioned" row each, with a 200-character plain excerpt; mentioning yourself writes none', async () => {
    const w = await world();
    const item = await w.item({ title: 'Billing' });
    const body = `@Ann and @Dee and @Cal\nplease look **here**:\n${'x'.repeat(300)}`;
    const res = await w.addNote('C', item._id, { body, mentionIds: [w.ids.A, w.ids.D, w.ids.C, w.ids.X] });
    expect(res.statusCode).toBe(201);
    const rows = await w.rows();
    expect(rows.map((r) => r.userId).sort()).toEqual([w.ids.A, w.ids.D].sort());
    const excerpt = `@Ann and @Dee and @Cal please look **here**: ${'x'.repeat(300)}`.slice(0, 200);
    for (const r of rows) {
      expect(r).toMatchObject({
        type: 'mentioned',
        actorId: w.ids.C,
        projectId: item._id,
        projectTitle: 'Billing',
        detail: { kind: 'mentioned', excerpt },
      });
    }
    expect((rows[0]!.detail as { excerpt: string }).excerpt).toHaveLength(200);
  });

  test('FR-5.1: editing a note to add a mention notifies only the newly mentioned person', async () => {
    const w = await world();
    const item = await w.item();
    const created = await w.addNote('C', item._id, { body: 'ask @Ann', mentionIds: [w.ids.A] });
    expect(created.statusCode).toBe(201);
    const noteId = created.json<{ id: string }>().id;
    await t.db.collection('notifications').deleteMany({ tenantId: w.tenantId });

    const res = await w.editNote('C', item._id, noteId, { body: 'ask @Ann and @Dee', mentionIds: [w.ids.A, w.ids.D] });
    expect(res.statusCode).toBe(200);
    const rows = await w.rows();
    expect(rows.map((r) => [r.userId, r.type, r.detail])).toEqual([
      [w.ids.D, 'mentioned', { kind: 'mentioned', excerpt: 'ask @Ann and @Dee' }],
    ]);
    // A body-only edit with the same mentions writes nothing more.
    expect((await w.editNote('C', item._id, noteId, { body: 'ask @Ann and @Dee now', mentionIds: [w.ids.A, w.ids.D] })).statusCode).toBe(200);
    expect(await w.rows()).toHaveLength(1);
  });
});

describe('refused changes', () => {
  test('FR-5.1: a change refused part-way (version conflict, date order) leaves no notification row', async () => {
    const w = await world();
    const item = await w.item({ startDate: '2026-03-01', endDate: '2026-03-31', assigneeIds: [w.ids.D] });
    // Version 1 moves the end date and notifies D; the item is now at version 2.
    expect((await w.edit('O', item._id, { version: 1, endDate: '2026-04-30' })).statusCode).toBe(200);
    await t.db.collection('notifications').deleteMany({ tenantId: w.tenantId });

    const stale = await w.edit('O', item._id, { version: 1, endDate: '2026-05-31' });
    expect(stale.statusCode).toBe(409);
    const order = await w.edit('O', item._id, { version: 2, endDate: '2026-02-01' });
    expect(order.statusCode).toBe(422);
    expect(order.json()).toMatchObject({ error: 'date_order' });
    const archived = await w.item({ archived: true });
    const onArchived = await w.addNote('C', archived._id, { body: 'hi @Dee', mentionIds: [w.ids.D] });
    expect(onArchived.statusCode).toBe(409);
    const notMember = await w.assign('O', item._id, [w.ids.D, w.ids.C, w.ids.X]);
    expect(notMember.statusCode).toBe(422);
    expect(await w.rows()).toEqual([]);
  });
});

describe('deleting', () => {
  test("FR-5.1: deleting an item deletes its notifications and those of everything under it; deleting the roadmap deletes all of its notifications; removing a member deletes that person's notifications for that roadmap only", async () => {
    const w = await world();
    const parent = await w.item();
    const child = await w.item({ parentId: parent._id });
    const grandchild = await w.item({ parentId: child._id });
    const sibling = await w.item();
    const other = await t.seed.roadmap(w.tenantId, w.ids.O, 'Other');
    await t.seed.member(w.tenantId, other._id, w.ids.D, 'contributor');
    const otherItem = await t.seed.project(w.tenantId, other._id);
    for (const p of [parent, child, grandchild, sibling]) await seedRow(w.tenantId, w.roadmap._id, p._id, w.ids.C);
    const dInRoadmap = await seedRow(w.tenantId, w.roadmap._id, sibling._id, w.ids.D);
    const dInOther = await seedRow(w.tenantId, other._id, otherItem._id, w.ids.D);
    const cInOther = await seedRow(w.tenantId, other._id, otherItem._id, w.ids.C);

    expect((await w.send('O', 'DELETE', w.itemUrl(parent._id))).statusCode).toBe(200);
    expect((await w.rows()).map((r) => [r.roadmapId, r.projectId, r.userId])).toEqual([
      [w.roadmap._id, sibling._id, w.ids.C],
      [w.roadmap._id, sibling._id, w.ids.D],
      [other._id, otherItem._id, w.ids.D],
      [other._id, otherItem._id, w.ids.C],
    ]);

    expect((await w.send('O', 'DELETE', `/api/roadmaps/${w.roadmap._id}/members/${w.ids.D}`)).statusCode).toBe(204);
    const afterRemoval = (await w.rows()).map((r) => r._id);
    expect(afterRemoval).not.toContain(dInRoadmap);
    expect(afterRemoval).toContain(dInOther);
    expect(afterRemoval).toHaveLength(3);

    const del = await w.send('O', 'DELETE', `/api/roadmaps/${w.roadmap._id}`, { confirmName: 'Launch' });
    expect(del.statusCode).toBe(204);
    expect((await w.rows()).map((r) => r._id).sort()).toEqual([dInOther, cInOther].sort());
  });
});

describe('tenants', () => {
  test('Tenant isolation: rows are written in the item\'s tenant only', async () => {
    const a = await world();
    const b = await world();
    const item = await a.item({ assigneeIds: [a.ids.D], endDate: '2026-03-31' });
    expect((await a.assign('O', item._id, [a.ids.D, a.ids.C])).statusCode).toBe(200);
    expect((await a.edit('O', item._id, { version: 2, endDate: '2026-04-30' })).statusCode).toBe(200);
    expect((await a.addNote('O', item._id, { body: '@Dee', mentionIds: [a.ids.D, b.ids.D] })).statusCode).toBe(201);

    const all = await t.db
      .collection<NotificationDoc>('notifications')
      .find({ userId: { $in: [a.ids.C, a.ids.D, b.ids.C, b.ids.D] } })
      .toArray();
    // C assigned; C and D dates changed; D mentioned (B's D is not a member of A's roadmap).
    expect(all).toHaveLength(4);
    expect(all.every((r) => r.tenantId === a.tenantId && r.roadmapId === a.roadmap._id)).toBe(true);
    expect(await b.rows()).toEqual([]);
    // Someone in tenant B cannot reach tenant A's item, so nothing is written there either.
    expect((await b.assign('O', item._id, [b.ids.D])).statusCode).toBe(404);
    expect(await b.rows()).toEqual([]);
  });
});

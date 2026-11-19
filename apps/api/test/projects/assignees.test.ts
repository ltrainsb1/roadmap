import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

interface Dto {
  id: string;
  assigneeIds: string[];
  version: number;
}

/** A roadmap with owner O, admin A, contributors C1 and C2, and one outsider X (same tenant, not a member). */
async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const [O, A, C1, C2, X] = [
    await t.seed.user(tenantId),
    await t.seed.user(tenantId),
    await t.seed.user(tenantId),
    await t.seed.user(tenantId),
    await t.seed.user(tenantId),
  ];
  const roadmap = await t.seed.roadmap(tenantId, O._id);
  await t.seed.member(tenantId, roadmap._id, A._id, 'admin');
  await t.seed.member(tenantId, roadmap._id, C1._id, 'contributor');
  await t.seed.member(tenantId, roadmap._id, C2._id, 'contributor');
  const sess = {
    O: await signInAs(t.app, t.db, O._id),
    A: await signInAs(t.app, t.db, A._id),
    C1: await signInAs(t.app, t.db, C1._id),
  };
  const send = (
    who: keyof typeof sess,
    method: 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      ...(payload ? { payload } : {}),
    });
  const assign = (who: keyof typeof sess, projectId: string, userIds: string[], roadmapId = roadmap._id) =>
    send(who, 'PUT', `/api/roadmaps/${roadmapId}/projects/${projectId}/assignees`, { userIds });
  const item = (o: { parentId?: string; assigneeIds?: string[]; roadmapId?: string } = {}) =>
    t.seed.project(tenantId, o.roadmapId ?? roadmap._id, o);
  const stored = (id: string) => t.db.collection('projects').findOne({ _id: id as never });
  return { tenantId, ids: { O: O._id, A: A._id, C1: C1._id, C2: C2._id, X: X._id }, roadmap, sess, send, assign, item, stored };
}

describe('assigning members', () => {
  test('FR-1.6: an Admin assigns two members to a task, and assigns a member at each of the four levels', async () => {
    const w = await world();
    const project = await w.item();
    const sub = await w.item({ parentId: project._id });
    const task = await w.item({ parentId: sub._id });
    const subtask = await w.item({ parentId: task._id });

    const res = await w.assign('A', task._id, [w.ids.C1, w.ids.C2]);
    expect(res.statusCode).toBe(200);
    expect(res.json<Dto>()).toMatchObject({ id: task._id, assigneeIds: [w.ids.C1, w.ids.C2], version: 2 });

    const audit = await t.db
      .collection('auditEvents')
      .findOne({ tenantId: w.tenantId, action: 'project.assign', 'target.id': task._id });
    expect(audit).toMatchObject({
      roadmapId: w.roadmap._id,
      target: { type: 'project', id: task._id },
      before: { title: 'Item', assigneeIds: [] },
      after: { title: 'Item', assigneeIds: [w.ids.C1, w.ids.C2] },
    });

    for (const level of [project, sub, task, subtask]) {
      const r = await w.assign('A', level._id, [w.ids.C1]);
      expect(r.statusCode).toBe(200);
      expect((await w.stored(level._id))!.assigneeIds).toEqual([w.ids.C1]);
    }
  });

  test('FR-1.6: duplicates are removed, an empty list clears, and the same set in another order changes nothing', async () => {
    const w = await world();
    const a = await w.item();
    const first = await w.assign('A', a._id, [w.ids.C2, w.ids.C1, w.ids.C2]);
    expect(first.json<Dto>()).toMatchObject({ assigneeIds: [w.ids.C2, w.ids.C1], version: 2 });
    const reordered = await w.assign('A', a._id, [w.ids.C1, w.ids.C2]);
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<Dto>()).toMatchObject({ assigneeIds: [w.ids.C2, w.ids.C1], version: 2 });
    const events = await t.db.collection('auditEvents').find({ tenantId: w.tenantId, 'target.id': a._id, action: 'project.assign' }).toArray();
    expect(events).toHaveLength(1);
    const cleared = await w.assign('A', a._id, []);
    expect(cleared.json<Dto>()).toMatchObject({ assigneeIds: [], version: 3 });
  });

  test('Permissions (project.assign): Owner and Admin get 200; a Contributor gets 403 even on an item they are assigned to', async () => {
    const w = await world();
    const a = await w.item({ assigneeIds: [w.ids.C1] });
    expect((await w.assign('O', a._id, [w.ids.A])).statusCode).toBe(200);
    expect((await w.assign('A', a._id, [w.ids.C1])).statusCode).toBe(200);
    const res = await w.assign('C1', a._id, [w.ids.C1, w.ids.C2]);
    expect(res.statusCode).toBe(403);
    expect((await w.stored(a._id))!.assigneeIds).toEqual([w.ids.C1]);
  });

  test('Review focus 3: assigning someone who is not a member of the roadmap returns 422 not_a_member', async () => {
    const w = await world();
    const a = await w.item();
    const res = await w.assign('A', a._id, [w.ids.C1, w.ids.X]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'not_a_member' });
    // A member of another roadmap in the same tenant is still not a member of this one.
    const other = await t.seed.roadmap(w.tenantId, w.ids.X);
    expect(other._id).not.toBe(w.roadmap._id);
    expect((await w.assign('A', a._id, [w.ids.X])).json()).toEqual({ error: 'not_a_member' });
    expect((await w.stored(a._id))).toMatchObject({ assigneeIds: [], version: 1 });
  });

  test('FR-1.6: an unknown item is 404', async () => {
    const w = await world();
    expect((await w.assign('A', 'no-such-item', [])).statusCode).toBe(404);
  });
});

describe('membership cleanup', () => {
  test('Review focus 3: removing a member clears them from every item in that roadmap and leaves their assignments in other roadmaps', async () => {
    const w = await world();
    const a = await w.item({ assigneeIds: [w.ids.C1, w.ids.C2] });
    const b = await w.item({ parentId: a._id, assigneeIds: [w.ids.C1] });
    const c = await w.item({ assigneeIds: [w.ids.C2] });
    const other = await t.seed.roadmap(w.tenantId, w.ids.O);
    await t.seed.member(w.tenantId, other._id, w.ids.C1, 'contributor');
    const elsewhere = await w.item({ roadmapId: other._id, assigneeIds: [w.ids.C1] });

    const res = await w.send('O', 'DELETE', `/api/roadmaps/${w.roadmap._id}/members/${w.ids.C1}`);
    expect(res.statusCode).toBe(204);

    expect((await w.stored(a._id))).toMatchObject({ assigneeIds: [w.ids.C2], version: 1 });
    expect((await w.stored(b._id))).toMatchObject({ assigneeIds: [], version: 1 });
    expect((await w.stored(c._id))).toMatchObject({ assigneeIds: [w.ids.C2], version: 1 });
    expect((await w.stored(elsewhere._id))!.assigneeIds).toEqual([w.ids.C1]);
  });

  test('FR-1.6: after being unassigned, a Contributor can no longer edit the item', async () => {
    const w = await world();
    const a = await w.item({ assigneeIds: [w.ids.C1] });
    const url = `/api/roadmaps/${w.roadmap._id}/projects/${a._id}`;
    expect((await w.send('C1', 'PATCH', url, { version: 1, title: 'Mine' })).statusCode).toBe(200);
    expect((await w.assign('A', a._id, [w.ids.C2])).statusCode).toBe(200);
    expect((await w.send('C1', 'PATCH', url, { version: 3, title: 'Still mine' })).statusCode).toBe(403);
  });

  test('deleting a roadmap deletes its projects and leaves another roadmap\'s projects', async () => {
    const w = await world();
    const a = await w.item();
    const b = await w.item({ parentId: a._id });
    const other = await t.seed.roadmap(w.tenantId, w.ids.O);
    const keep = await w.item({ roadmapId: other._id });
    const res = await w.send('O', 'DELETE', `/api/roadmaps/${w.roadmap._id}`, { confirmName: 'Roadmap' });
    expect(res.statusCode).toBe(204);
    expect(await w.stored(a._id)).toBeNull();
    expect(await w.stored(b._id)).toBeNull();
    expect(await w.stored(keep._id)).not.toBeNull();
  });
});

describe('Tenant isolation', () => {
  test('Tenant isolation: another tenant gets 404', async () => {
    const w = await world();
    const a = await w.item();
    const otherTenant = (await t.seed.tenant('Other'))._id;
    const stranger = await t.seed.user(otherTenant);
    const sess = await signInAs(t.app, t.db, stranger._id);
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/roadmaps/${w.roadmap._id}/projects/${a._id}/assignees`,
      headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
      payload: { userIds: [] },
    });
    expect(res.statusCode).toBe(404);
    expect((await w.stored(a._id))!.version).toBe(1);
  });
});

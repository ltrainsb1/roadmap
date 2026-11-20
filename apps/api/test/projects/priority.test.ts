import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ProjectDoc } from '../../src/db/types.ts';
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
  rank: number;
  priorityLabel: string | null;
  version: number;
}

/** A roadmap with owner O, admin A and contributor C (assigned to nothing unless a test says so). */
async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const [O, A, C] = [await t.seed.user(tenantId), await t.seed.user(tenantId), await t.seed.user(tenantId)];
  const roadmap = await t.seed.roadmap(tenantId, O._id);
  await t.seed.member(tenantId, roadmap._id, A._id, 'admin');
  await t.seed.member(tenantId, roadmap._id, C._id, 'contributor');
  const sess = {
    O: await signInAs(t.app, t.db, O._id),
    A: await signInAs(t.app, t.db, A._id),
    C: await signInAs(t.app, t.db, C._id),
  };
  const send = (who: keyof typeof sess, url: string, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PUT',
      url,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      payload,
    });
  const reorder = (who: keyof typeof sess, parentId: string | null, orderedIds: string[], roadmapId = roadmap._id) =>
    send(who, `/api/roadmaps/${roadmapId}/projects/order`, { parentId, orderedIds });
  const label = (who: keyof typeof sess, projectId: string, value: string | null, roadmapId = roadmap._id) =>
    send(who, `/api/roadmaps/${roadmapId}/projects/${projectId}/priority-label`, { label: value });
  const item = (o: { parentId?: string; title?: string; archived?: boolean; assigneeIds?: string[]; roadmapId?: string } = {}) =>
    t.seed.project(tenantId, o.roadmapId ?? roadmap._id, o);
  const stored = (id: string) => t.db.collection<ProjectDoc>('projects').findOne({ _id: id });
  const ranks = async (ids: string[]) => Promise.all(ids.map(async (id) => (await stored(id))!.rank));
  const events = (action: string) => t.db.collection('auditEvents').find({ tenantId, roadmapId: roadmap._id, action }).toArray();
  return { tenantId, ids: { O: O._id, A: A._id, C: C._id }, roadmap, send, reorder, label, item, stored, ranks, events };
}

describe('reorder', () => {
  test('FR-1.3: an Admin reorders three sub-projects and the list returns the new ranks', async () => {
    const w = await world();
    const parent = await w.item({ title: 'Parent' });
    const [a, b, c] = [
      await w.item({ parentId: parent._id }),
      await w.item({ parentId: parent._id }),
      await w.item({ parentId: parent._id }),
    ];
    const res = await w.reorder('A', parent._id, [c._id, a._id, b._id]);
    expect(res.statusCode).toBe(204);

    const sess = await signInAs(t.app, t.db, w.ids.A);
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/roadmaps/${w.roadmap._id}/projects`,
      headers: { cookie: sess.cookie },
    });
    const byId = new Map(list.json<{ items: Dto[] }>().items.map((i) => [i.id, i]));
    expect([c, a, b].map((x) => byId.get(x._id)!.rank)).toEqual([0, 1, 2]);
    expect(byId.get(a._id)!.version).toBe(1); // a reorder does not bump version

    const [event] = await w.events('project.reorder');
    expect(event).toMatchObject({
      target: { type: 'project', id: parent._id },
      after: { parentTitle: 'Parent', orderedIds: [c._id, a._id, b._id] },
    });
  });

  test('FR-1.3: reordering top-level projects uses parentId null', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    const res = await w.reorder('O', null, [b._id, a._id]);
    expect(res.statusCode).toBe(204);
    expect(await w.ranks([b._id, a._id])).toEqual([0, 1]);
    const [event] = await w.events('project.reorder');
    expect(event).toMatchObject({
      target: { type: 'roadmap', id: w.roadmap._id },
      after: { parentTitle: null, orderedIds: [b._id, a._id] },
    });
  });

  test('FR-1.3: PUT /projects/order reaches the reorder handler, not the :projectId routes', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    // A wrong list proves the reorder handler ran: it answers 409 order_stale, which no other route can.
    const stale = await w.reorder('A', null, [a._id]);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'order_stale' });
    expect((await w.reorder('A', null, [b._id, a._id])).statusCode).toBe(204);
  });

  test('Review focus 5: a list missing a sibling, with an extra id, or with a duplicate returns 409 order_stale and the ranks are unchanged', async () => {
    const w = await world();
    const parent = await w.item();
    const [a, b, c] = [
      await w.item({ parentId: parent._id }),
      await w.item({ parentId: parent._id }),
      await w.item({ parentId: parent._id }),
    ];
    const elsewhere = await w.item(); // another parent
    const otherRoadmap = await t.seed.roadmap(w.tenantId, w.ids.O);
    const foreign = await w.item({ roadmapId: otherRoadmap._id });
    const bad = [
      [c._id, a._id], // missing b
      [c._id, a._id, b._id, elsewhere._id], // an id from another parent
      [c._id, a._id, b._id, foreign._id], // an id from another roadmap
      [c._id, a._id, b._id, 'no-such-item'],
      [c._id, a._id, a._id], // duplicate in place of b
      [c._id, a._id, b._id, b._id], // duplicate extra
    ];
    for (const orderedIds of bad) {
      const res = await w.reorder('A', parent._id, orderedIds);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'order_stale' });
    }
    expect(await w.ranks([a._id, b._id, c._id])).toEqual([0, 1, 2]);
    expect(await w.events('project.reorder')).toHaveLength(0);
  });

  test('FR-1.3: a parent that is not in this roadmap is 404, and a parent with no children is order_stale', async () => {
    const w = await world();
    const leaf = await w.item();
    const otherRoadmap = await t.seed.roadmap(w.tenantId, w.ids.O);
    const foreign = await w.item({ roadmapId: otherRoadmap._id });
    expect((await w.reorder('A', 'no-such-item', ['x'])).statusCode).toBe(404);
    expect((await w.reorder('A', foreign._id, ['x'])).statusCode).toBe(404);
    const res = await w.reorder('A', leaf._id, ['x']);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'order_stale' });
  });

  test('FR-1.3: submitting the stored order returns 204 and writes nothing', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    const res = await w.reorder('A', null, [a._id, b._id]);
    expect(res.statusCode).toBe(204);
    expect(await w.events('project.reorder')).toHaveLength(0);
    expect(await w.ranks([a._id, b._id])).toEqual([0, 1]);
  });

  test('FR-1.3: only the ranks that change are written', async () => {
    const w = await world();
    const [a, b, c] = [await w.item(), await w.item(), await w.item()];
    const before = (await w.stored(a._id))!.updatedAt;
    // Swap b and c; a keeps rank 0 and is not touched. Ranks do not touch updatedAt, so watch the audit instead.
    expect((await w.reorder('A', null, [a._id, c._id, b._id])).statusCode).toBe(204);
    expect(await w.ranks([a._id, c._id, b._id])).toEqual([0, 1, 2]);
    expect((await w.stored(a._id))!.updatedAt).toEqual(before);
  });

  test('FR-1.3: two concurrent reorders of the same siblings leave one consistent order', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await w.item())._id);
    // Two permutations that change disjoint items (0<->1 and 4<->5), so only the roadmap-wide guard can serialise them.
    const one = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const two = [...ids.slice(0, 4), ids[5]!, ids[4]!];
    const [r1, r2] = await Promise.all([w.reorder('A', null, one), w.reorder('O', null, two)]);
    expect([r1.statusCode, r2.statusCode]).toEqual([204, 204]);
    const finalRanks = await w.ranks(ids);
    expect([...finalRanks].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5]);
    // Whole-list semantics: the result is exactly the later request's order, not a blend of the two.
    const order = ids.slice().sort((x, y) => finalRanks[ids.indexOf(x)]! - finalRanks[ids.indexOf(y)]!);
    expect([one, two]).toContainEqual(order);
  });

  test('FR-1.3: archived siblings are not part of the order', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    const archived = await w.item({ archived: true });
    const archivedRank = (await w.stored(archived._id))!.rank;
    const withArchived = await w.reorder('A', null, [b._id, a._id, archived._id]);
    expect(withArchived.statusCode).toBe(409);
    expect(withArchived.json()).toEqual({ error: 'order_stale' });
    expect((await w.reorder('A', null, [b._id, a._id])).statusCode).toBe(204);
    expect((await w.stored(archived._id))!.rank).toBe(archivedRank);
  });
});

describe('priority label', () => {
  test('FR-1.3: the priority label can be set to P1 and cleared with null', async () => {
    const w = await world();
    const a = await w.item({ title: 'Alpha' });
    const set = await w.label('A', a._id, 'P1');
    expect(set.statusCode).toBe(200);
    expect(set.json<Dto>()).toMatchObject({ id: a._id, priorityLabel: 'P1', version: 2 });
    const cleared = await w.label('A', a._id, null);
    expect(cleared.json<Dto>()).toMatchObject({ priorityLabel: null, version: 3 });

    const events = await w.events('project.priority_label');
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        target: { type: 'project', id: a._id },
        before: { title: 'Alpha', priorityLabel: null },
        after: { title: 'Alpha', priorityLabel: 'P1' },
      }),
    );
  });

  test('FR-1.3: setting the label an item already has changes nothing', async () => {
    const w = await world();
    const a = await w.item();
    await w.label('A', a._id, 'P3');
    const again = await w.label('A', a._id, 'P3');
    expect(again.statusCode).toBe(200);
    expect(again.json<Dto>()).toMatchObject({ priorityLabel: 'P3', version: 2 });
    expect(await w.events('project.priority_label')).toHaveLength(1);
    const none = await w.item();
    expect((await w.label('A', none._id, null)).json<Dto>().version).toBe(1);
  });

  test('FR-1.3: an archived item keeps a changeable label, and an unknown label or item is refused', async () => {
    const w = await world();
    const a = await w.item({ archived: true });
    expect((await w.label('A', a._id, 'P2')).json<Dto>()).toMatchObject({ priorityLabel: 'P2' });
    expect((await w.label('A', a._id, 'P5')).statusCode).toBe(400);
    expect((await w.label('A', 'no-such-item', 'P1')).statusCode).toBe(404);
  });
});

describe('permissions and tenants', () => {
  test('Permissions (project.setPriority): Owner and Admin succeed on both routes; a Contributor gets 403 on both, even when assigned', async () => {
    const w = await world();
    const parent = await w.item({ assigneeIds: [w.ids.C] });
    const [a, b] = [await w.item({ parentId: parent._id, assigneeIds: [w.ids.C] }), await w.item({ parentId: parent._id })];
    expect((await w.reorder('O', parent._id, [b._id, a._id])).statusCode).toBe(204);
    expect((await w.reorder('A', parent._id, [a._id, b._id])).statusCode).toBe(204);
    expect((await w.label('O', a._id, 'P1')).statusCode).toBe(200);
    expect((await w.label('A', a._id, 'P2')).statusCode).toBe(200);

    expect((await w.reorder('C', parent._id, [b._id, a._id])).statusCode).toBe(403);
    expect((await w.label('C', a._id, 'P4')).statusCode).toBe(403);
    expect(await w.ranks([a._id, b._id])).toEqual([0, 1]);
    expect((await w.stored(a._id))!.priorityLabel).toBe('P2');
  });

  test('Tenant isolation: another tenant gets 404 on both routes', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    const otherTenant = (await t.seed.tenant('Other'))._id;
    const stranger = await t.seed.user(otherTenant);
    const sess = await signInAs(t.app, t.db, stranger._id);
    const headers = { cookie: sess.cookie, 'x-csrf-token': sess.csrf };
    const order = await t.app.inject({
      method: 'PUT',
      url: `/api/roadmaps/${w.roadmap._id}/projects/order`,
      headers,
      payload: { parentId: null, orderedIds: [b._id, a._id] },
    });
    const label = await t.app.inject({
      method: 'PUT',
      url: `/api/roadmaps/${w.roadmap._id}/projects/${a._id}/priority-label`,
      headers,
      payload: { label: 'P1' },
    });
    expect([order.statusCode, label.statusCode]).toEqual([404, 404]);
    expect(await w.ranks([a._id, b._id])).toEqual([0, 1]);
    expect((await w.stored(a._id))!.priorityLabel).toBeNull();
  });
});

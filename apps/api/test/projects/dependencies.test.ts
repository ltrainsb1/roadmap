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
  blockedBy: string[];
  version: number;
}

async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const owner = await t.seed.user(tenantId);
  const roadmap = await t.seed.roadmap(tenantId, owner._id);
  const sess = await signInAs(t.app, t.db, owner._id);
  const patch = (roadmapId: string, projectId: string, payload: Record<string, unknown>) =>
    t.app.inject({
      method: 'PATCH',
      url: `/api/roadmaps/${roadmapId}/projects/${projectId}`,
      headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
      payload,
    });
  const item = (o: { parentId?: string; archived?: boolean } = {}) => t.seed.project(tenantId, roadmap._id, o);
  const block = (id: string, blockedBy: string[], version = 1) => patch(roadmap._id, id, { version, blockedBy });
  const list = async () =>
    (
      await t.app.inject({
        method: 'GET',
        url: `/api/roadmaps/${roadmap._id}/projects`,
        headers: { cookie: sess.cookie },
      })
    ).json<{ items: Dto[] }>().items;
  return { tenantId, owner, roadmap, sess, patch, item, block, list };
}

describe('blocked by', () => {
  test('FR-1.4: an item can be blocked by two other items in the same roadmap', async () => {
    const w = await world();
    const [a, b, c] = [await w.item(), await w.item(), await w.item()];
    const res = await w.block(a._id, [b._id, c._id]);
    expect(res.statusCode).toBe(200);
    expect(res.json<Dto>()).toMatchObject({ id: a._id, blockedBy: [b._id, c._id], version: 2 });
    expect((await w.list()).find((i) => i.id === a._id)!.blockedBy).toEqual([b._id, c._id]);
  });

  test('FR-1.4: the change is audited with before and after, and the same list again writes nothing', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    await w.block(a._id, [b._id]);
    const again = await w.block(a._id, [b._id], 2);
    expect(again.statusCode).toBe(200);
    expect(again.json<Dto>().version).toBe(2);
    const events = (await t.db.collection('auditEvents').find({ tenantId: w.tenantId, 'target.id': a._id }).toArray()).filter(
      (e) => e.action === 'project.update',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ before: { title: 'Item', blockedBy: [] }, after: { title: 'Item', blockedBy: [b._id] } });
  });

  test('FR-1.4: an empty list clears the blockers, and an archived item can be a blocker', async () => {
    const w = await world();
    const [a, gone] = [await w.item(), await w.item({ archived: true })];
    expect((await w.block(a._id, [gone._id])).json<Dto>().blockedBy).toEqual([gone._id]);
    expect((await w.block(a._id, [], 2)).json<Dto>().blockedBy).toEqual([]);
  });

  test('FR-1.4: a stale version is checked before the blockers', async () => {
    const w = await world();
    const a = await w.item();
    const res = await w.block(a._id, ['no-such-item'], 7);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conflict' });
  });

  test('FR-1.4: blocked by itself, by its parent and by its child each return 422 dependency_cycle', async () => {
    const w = await world();
    const parent = await w.item();
    const child = await w.item({ parentId: parent._id });
    const lone = await w.item();
    for (const [id, blocker] of [
      [lone._id, lone._id],
      [child._id, parent._id],
      [parent._id, child._id],
    ] as const) {
      const res = await w.block(id, [blocker]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'dependency_cycle' });
    }
    expect((await w.list()).every((i) => i.blockedBy.length === 0 && i.version === 1)).toBe(true);
  });

  test('FR-1.4: A blocked by B, then B blocked by A returns 422 dependency_cycle', async () => {
    const w = await world();
    const [a, b] = [await w.item(), await w.item()];
    expect((await w.block(a._id, [b._id])).statusCode).toBe(200);
    const res = await w.block(b._id, [a._id]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'dependency_cycle' });
  });

  test('FR-1.4: a three-item cycle returns 422 dependency_cycle', async () => {
    const w = await world();
    const [a, b, c] = [await w.item(), await w.item(), await w.item()];
    expect((await w.block(a._id, [b._id])).statusCode).toBe(200);
    expect((await w.block(b._id, [c._id])).statusCode).toBe(200);
    const res = await w.block(c._id, [a._id]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'dependency_cycle' });
  });

  test('FR-1.4: two concurrent requests that would form a cycle together: exactly one succeeds', async () => {
    const w = await world();
    for (let round = 0; round < 5; round++) {
      const [a, b] = [await w.item(), await w.item()];
      const [r1, r2] = await Promise.all([w.block(a._id, [b._id]), w.block(b._id, [a._id])]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 422]);
      const loser = r1.statusCode === 422 ? r1 : r2;
      expect(loser.json()).toEqual({ error: 'dependency_cycle' });
      const stored = (await w.list()).filter((i) => i.id === a._id || i.id === b._id);
      expect(stored.reduce((n, i) => n + i.blockedBy.length, 0)).toBe(1);
    }
  });

  test('FR-1.4: an id from another roadmap or tenant returns 422 unknown_item', async () => {
    const w = await world();
    const a = await w.item();
    const otherRoadmap = await t.seed.roadmap(w.tenantId, w.owner._id, 'Other');
    const inOther = await t.seed.project(w.tenantId, otherRoadmap._id);
    const otherTenant = (await t.seed.tenant('Other tenant'))._id;
    const otherOwner = await t.seed.user(otherTenant);
    const foreignRoadmap = await t.seed.roadmap(otherTenant, otherOwner._id);
    const foreign = await t.seed.project(otherTenant, foreignRoadmap._id);
    for (const id of [inOther._id, foreign._id, 'does-not-exist']) {
      const res = await w.block(a._id, [id]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'unknown_item' });
    }
    expect((await w.list()).find((i) => i.id === a._id)).toMatchObject({ blockedBy: [], version: 1 });
  });

  test('FR-1.4: 21 blockers return 400', async () => {
    const w = await world();
    const a = await w.item();
    const res = await w.block(a._id, Array.from({ length: 21 }, (_, i) => `item-${i}`));
    expect(res.statusCode).toBe(400);
  });
});

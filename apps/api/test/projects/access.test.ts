import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isAssignedTo, loadProject } from '../../src/projects/access.ts';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

async function setup() {
  const tenantA = (await t.seed.tenant('A'))._id;
  const owner = await t.seed.user(tenantA);
  const roadmap = await t.seed.roadmap(tenantA, owner._id);
  return { tenantA, owner, roadmap, db: scoped(t.db, tenantA) };
}

describe('loadProject', () => {
  test('returns an item of this roadmap', async () => {
    const w = await setup();
    const p = await t.seed.project(w.tenantA, w.roadmap._id, { title: 'Mine' });
    expect((await loadProject(w.db, w.roadmap._id, p._id)).title).toBe('Mine');
  });

  test('404 not_found for another roadmap, another tenant, and an unknown id', async () => {
    const w = await setup();
    const other = await t.seed.roadmap(w.tenantA, w.owner._id, 'Other');
    const inOther = await t.seed.project(w.tenantA, other._id);
    await expect(loadProject(w.db, w.roadmap._id, inOther._id)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });

    const tenantB = (await t.seed.tenant('B'))._id;
    const ownerB = await t.seed.user(tenantB);
    const roadmapB = await t.seed.roadmap(tenantB, ownerB._id);
    const inB = await t.seed.project(tenantB, roadmapB._id);
    await expect(loadProject(w.db, roadmapB._id, inB._id)).rejects.toMatchObject({ status: 404 });
    await expect(loadProject(w.db, w.roadmap._id, inB._id)).rejects.toMatchObject({ status: 404 });
    await expect(loadProject(w.db, w.roadmap._id, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('isAssignedTo', () => {
  test('true for a direct assignee and for an assignee of a grandparent', async () => {
    const w = await setup();
    const u = (await t.seed.user(w.tenantA))._id;
    const gp = await t.seed.project(w.tenantA, w.roadmap._id, { assigneeIds: [u] });
    const parent = await t.seed.project(w.tenantA, w.roadmap._id, { parentId: gp._id });
    const leaf = await t.seed.project(w.tenantA, w.roadmap._id, { parentId: parent._id });
    expect(await isAssignedTo(w.db, gp, u)).toBe(true);
    expect(await isAssignedTo(w.db, leaf, u)).toBe(true);
  });

  test('false for an assignee of a sibling or of a child, and for a stranger', async () => {
    const w = await setup();
    const u = (await t.seed.user(w.tenantA))._id;
    const parent = await t.seed.project(w.tenantA, w.roadmap._id);
    const item = await t.seed.project(w.tenantA, w.roadmap._id, { parentId: parent._id });
    await t.seed.project(w.tenantA, w.roadmap._id, { parentId: parent._id, assigneeIds: [u] }); // sibling
    await t.seed.project(w.tenantA, w.roadmap._id, { parentId: item._id, assigneeIds: [u] }); // child
    expect(await isAssignedTo(w.db, item, u)).toBe(false);
    expect(await isAssignedTo(w.db, item, 'stranger')).toBe(false);
  });
});

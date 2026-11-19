import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
let limited: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
  limited = await makeTestApp({ maxProjectItems: 3 });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await limited?.close();
});

type Who = 'O' | 'A' | 'C';
const ROLE_OF = { O: 'owner', A: 'admin', C: 'contributor' } as const;

/** A fresh tenant and roadmap: owner O, admin A, contributor C. */
async function world(app: TestApp = t) {
  const tenantId = (await app.seed.tenant())._id;
  const ids = {} as Record<Who, string>;
  for (const w of Object.keys(ROLE_OF) as Who[]) ids[w] = (await app.seed.user(tenantId))._id;
  const roadmap = await app.seed.roadmap(tenantId, ids.O);
  await app.seed.member(tenantId, roadmap._id, ids.A, 'admin');
  await app.seed.member(tenantId, roadmap._id, ids.C, 'contributor');
  const sess = {} as Record<Who, { cookie: string; csrf: string }>;
  for (const w of Object.keys(ids) as Who[]) sess[w] = await signInAs(app.app, app.db, ids[w]);
  const call = (who: Who, method: 'GET' | 'POST', payload?: Record<string, unknown>, roadmapId = roadmap._id) =>
    app.app.inject({
      method,
      url: `/api/roadmaps/${roadmapId}/projects`,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      ...(payload ? { payload } : {}),
    });
  const create = async (who: Who, parentId: string | null, title = 'Item') => {
    const res = await call(who, 'POST', { parentId, title });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  };
  return { tenantId, ids, roadmap, sess, call, create, db: scoped(app.db, tenantId) };
}

describe('create and list', () => {
  test('FR-1.2: an Admin creates a project, a sub-project, a task and a sub-task, and the list returns all four with depth and path', async () => {
    const w = await world();
    const p = await w.create('A', null, 'Project');
    const s = await w.create('A', p, 'Sub-project');
    const k = await w.create('A', s, 'Task');
    const st = await w.create('A', k, 'Sub-task');
    const res = await w.call('A', 'GET');
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Array<Record<string, unknown>> }>().items;
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(items).toHaveLength(4);
    expect(byId.get(p)).toMatchObject({ depth: 1, path: [], parentId: null, status: 'not_started', version: 1, archived: false });
    expect(byId.get(s)).toMatchObject({ depth: 2, path: [p], parentId: p });
    expect(byId.get(k)).toMatchObject({ depth: 3, path: [p, s] });
    expect(byId.get(st)).toMatchObject({ depth: 4, path: [p, s, k], title: 'Sub-task' });
    expect(Object.keys(byId.get(p)!)).not.toContain('tenantId');
    expect(Object.keys(byId.get(p)!)).not.toContain('createdBy');
    expect(typeof byId.get(p)!.updatedAt).toBe('string');
  });

  test('FR-1.2: the API rejects a fifth level with 422 too_deep', async () => {
    const w = await world();
    const a = await w.create('A', null);
    const b = await w.create('A', a);
    const c = await w.create('A', b);
    const d = await w.create('A', c);
    const res = await w.call('A', 'POST', { parentId: d, title: 'Too deep' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_deep' });
  });

  test('new items go last among their siblings', async () => {
    const w = await world();
    const p = await w.create('A', null);
    const ids = [await w.create('A', p, 'a'), await w.create('A', p, 'b'), await w.create('A', p, 'c')];
    const items = (await w.call('A', 'GET')).json<{ items: Array<{ id: string; rank: number }> }>().items;
    expect(ids.map((id) => items.find((i) => i.id === id)!.rank)).toEqual([0, 1, 2]);
  });

  test('a list includes archived items', async () => {
    const w = await world();
    await t.seed.project(w.tenantId, w.roadmap._id, { archived: true });
    expect((await w.call('O', 'GET')).json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('a malformed body is 400', async () => {
    const w = await world();
    expect((await w.call('A', 'POST', { parentId: null, title: '  ' })).statusCode).toBe(400);
  });
});

describe('Permissions (project.create)', () => {
  test.each(['O', 'A'] as const)('%s may create at the top level and under any item', async (who) => {
    const w = await world();
    const p = await w.create(who, null);
    await w.create(who, p);
  });

  test('a Contributor is refused at the top level and under an item they are not assigned to', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    expect((await w.call('C', 'POST', { parentId: null, title: 'x' })).statusCode).toBe(403);
    expect((await w.call('C', 'POST', { parentId: p._id, title: 'x' })).statusCode).toBe(403);
  });

  test('a Contributor may create under an item they are assigned to, and under a child of one', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    const child = await t.seed.project(w.tenantId, w.roadmap._id, { parentId: p._id });
    expect((await w.call('C', 'POST', { parentId: p._id, title: 'x' })).statusCode).toBe(201);
    expect((await w.call('C', 'POST', { parentId: child._id, title: 'x' })).statusCode).toBe(201);
  });

  test('a Contributor assigned in roadmap A and a Contributor in roadmap B cannot create under an item in B', async () => {
    const w = await world();
    await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    const roadmapB = await t.seed.roadmap(w.tenantId, w.ids.O, 'B');
    await t.seed.member(w.tenantId, roadmapB._id, w.ids.C, 'contributor');
    const inB = await t.seed.project(w.tenantId, roadmapB._id);
    const res = await w.call('C', 'POST', { parentId: inB._id, title: 'x' }, roadmapB._id);
    expect(res.statusCode).toBe(403);
  });

  test('a user who is not a member gets 404', async () => {
    const w = await world();
    const stranger = (await t.seed.user(w.tenantId))._id;
    const s = await signInAs(t.app, t.db, stranger);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/roadmaps/${w.roadmap._id}/projects`,
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('create rules', () => {
  test('creating under an archived parent returns 409 parent_archived', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { archived: true });
    const res = await w.call('A', 'POST', { parentId: p._id, title: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'parent_archived' });
  });

  test("an item past the roadmap's limit returns 422 too_many_items", async () => {
    const w = await world(limited);
    await w.create('A', null);
    await w.create('A', null);
    await w.create('A', null);
    const res = await w.call('A', 'POST', { parentId: null, title: 'fourth' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_many_items' });
  });
});

describe('Tenant isolation', () => {
  test("tenant B gets 404 listing or creating in tenant A's roadmap, and a parentId from another roadmap is 404", async () => {
    const a = await world();
    const b = await world();
    expect((await b.call('O', 'GET', undefined, a.roadmap._id)).statusCode).toBe(404);
    expect((await b.call('O', 'POST', { parentId: null, title: 'x' }, a.roadmap._id)).statusCode).toBe(404);

    const inA = await a.create('O', null);
    const cross = await b.call('O', 'POST', { parentId: inA, title: 'x' });
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toEqual({ error: 'not_found' });
    // Same tenant, other roadmap.
    const second = await t.seed.roadmap(a.tenantId, a.ids.O, 'Second');
    const sibling = await t.seed.project(a.tenantId, second._id);
    expect((await a.call('O', 'POST', { parentId: sibling._id, title: 'x' })).statusCode).toBe(404);
    // A Contributor probing an unknown parent gets the same 404.
    expect((await a.call('C', 'POST', { parentId: 'unknown', title: 'x' })).statusCode).toBe(404);
  });
});

describe('Audit', () => {
  test('project.create is audited with the title', async () => {
    const w = await world();
    const id = await w.create('A', null, 'Launch');
    const events = await w.db.audit.find({ roadmapId: w.roadmap._id, action: 'project.create' }, { sort: { timestamp: -1 }, limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: 'user', userId: w.ids.A },
      roadmapId: w.roadmap._id,
      target: { type: 'project', id },
      after: { title: 'Launch', parentId: null },
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { ProjectDoc, RoadmapDoc } from '../../src/db/types.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

type Action = 'archive' | 'unarchive' | 'delete';

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
  const act = (who: keyof typeof sess, action: Action, projectId: string, roadmapId = roadmap._id) =>
    t.app.inject({
      method: action === 'delete' ? 'DELETE' : 'POST',
      url: `/api/roadmaps/${roadmapId}/projects/${projectId}${action === 'delete' ? '' : `/${action}`}`,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
    });
  const item = (o: { parentId?: string; title?: string; archived?: boolean; assigneeIds?: string[]; roadmapId?: string } = {}) =>
    t.seed.project(tenantId, o.roadmapId ?? roadmap._id, o);
  const create = (who: keyof typeof sess, parentId: string | null) =>
    t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${roadmap._id}/projects`,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      payload: { parentId, title: 'Child' },
    });
  const projects = () => t.db.collection<ProjectDoc>('projects');
  const stored = (id: string) => projects().findOne({ _id: id });
  const ranks = async (ids: string[]) => Promise.all(ids.map(async (id) => (await stored(id))!.rank));
  const roadmapDoc = () => t.db.collection<RoadmapDoc>('roadmaps').findOne({ _id: roadmap._id });
  const events = (action: string) => t.db.collection('auditEvents').find({ tenantId, roadmapId: roadmap._id, action }).toArray();
  return { tenantId, ids: { O: O._id, A: A._id, C: C._id }, roadmap, sess, act, create, item, projects, stored, ranks, roadmapDoc, events };
}

/** top -> mid -> leaf -> sub, four levels. */
async function chain(w: Awaited<ReturnType<typeof world>>) {
  const top = await w.item({ title: 'Top' });
  const mid = await w.item({ parentId: top._id });
  const leaf = await w.item({ parentId: mid._id });
  const sub = await w.item({ parentId: leaf._id });
  return { top, mid, leaf, sub, all: [top._id, mid._id, leaf._id, sub._id] };
}

describe('archive and unarchive', () => {
  test('FR-1.2: archiving a project archives its three levels of children, and unarchiving restores them', async () => {
    const w = await world();
    const c = await chain(w);
    const other = await w.item({ title: 'Other' });

    expect((await w.act('O', 'archive', c.top._id)).statusCode).toBe(204);
    for (const id of c.all) expect((await w.stored(id))!.archived).toBe(true);
    expect((await w.stored(other._id))!.archived).toBe(false);
    expect((await w.stored(c.sub._id))!.version).toBe(1); // no version bump

    expect((await w.act('O', 'unarchive', c.top._id)).statusCode).toBe(204);
    for (const id of c.all) expect((await w.stored(id))!.archived).toBe(false);
    // The item goes last among its siblings; its descendants keep their ranks.
    expect(await w.ranks([other._id, c.top._id])).toEqual([0, 1]);
    expect(await w.ranks([c.mid._id, c.leaf._id, c.sub._id])).toEqual([0, 0, 0]);
  });

  test('FR-1.2: archiving or unarchiving an item already in that state is a 204 with no write and no audit event', async () => {
    const w = await world();
    const live = await w.item();
    const gone = await w.item({ archived: true });
    const before = (await w.roadmapDoc())!.orderRevision ?? 0;
    expect((await w.act('O', 'unarchive', live._id)).statusCode).toBe(204);
    expect((await w.act('O', 'archive', gone._id)).statusCode).toBe(204);
    expect((await w.stored(live._id))!.archived).toBe(false);
    expect((await w.stored(gone._id))!.archived).toBe(true);
    expect((await w.roadmapDoc())!.orderRevision ?? 0).toBe(before);
    expect([...(await w.events('project.archive')), ...(await w.events('project.unarchive'))]).toHaveLength(0);
  });

  test('unarchiving a child of an archived parent returns 409 parent_archived', async () => {
    const w = await world();
    const c = await chain(w);
    await w.act('O', 'archive', c.top._id);
    const res = await w.act('O', 'unarchive', c.mid._id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'parent_archived' });
    expect((await w.stored(c.mid._id))!.archived).toBe(true);
    expect((await w.stored(c.sub._id))!.archived).toBe(true);
  });

  test('sibling ranks close up after an archive and after a delete', async () => {
    const w = await world();
    const [a, b, c, d] = [await w.item(), await w.item(), await w.item(), await w.item()];
    const archivedAlready = await w.item({ archived: true });
    await w.act('A', 'archive', b._id);
    expect(await w.ranks([a._id, c._id, d._id])).toEqual([0, 1, 2]);
    await w.act('A', 'delete', a._id);
    expect(await w.ranks([c._id, d._id])).toEqual([0, 1]);
    expect((await w.stored(archivedAlready._id))!.rank).toBe(4); // archived siblings are not rewritten
    expect((await w.roadmapDoc())!.orderRevision).toBe(2);
  });

  test('unarchive goes after the highest non-archived sibling rank', async () => {
    const w = await world();
    const [a, b, c] = [await w.item(), await w.item(), await w.item()];
    await w.act('O', 'archive', a._id);
    await w.act('O', 'unarchive', a._id);
    expect(await w.ranks([b._id, c._id, a._id])).toEqual([0, 1, 2]);
  });
});

describe('delete', () => {
  test('Review focus 2: deleting a project deletes everything under it and returns the count', async () => {
    const w = await world();
    const c = await chain(w);
    const other = await w.item();
    const res = await w.act('O', 'delete', c.top._id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 4 });
    for (const id of c.all) expect(await w.stored(id)).toBeNull();
    expect(await w.stored(other._id)).not.toBeNull();
  });

  test('Review focus 2: deleting an item removes it from other items\' blockedBy lists', async () => {
    const w = await world();
    const c = await chain(w);
    const keep = await w.item({ title: 'Keep' });
    const blocked = await w.item({ title: 'Blocked' });
    await w.projects().updateOne({ _id: blocked._id }, { $set: { blockedBy: [c.sub._id, keep._id, c.top._id] } });
    await w.projects().updateOne({ _id: keep._id }, { $set: { blockedBy: [c.leaf._id] } });
    const revision = (await w.roadmapDoc())!.dependencyRevision ?? 0;

    await w.act('O', 'delete', c.top._id);
    const after = await w.stored(blocked._id);
    expect(after!.blockedBy).toEqual([keep._id]);
    expect(after!.version).toBe(1); // the pull does not bump version
    expect((await w.stored(keep._id))!.blockedBy).toEqual([]);
    expect((await w.roadmapDoc())!.dependencyRevision).toBe(revision + 1);

    // Deleting something nobody depends on leaves dependencyRevision alone.
    await w.act('O', 'delete', blocked._id);
    expect((await w.roadmapDoc())!.dependencyRevision).toBe(revision + 2); // every delete bumps it
  });

  test('Review focus 2: deleting never touches another roadmap\'s items', async () => {
    const w = await world();
    const other = await t.seed.roadmap(w.tenantId, w.ids.O);
    const mine = await w.item();
    const theirs = await w.item({ roadmapId: other._id });
    await w.projects().updateOne({ _id: theirs._id }, { $set: { blockedBy: [mine._id] } });
    await w.act('O', 'delete', mine._id);
    expect((await w.stored(theirs._id))!.blockedBy).toEqual([mine._id]);
    expect((await w.act('O', 'delete', theirs._id)).statusCode).toBe(404); // wrong roadmap in the URL
    expect(await w.stored(theirs._id)).not.toBeNull();
  });
});

describe('access', () => {
  test.each(['archive', 'unarchive', 'delete'] as const)('Permissions (project.delete): %s', async (action) => {
    const w = await world();
    const setup = async (assigneeIds: string[] = [], parentAssignees: string[] = []) => {
      const parent = await w.item({ assigneeIds: parentAssignees });
      const child = await w.item({ parentId: parent._id, assigneeIds, archived: action === 'unarchive' });
      return child._id;
    };
    for (const who of ['O', 'A'] as const) {
      expect([who, (await w.act(who, action, await setup())).statusCode]).toEqual([who, action === 'delete' ? 200 : 204]);
    }
    const free = await setup();
    expect((await w.act('C', action, free)).statusCode).toBe(403);
    expect(await w.stored(free)).not.toBeNull();
    expect((await w.stored(free))!.archived).toBe(action === 'unarchive');
    const own = await setup([w.ids.C]);
    expect((await w.act('C', action, own)).statusCode).toBe(action === 'delete' ? 200 : 204);
    const viaParent = await setup([], [w.ids.C]);
    expect((await w.act('C', action, viaParent)).statusCode).toBe(action === 'delete' ? 200 : 204);
  });

  test.each(['archive', 'unarchive', 'delete'] as const)(
    'Permissions (project.delete): a Contributor assigned only to a child gets 403 on %s of the parent',
    async (action) => {
      const w = await world();
      const parent = await w.item({ archived: action === 'unarchive' });
      await w.item({ parentId: parent._id, assigneeIds: [w.ids.C], archived: action === 'unarchive' });
      expect((await w.act('C', action, parent._id)).statusCode).toBe(403);
      expect(await w.stored(parent._id)).not.toBeNull();
      expect((await w.stored(parent._id))!.archived).toBe(action === 'unarchive');
    },
  );

  test('Tenant isolation: another tenant, and another roadmap, get 404', async () => {
    const w = await world();
    const mine = await w.item({ archived: true });
    const stranger = await t.seed.user((await t.seed.tenant('Other'))._id);
    const sess = await signInAs(t.app, t.db, stranger._id);
    const otherRoadmap = await t.seed.roadmap(w.tenantId, w.ids.O);
    for (const action of ['archive', 'unarchive', 'delete'] as const) {
      const foreign = await t.app.inject({
        method: action === 'delete' ? 'DELETE' : 'POST',
        url: `/api/roadmaps/${w.roadmap._id}/projects/${mine._id}${action === 'delete' ? '' : `/${action}`}`,
        headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf },
      });
      expect([action, foreign.statusCode]).toEqual([action, 404]);
      expect([action, (await w.act('O', action, mine._id, otherRoadmap._id)).statusCode]).toEqual([action, 404]);
    }
    expect((await w.stored(mine._id))!.archived).toBe(true);
  });
});

describe('audit', () => {
  test('archive, unarchive and delete are each audited with the title', async () => {
    const w = await world();
    const c = await chain(w);
    await w.act('A', 'archive', c.top._id);
    await w.act('A', 'unarchive', c.top._id);
    await w.act('A', 'delete', c.top._id);
    const target = { type: 'project', id: c.top._id };
    const [archive] = await w.events('project.archive');
    const [unarchive] = await w.events('project.unarchive');
    const [del] = await w.events('project.delete');
    expect(archive).toMatchObject({ target, actor: { userId: w.ids.A }, after: { title: 'Top', count: 4 } });
    expect(unarchive).toMatchObject({ target, after: { title: 'Top', count: 4 } });
    expect(del).toMatchObject({ target, before: { title: 'Top', count: 4 } });
  });
});

describe('races', () => {
  const ROUNDS = 8;
  const DANGLING_PAIRS = 20;
  const TIMEOUT = 30_000; // conflicting transactions retry, which is slow on a loaded runner

  test("Review focus 2: an edit that adds a blocker racing that blocker's deletion never leaves a dangling id", async () => {
    const w = await world();
    // Many pairs at once, so the two transactions of at least some pairs overlap.
    // Every Y ranks before every X, so closing the rank gap after a delete never writes a Y: the only shared
    // write between a pair is the roadmap document.
    const ys = [];
    for (let i = 0; i < DANGLING_PAIRS; i++) ys.push(await w.item({ title: 'Y' }));
    const pairs = [];
    for (const y of ys) pairs.push({ x: await w.item({ title: 'X' }), y });
    const results = await Promise.all(
      pairs.map(({ x, y }) =>
        Promise.all([
          t.app.inject({
            method: 'PATCH',
            url: `/api/roadmaps/${w.roadmap._id}/projects/${y._id}`,
            headers: { cookie: w.sess.O.cookie, 'x-csrf-token': w.sess.O.csrf },
            payload: { version: 1, blockedBy: [x._id] },
          }),
          w.act('O', 'delete', x._id),
        ]),
      ),
    );
    for (const [i, [patch, del]] of results.entries()) {
      const { x, y } = pairs[i]!;
      expect(del.statusCode).toBe(200);
      expect([200, 422]).toContain(patch.statusCode);
      if (patch.statusCode === 422) expect(patch.json()).toEqual({ error: 'unknown_item' });
      expect(await w.stored(x._id)).toBeNull();
      expect((await w.stored(y._id))!.blockedBy).toEqual([]);
    }
  }, TIMEOUT);

  test('a create racing an archive of its parent never leaves a live child under an archived parent', async () => {
    const w = await world();
    for (let i = 0; i < ROUNDS; i++) {
      const parent = await w.item();
      const [create] = await Promise.all([w.create('O', parent._id), w.act('O', 'archive', parent._id)]);
      expect([201, 409]).toContain(create.statusCode);
      const kids = await w.projects().find({ parentId: parent._id }).toArray();
      expect((await w.stored(parent._id))!.archived).toBe(true);
      for (const kid of kids) expect(kid.archived).toBe(true);
      expect(kids).toHaveLength(create.statusCode === 201 ? 1 : 0);
    }
  }, TIMEOUT);

  test('a create racing a delete of its parent never leaves an orphan', async () => {
    const w = await world();
    for (let i = 0; i < ROUNDS; i++) {
      const parent = await w.item();
      const [create] = await Promise.all([w.create('O', parent._id), w.act('O', 'delete', parent._id)]);
      expect([201, 404]).toContain(create.statusCode);
      expect(await w.stored(parent._id)).toBeNull();
      expect(await w.projects().countDocuments({ parentId: parent._id })).toBe(0);
    }
  }, TIMEOUT);
});

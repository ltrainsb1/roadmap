import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

type Who = 'O' | 'A' | 'C';
interface Dto {
  id: string;
  title: string;
  description: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  links: Array<{ id: string; label: string; url: string }>;
  milestones: Array<{ id: string; name: string; date: string }>;
  rank: number;
  priorityLabel: string | null;
  assigneeIds: string[];
  version: number;
}
const ROLE_OF = { O: 'owner', A: 'admin', C: 'contributor' } as const;

async function world() {
  const tenantId = (await t.seed.tenant())._id;
  const ids = {} as Record<Who, string>;
  for (const w of Object.keys(ROLE_OF) as Who[]) ids[w] = (await t.seed.user(tenantId))._id;
  const roadmap = await t.seed.roadmap(tenantId, ids.O);
  await t.seed.member(tenantId, roadmap._id, ids.A, 'admin');
  await t.seed.member(tenantId, roadmap._id, ids.C, 'contributor');
  const sess = {} as Record<Who, { cookie: string; csrf: string }>;
  for (const w of Object.keys(ids) as Who[]) sess[w] = await signInAs(t.app, t.db, ids[w]);
  const patch = (who: Who, projectId: string, payload: Record<string, unknown>, roadmapId = roadmap._id) =>
    t.app.inject({
      method: 'PATCH',
      url: `/api/roadmaps/${roadmapId}/projects/${projectId}`,
      headers: { cookie: sess[who].cookie, 'x-csrf-token': sess[who].csrf },
      payload,
    });
  const list = async () =>
    (
      await t.app.inject({
        method: 'GET',
        url: `/api/roadmaps/${roadmap._id}/projects`,
        headers: { cookie: sess.O.cookie },
      })
    ).json<{ items: Dto[] }>().items;
  const stored = async (id: string) => (await list()).find((i) => i.id === id)!;
  return { tenantId, ids, roadmap, sess, patch, list, stored, db: scoped(t.db, tenantId) };
}

describe('update', () => {
  test('FR-1.4: an Admin sets title, description, status, dates, tags, links and milestones, and the list returns them', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const res = await w.patch('A', p._id, {
      version: 1,
      title: '  New title ',
      description: 'Plain text',
      status: 'in_progress',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      tags: ['alpha'],
      links: [{ label: 'Spec', url: 'https://example.com/spec' }],
      milestones: [{ name: 'Beta', date: '2026-02-01' }],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Dto>();
    expect(body).toMatchObject({
      id: p._id,
      title: 'New title',
      description: 'Plain text',
      status: 'in_progress',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      tags: ['alpha'],
      version: 2,
    });
    expect(body.links[0]!).toMatchObject({ label: 'Spec', url: 'https://example.com/spec' });
    expect(body.links[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.milestones[0]!).toMatchObject({ name: 'Beta', date: '2026-02-01' });
    expect(body.milestones[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await w.stored(p._id)).toEqual(body);
  });

  test('only the fields present change, and null clears a date', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { startDate: '2026-01-01', endDate: '2026-02-01', title: 'Keep' });
    const res = await w.patch('A', p._id, { version: 1, startDate: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Keep', startDate: null, endDate: '2026-02-01' });
  });

  test('existing link and milestone ids are kept; an unknown id is replaced', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const first = (
      await w.patch('A', p._id, {
        version: 1,
        links: [{ label: 'a', url: 'https://a.example' }],
        milestones: [{ name: 'm', date: '2026-01-01' }],
      })
    ).json<Dto>();
    const linkId = first.links[0]!.id;
    const msId = first.milestones[0]!.id;
    const second = (
      await w.patch('A', p._id, {
        version: 2,
        links: [
          { id: linkId, label: 'a2', url: 'https://a.example' },
          { id: 'made-up', label: 'b', url: 'https://b.example' },
        ],
        milestones: [{ id: msId, name: 'm', date: '2026-01-02' }],
      })
    ).json<Dto>();
    expect(second.links[0]!).toMatchObject({ id: linkId, label: 'a2' });
    expect(second.links[1]!.id).not.toBe('made-up');
    expect(second.links[1]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.milestones[0]!).toMatchObject({ id: msId, date: '2026-01-02' });
  });

  test('resending unchanged links and milestones changes nothing', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const first = (
      await w.patch('A', p._id, {
        version: 1,
        links: [{ label: 'a', url: 'https://a.example' }],
        milestones: [{ name: 'm', date: '2026-01-01' }],
      })
    ).json<Dto>();
    const res = await w.patch('A', p._id, { version: first.version, links: first.links, milestones: first.milestones });
    expect(res.statusCode).toBe(200);
    expect(res.json<Dto>().version).toBe(first.version);
    const events = await w.db.audit.find({ roadmapId: w.roadmap._id, action: 'project.update' }, { sort: { timestamp: -1 }, limit: 10 });
    expect(events).toHaveLength(1);
  });

  test('a repeated id in one request is kept once', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const first = (await w.patch('A', p._id, { version: 1, links: [{ label: 'a', url: 'https://a.example' }] })).json<Dto>();
    const id = first.links[0]!.id;
    const res = await w.patch('A', p._id, {
      version: 2,
      links: [
        { id, label: 'a', url: 'https://a.example' },
        { id, label: 'b', url: 'https://b.example' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const links = res.json<Dto>().links;
    expect(links[0]!.id).toBe(id);
    expect(links[1]!.id).not.toBe(id);
    expect(new Set(links.map((l) => l.id)).size).toBe(2);
  });

  test('Review focus 1: a stale version returns 409 conflict and the stored item is unchanged', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { title: 'Original' });
    expect((await w.patch('A', p._id, { version: 1, title: 'First' })).statusCode).toBe(200);
    const res = await w.patch('O', p._id, { version: 1, title: 'Second' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conflict' });
    expect(await w.stored(p._id)).toMatchObject({ title: 'First', version: 2 });
  });

  test('two concurrent PATCHes with the same version: exactly one returns 200', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const results = await Promise.all([
      w.patch('A', p._id, { version: 1, title: 'One' }),
      w.patch('O', p._id, { version: 1, title: 'Two' }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await w.stored(p._id)).version).toBe(2);
  });

  test('Review focus 4: an end date before the stored start date returns 422 date_order', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { startDate: '2026-05-01' });
    const res = await w.patch('A', p._id, { version: 1, endDate: '2026-04-30' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'date_order' });
    expect(await w.stored(p._id)).toMatchObject({ endDate: null, version: 1 });
  });

  test('Review focus 4: a start after the stored end date returns 422 date_order', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { endDate: '2026-05-01' });
    const res = await w.patch('A', p._id, { version: 1, startDate: '2026-05-02' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'date_order' });
  });

  test('Review focus 4: an end date before the start date, both in the request, returns 422 date_order', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const res = await w.patch('A', p._id, { version: 1, startDate: '2026-05-01', endDate: '2026-04-30' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'date_order' });
  });

  test("a child outside its parent's dates is saved", async () => {
    const w = await world();
    const parent = await t.seed.project(w.tenantId, w.roadmap._id, { startDate: '2026-01-01', endDate: '2026-01-31' });
    const child = await t.seed.project(w.tenantId, w.roadmap._id, { parentId: parent._id });
    const res = await w.patch('A', child._id, { version: 1, startDate: '2025-12-01', endDate: '2026-06-01' });
    expect(res.statusCode).toBe(200);
  });

  test('tags are stored trimmed, lower case and without duplicates', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const res = await w.patch('A', p._id, { version: 1, tags: ['  Alpha ', 'alpha', 'BETA'] });
    expect(res.statusCode).toBe(200);
    expect(res.json<Dto>().tags).toEqual(['alpha', 'beta']);
  });

  test('a link with a javascript: address returns 400', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const res = await w.patch('A', p._id, { version: 1, links: [{ label: 'x', url: 'javascript:alert(1)' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation');
  });

  test('a malformed body is 400', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    expect((await w.patch('A', p._id, { title: 'no version' })).statusCode).toBe(400);
    expect((await w.patch('A', p._id, { version: 1, title: '  ' })).statusCode).toBe(400);
  });

  test('a request carrying blockedBy returns 422 not_supported', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    const other = await t.seed.project(w.tenantId, w.roadmap._id);
    const res = await w.patch('A', p._id, { version: 1, title: 'Changed', blockedBy: [other._id] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'not_supported' });
    expect(await w.stored(p._id)).toMatchObject({ title: 'Item', version: 1 });
  });
});

describe('Permissions (project.edit)', () => {
  test.each(['O', 'A'] as const)('%s gets 200', async (who) => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    expect((await w.patch(who, p._id, { version: 1, title: 'x' })).statusCode).toBe(200);
  });

  test('a Contributor gets 403 when not assigned', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id);
    expect((await w.patch('C', p._id, { version: 1, title: 'x' })).statusCode).toBe(403);
    expect(await w.stored(p._id)).toMatchObject({ title: 'Item', version: 1 });
  });

  test('a Contributor gets 200 when assigned to the item', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    expect((await w.patch('C', p._id, { version: 1, title: 'x' })).statusCode).toBe(200);
  });

  test('a Contributor gets 200 when assigned to its parent', async () => {
    const w = await world();
    const parent = await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    const child = await t.seed.project(w.tenantId, w.roadmap._id, { parentId: parent._id });
    expect((await w.patch('C', child._id, { version: 1, title: 'x' })).statusCode).toBe(200);
  });

  test('a Contributor cannot change rank, priorityLabel or assigneeIds through PATCH', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    const before = await w.stored(p._id);
    const res = await w.patch('C', p._id, {
      version: 1,
      title: 'x',
      rank: 9,
      priorityLabel: 'P1',
      assigneeIds: [w.ids.O],
    });
    expect(res.statusCode).toBe(200);
    const after = await w.stored(p._id);
    expect(after).toMatchObject({ rank: before.rank, priorityLabel: null, assigneeIds: [w.ids.C] });
  });

  test('a Contributor assigned in roadmap A and a Contributor in roadmap B cannot edit an unassigned item in B by naming it', async () => {
    const w = await world();
    const assignedInA = await t.seed.project(w.tenantId, w.roadmap._id, { assigneeIds: [w.ids.C] });
    const roadmapB = await t.seed.roadmap(w.tenantId, w.ids.O, 'B');
    await t.seed.member(w.tenantId, roadmapB._id, w.ids.C, 'contributor');
    const inB = await t.seed.project(w.tenantId, roadmapB._id);
    expect((await w.patch('C', assignedInA._id, { version: 1, title: 'ok' })).statusCode).toBe(200);
    const res = await w.patch('C', inB._id, { version: 1, title: 'x' }, roadmapB._id);
    expect(res.statusCode).toBe(403);
    // Naming B's item under A's roadmap id finds nothing.
    expect((await w.patch('C', inB._id, { version: 1, title: 'x' })).statusCode).toBe(404);
  });
});

describe('Tenant isolation', () => {
  test('another tenant, and another roadmap in the same tenant, get 404', async () => {
    const a = await world();
    const b = await world();
    const p = await t.seed.project(a.tenantId, a.roadmap._id);
    const cross = await b.patch('O', p._id, { version: 1, title: 'x' }, a.roadmap._id);
    expect(cross.statusCode).toBe(404);
    const second = await t.seed.roadmap(a.tenantId, a.ids.O, 'Second');
    const res = await a.patch('O', p._id, { version: 1, title: 'x' }, second._id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(await a.stored(p._id)).toMatchObject({ title: 'Item', version: 1 });
  });
});

describe('Audit', () => {
  test('project.update is audited with before and after, and an unchanged PATCH writes nothing', async () => {
    const w = await world();
    const p = await t.seed.project(w.tenantId, w.roadmap._id, { title: 'Launch', startDate: '2026-01-01' });
    const res = await w.patch('A', p._id, { version: 1, status: 'done', tags: ['x'], startDate: '2026-01-01' });
    expect(res.statusCode).toBe(200);
    const events = await w.db.audit.find({ roadmapId: w.roadmap._id, action: 'project.update' }, { sort: { timestamp: -1 }, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: 'user', userId: w.ids.A },
      target: { type: 'project', id: p._id },
      before: { title: 'Launch', status: 'not_started', tags: [] },
      after: { title: 'Launch', status: 'done', tags: ['x'] },
    });
    expect(Object.keys(events[0]!.after as object).sort()).toEqual(['status', 'tags', 'title']);

    const same = await w.patch('A', p._id, { version: 2, status: 'done', tags: ['x'], title: 'Launch' });
    expect(same.statusCode).toBe(200);
    expect(same.json<Dto>().version).toBe(2);
    expect(await w.db.audit.find({ roadmapId: w.roadmap._id, action: 'project.update' }, { sort: { timestamp: -1 }, limit: 10 })).toHaveLength(1);
    expect(await w.stored(p._id)).toMatchObject({ version: 2 });
  });
});

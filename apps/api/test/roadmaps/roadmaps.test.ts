import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

let t: TestApp;
let tenantId: string;

beforeAll(async () => {
  t = await makeTestApp();
  tenantId = (await t.seed.tenant())._id;
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const newUser = () => t.seed.user(tenantId, { password: 'correct horse battery' });
const create = (s: { cookie: string; csrf: string } | null, payload: unknown) =>
  t.app.inject({
    method: 'POST',
    url: '/api/roadmaps',
    headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {},
    payload: payload as Record<string, unknown>,
  });
const list = (cookie?: string) =>
  t.app.inject({ url: '/api/roadmaps', headers: cookie ? { cookie } : {} });

describe('roadmaps (FR-1.1)', () => {
  test('FR-1.1: creating a roadmap makes the caller its owner and it appears in GET /api/roadmaps', async () => {
    const u = await newUser();
    const sess = await signInAs(t.app, t.db, u._id);
    const res = await create(sess, { name: 'Q1 plan', description: 'Things we do' });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    const s = scoped(t.db, tenantId);
    expect(await s.collection('roadmaps').findOne({ _id: id })).toMatchObject({
      name: 'Q1 plan',
      description: 'Things we do',
      ownerId: u._id,
      archived: false,
    });
    expect(await s.collection('memberships').findOne({ roadmapId: id, userId: u._id })).toMatchObject({ role: 'owner' });
    expect((await list(sess.cookie)).json()).toEqual([{ roadmapId: id, roadmapName: 'Q1 plan', role: 'owner' }]);
    const audit = await s.audit.find({ action: 'roadmap.create', roadmapId: id }, { sort: { timestamp: 1 }, limit: 5 });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: { type: 'user', userId: u._id }, target: { type: 'roadmap', id } });
  });

  test('description is optional and defaults to empty', async () => {
    const u = await newUser();
    const sess = await signInAs(t.app, t.db, u._id);
    const { id } = (await create(sess, { name: 'No description' })).json<{ id: string }>();
    expect((await scoped(t.db, tenantId).collection('roadmaps').findOne({ _id: id }))!.description).toBe('');
  });

  test('name must be 1 to 120 characters and description at most 2000', async () => {
    const sess = await signInAs(t.app, t.db, (await newUser())._id);
    expect((await create(sess, { name: '' })).statusCode).toBe(400);
    expect((await create(sess, { name: '   ' })).statusCode).toBe(400);
    expect((await create(sess, { name: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await create(sess, { name: 'x'.repeat(120) })).statusCode).toBe(201);
    expect((await create(sess, { name: 'ok', description: 'd'.repeat(2001) })).statusCode).toBe(400);
  });

  test('archived roadmaps are not listed', async () => {
    const u = await newUser();
    const sess = await signInAs(t.app, t.db, u._id);
    const { id } = (await create(sess, { name: 'Old' })).json<{ id: string }>();
    await scoped(t.db, tenantId).collection('roadmaps').updateOne({ _id: id }, { $set: { archived: true } });
    expect((await list(sess.cookie)).json()).toEqual([]);
  });

  test('Tenant isolation: GET /api/roadmaps never lists another tenant roadmaps', async () => {
    const u = await newUser();
    const other = await t.seed.tenant('Other');
    const ou = await t.seed.user(other._id);
    await t.seed.roadmap(other._id, ou._id, 'Theirs');
    const sess = await signInAs(t.app, t.db, u._id);
    await create(sess, { name: 'Mine' });
    const names = (await list(sess.cookie)).json<Array<{ roadmapName: string }>>().map((m) => m.roadmapName);
    expect(names).toEqual(['Mine']);
  });

  test('a member sees the roadmaps they belong to with their role', async () => {
    const owner = await newUser();
    const u = await newUser();
    const rm = await t.seed.roadmap(tenantId, owner._id, 'Shared');
    await t.seed.member(tenantId, rm._id, u._id, 'contributor');
    const sess = await signInAs(t.app, t.db, u._id);
    expect((await list(sess.cookie)).json()).toEqual([{ roadmapId: rm._id, roadmapName: 'Shared', role: 'contributor' }]);
  });

  test('without a session both routes are 401', async () => {
    expect((await create(null, { name: 'x' })).statusCode).toBe(401);
    expect((await list()).statusCode).toBe(401);
  });

  test('creating needs the CSRF token', async () => {
    const sess = await signInAs(t.app, t.db, (await newUser())._id);
    const res = await create({ ...sess, csrf: 'wrong' }, { name: 'x' });
    expect(res.statusCode).toBe(403);
  });
});

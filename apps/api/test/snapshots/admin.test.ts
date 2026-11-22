import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SnapshotSummary } from '@roadmap/shared';
import { scoped } from '../../src/db/scoped.ts';
import type { AuditEventDoc, SnapshotDoc, UserDoc } from '../../src/db/types.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { PASSWORD, world } from './world.ts';

const DAY_MS = 86_400_000;
const FIXED = new Date('2026-03-10T23:30:00.000Z');

let t: TestApp;
let clocked: TestApp;
let limited: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
  clocked = await makeTestApp({ now: () => FIXED });
  limited = await makeTestApp({ maxSnapshots: 2, maxSnapshotNotes: 3 });
}, 120_000);
afterAll(async () => {
  await t?.close();
  await clocked?.close();
  await limited?.close();
});

const events = (app: TestApp, tenantId: string, action: string) =>
  app.db.collection<AuditEventDoc>('auditEvents').find({ tenantId, action }).toArray();

/** How many snapshot, frozen item and frozen note rows a roadmap has. */
async function rowCounts(app: TestApp, roadmapId: string) {
  return {
    snapshots: await app.db.collection('snapshots').countDocuments({ roadmapId }),
    items: await app.db.collection('snapshotItems').countDocuments({ roadmapId }),
    notes: await app.db.collection('snapshotNotes').countDocuments({ roadmapId }),
  };
}

/** Gives the snapshot a stored list PDF and a viewer session; returns the PDF's key. */
async function addPdfAndSession(app: TestApp, tenantId: string, snapshotId: string): Promise<string> {
  const key = `${tenantId}/snapshots/${snapshotId}/list.pdf`;
  await app.files.put(key, Buffer.from('%PDF-1.7'));
  await app.db.collection<SnapshotDoc>('snapshots').updateOne({ _id: snapshotId }, { $set: { 'pdfs.list': key } });
  await scoped(app.db, tenantId)
    .collection('snapshotSessions')
    .insertOne({
      _id: `session-${snapshotId}`,
      snapshotId,
      tokenHash: `hash-${snapshotId}`,
      kind: 'viewer',
      expiresAt: new Date(Date.now() + DAY_MS),
    });
  return key;
}

describe('creating', () => {
  test('FR-3.2: the password is stored only as an argon2 hash', async () => {
    const w = await world(t);
    await w.item();
    const expiresAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const res = await w.create('A', { expiresAt, include: { notes: true, assignees: false } });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PASSWORD);
    const { id, linkId } = res.json<{ id: string; linkId: string }>();

    const doc = (await w.snapshot(id))!;
    expect(doc.passwordHash.startsWith('$argon2')).toBe(true);
    expect(doc.expiresAt).toEqual(new Date(expiresAt));
    expect(JSON.stringify(doc)).not.toContain(PASSWORD);

    const [event, ...more] = await events(t, w.tenantId, 'snapshot.create');
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actor: { type: 'user', userId: w.ids.A },
      roadmapId: w.roadmap._id,
      target: { type: 'snapshot', id },
      after: { name: 'Board review', asOf: doc.asOf, include: { notes: true, assignees: false }, expiresAt },
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(doc.passwordHash);
    expect(text).not.toContain(linkId);
  });

  test('FR-3.1: asOf may be today or earlier, and tomorrow by UTC, but not later', async () => {
    const w = await world(clocked);
    for (const asOf of ['2026-03-10', '2020-02-29', '2026-03-11']) {
      const res = await w.create('A', { asOf });
      expect(res.statusCode, asOf).toBe(201);
      expect((await w.snapshot(res.json<{ id: string }>().id))!.asOf).toBe(asOf);
    }
    const late = await w.create('A', { asOf: '2026-03-12' });
    expect(late.statusCode).toBe(422);
    expect(late.json()).toEqual({ error: 'as_of_in_future' });
    expect((await rowCounts(clocked, w.roadmap._id)).snapshots).toBe(3);
  });

  test('FR-3.2: an expiry in the past or more than 730 days away is refused', async () => {
    const w = await world(clocked);
    const at = (ms: number) => new Date(FIXED.getTime() + ms).toISOString();
    const make = (expiresAt: string) => w.create('A', { asOf: '2026-03-10', expiresAt });
    for (const expiresAt of [at(-60_000), at(0)]) {
      const res = await make(expiresAt);
      expect(res.statusCode, expiresAt).toBe(422);
      expect(res.json()).toEqual({ error: 'expiry_in_past' });
    }
    const far = await make(at(730 * DAY_MS + 1000));
    expect(far.statusCode).toBe(422);
    expect(far.json()).toEqual({ error: 'expiry_too_far' });
    expect((await rowCounts(clocked, w.roadmap._id)).snapshots).toBe(0);

    expect((await make(at(730 * DAY_MS))).statusCode).toBe(201);
    // The end of a day in the Admin's own time zone, sent with its offset.
    expect((await make('2026-03-12T23:59:59.999+02:00')).statusCode).toBe(201);
  });

  test('FR-3.1: the 51st snapshot is refused', async () => {
    const w = await world(limited);
    await w.item();
    await w.createId();
    await w.createId();
    const before = await rowCounts(limited, w.roadmap._id);
    expect(before).toEqual({ snapshots: 2, items: 2, notes: 0 });

    const res = await w.create('A');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_many_snapshots' });
    expect(await rowCounts(limited, w.roadmap._id)).toEqual(before);
    expect(await events(limited, w.tenantId, 'snapshot.create')).toHaveLength(2);
  });

  test('FR-3.5: more notes than the limit is refused unless notes are left out', async () => {
    const w = await world(limited);
    const item = await w.item();
    for (let i = 0; i < 3; i += 1) await w.note(item._id, w.ids.A);
    await w.createId({ include: { notes: true, assignees: true } });
    await w.note(item._id, w.ids.A);
    const before = await rowCounts(limited, w.roadmap._id);
    expect(before).toEqual({ snapshots: 1, items: 1, notes: 3 });

    const res = await w.create('A', { include: { notes: true, assignees: false } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'too_many_notes' });
    expect(await rowCounts(limited, w.roadmap._id)).toEqual(before);

    const without = await w.create('A', { include: { notes: false, assignees: true } });
    expect(without.statusCode).toBe(201);
    expect(await rowCounts(limited, w.roadmap._id)).toEqual({ snapshots: 2, items: 2, notes: 3 });
  });
});

describe('listing', () => {
  test('FR-3.2: the list never returns the password hash', async () => {
    const w = await world(t);
    await w.item();
    const first = await w.createId({ name: 'First' });
    const second = await w.createId({ name: 'Second', include: { notes: true, assignees: false } });
    await t.db.collection<SnapshotDoc>('snapshots').updateOne({ _id: first }, { $set: { createdBy: w.ids.O } });

    const res = await w.call('O', 'GET', '/snapshots');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('$argon2');
    expect(res.body).not.toContain('passwordHash');
    const { snapshots } = res.json<{ snapshots: SnapshotSummary[] }>();
    expect(snapshots.map((s) => s.name)).toEqual(['Second', 'First']);
    const doc = (await w.snapshot(second))!;
    expect(snapshots[0]).toEqual({
      id: second,
      linkId: doc.linkId,
      name: 'Second',
      asOf: doc.asOf,
      createdAt: doc.createdAt.toISOString(),
      createdByName: 'Ann Admin',
      expiresAt: null,
      include: { notes: true, assignees: false },
      itemCount: 1,
      noteCount: 0,
      lockedUntil: null,
      openCount: 0,
      lastOpenedAt: null,
    });
    expect(snapshots[1]!.createdByName).toBe('Olive Owner');

    await t.db.collection<UserDoc>('users').deleteOne({ _id: w.ids.A });
    const after = (await w.call('O', 'GET', '/snapshots')).json<{ snapshots: SnapshotSummary[] }>();
    expect(after.snapshots.map((s) => s.createdByName)).toEqual([null, 'Olive Owner']);
  });
});

describe('revoking', () => {
  test('FR-3.2: revoking deletes the snapshot, its items, notes and sessions, and its stored PDFs', async () => {
    const w = await world(t);
    const item = await w.item();
    await w.note(item._id, w.ids.A);
    const id = await w.createId({ include: { notes: true, assignees: true } });
    const keep = await w.createId({ name: 'Keep', include: { notes: true, assignees: true } });
    const key = await addPdfAndSession(t, w.tenantId, id);
    const keptKey = await addPdfAndSession(t, w.tenantId, keep);

    // Another roadmap's snapshot can't be revoked through this one.
    const elsewhere = await t.seed.roadmap(w.tenantId, w.ids.O, 'Elsewhere');
    await t.seed.member(w.tenantId, elsewhere._id, w.ids.A, 'admin');
    const foreign = await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${elsewhere._id}/snapshots`,
      headers: w.headers('A'),
      payload: { name: 'Other', asOf: '2026-01-01', password: PASSWORD, expiresAt: null, include: { notes: false, assignees: false } },
    });
    expect(foreign.statusCode).toBe(201);
    for (const missing of [foreign.json<{ id: string }>().id, 'no-such-snapshot']) {
      const res = await w.call('A', 'DELETE', `/snapshots/${missing}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }

    const res = await w.call('A', 'DELETE', `/snapshots/${id}`);
    expect(res.statusCode).toBe(204);
    expect(await w.snapshot(id)).toBeNull();
    expect(await w.frozenItems(id)).toEqual([]);
    expect(await w.frozenNotes(id)).toEqual([]);
    expect(await t.db.collection('snapshotSessions').countDocuments({ snapshotId: id })).toBe(0);
    expect(t.files.objects.has(key)).toBe(false);

    expect(await w.snapshot(keep)).not.toBeNull();
    expect(await w.frozenItems(keep)).toHaveLength(1);
    expect(await w.frozenNotes(keep)).toHaveLength(1);
    expect(await t.db.collection('snapshotSessions').countDocuments({ snapshotId: keep })).toBe(1);
    expect(t.files.objects.has(keptKey)).toBe(true);
    expect(await w.snapshot(foreign.json<{ id: string }>().id)).not.toBeNull();

    const revoked = await events(t, w.tenantId, 'snapshot.revoke');
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      actor: { type: 'user', userId: w.ids.A },
      roadmapId: w.roadmap._id,
      target: { type: 'snapshot', id },
      before: { name: 'Board review' },
    });
    expect((await w.call('A', 'DELETE', `/snapshots/${id}`)).statusCode).toBe(404);
  });

  test('FR-3.2: deleting the roadmap deletes its snapshots and their stored PDFs', async () => {
    const w = await world(t);
    const item = await w.item();
    await w.note(item._id, w.ids.A);
    const ids = [await w.createId({ include: { notes: true, assignees: true } }), await w.createId()];
    const keys = [];
    for (const id of ids) keys.push(await addPdfAndSession(t, w.tenantId, id));

    const other = await t.seed.roadmap(w.tenantId, w.ids.O, 'Other');
    const otherSnapshot = await t.app.inject({
      method: 'POST',
      url: `/api/roadmaps/${other._id}/snapshots`,
      headers: w.headers('O'),
      payload: { name: 'Other', asOf: '2026-01-01', password: PASSWORD, expiresAt: null, include: { notes: false, assignees: false } },
    });
    expect(otherSnapshot.statusCode).toBe(201);
    const otherKey = await addPdfAndSession(t, w.tenantId, otherSnapshot.json<{ id: string }>().id);

    const res = await w.call('O', 'DELETE', '', { confirmName: 'Launch plan' });
    expect(res.statusCode).toBe(204);
    expect(await rowCounts(t, w.roadmap._id)).toEqual({ snapshots: 0, items: 0, notes: 0 });
    expect(await t.db.collection('snapshotSessions').countDocuments({ snapshotId: { $in: ids } })).toBe(0);
    for (const key of keys) expect(t.files.objects.has(key)).toBe(false);

    expect((await rowCounts(t, other._id)).snapshots).toBe(1);
    expect(t.files.objects.has(otherKey)).toBe(true);
  });
});

describe('who may', () => {
  test("FR-3.1: a Contributor can't list, create or revoke snapshots", async () => {
    const w = await world(t);
    const id = await w.createId();
    for (const res of [
      await w.call('C', 'GET', '/snapshots'),
      await w.create('C'),
      await w.call('C', 'DELETE', `/snapshots/${id}`),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    }
    expect(await rowCounts(t, w.roadmap._id)).toMatchObject({ snapshots: 1 });
  });

  test("Tenant isolation: another tenant's Admin can't list, create in, or revoke from this roadmap", async () => {
    const w = await world(t);
    await w.item();
    const id = await w.createId();
    const before = await rowCounts(t, w.roadmap._id);
    const stranger = await world(t);
    const url = `/api/roadmaps/${w.roadmap._id}/snapshots`;
    const payload = { name: 'Mine', asOf: '2026-01-01', password: PASSWORD, expiresAt: null, include: { notes: false, assignees: false } };
    for (const res of [
      await t.app.inject({ method: 'GET', url, headers: stranger.headers('A') }),
      await t.app.inject({ method: 'POST', url, headers: stranger.headers('A'), payload }),
      await t.app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: stranger.headers('A') }),
      // Its own roadmap's URL with this snapshot's id.
      await stranger.call('A', 'DELETE', `/snapshots/${id}`),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    expect(await rowCounts(t, w.roadmap._id)).toEqual(before);
    expect(await w.snapshot(id)).not.toBeNull();
    expect(await events(t, stranger.tenantId, 'snapshot.create')).toEqual([]);
  });
});

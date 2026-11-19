import type { Db, MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAuditLog, type AuditInput } from '../../src/audit/audit.ts';
import { connectDb } from '../../src/db/client.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { scoped } from '../../src/db/scoped.ts';
import { startMongo, type TestMongo } from '../helpers.ts';

let mongo: TestMongo;
let client: MongoClient;
let db: Db;
const audit = createAuditLog();

beforeAll(async () => {
  mongo = startMongo();
  ({ client, db } = await connectDb(mongo.uri, 'audit_test'));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await db.dropDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  action: 'roadmap.create',
  actor: { type: 'user', userId: 'u1' },
  roadmapId: 'R1',
  target: { type: 'roadmap', id: 'R1' },
  ip: '127.0.0.1',
  ...over,
});

const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });

describe('audit log', () => {
  test('Audit log: record then list newest first with cursor paging', async () => {
    const s = scoped(db, 'A');
    for (const n of [1, 2, 3]) {
      at(`2026-01-0${n}T00:00:00Z`);
      await audit.record(s, input({ target: { type: 'roadmap', id: `t${n}` } }));
    }
    vi.useRealTimers();

    const page1 = await audit.list(s, { roadmapId: 'R1', limit: 2 });
    expect(page1.items.map((e) => e.target.id)).toEqual(['t3', 't2']);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = await audit.list(s, { roadmapId: 'R1', limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((e) => e.target.id)).toEqual(['t1']);
    expect(page2.nextCursor).toBeNull();
  });

  test('Audit log: events with an identical timestamp page without loss or repeats', async () => {
    const s = scoped(db, 'A');
    at('2026-01-01T00:00:00Z');
    for (const n of [1, 2, 3]) await audit.record(s, input({ target: { type: 'roadmap', id: `t${n}` } }));
    vi.useRealTimers();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await audit.list(s, { roadmapId: 'R1', limit: 1, cursor });
      seen.push(...r.items.map((e) => e.target.id));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['t3', 't2', 't1']);
  });

  test('Audit log: filters by action, actor and date range', async () => {
    const s = scoped(db, 'A');
    at('2026-01-01T00:00:00Z');
    await audit.record(s, input({ action: 'invite.create', target: { type: 'invite', id: 'i1' } }));
    at('2026-01-05T00:00:00Z');
    await audit.record(
      s,
      input({ action: 'member.remove', actor: { type: 'user', userId: 'u2' }, target: { type: 'user', id: 'x' } }),
    );
    at('2026-01-09T00:00:00Z');
    await audit.record(s, input({ action: 'invite.create', target: { type: 'invite', id: 'i3' } }));
    vi.useRealTimers();

    const ids = async (q: Parameters<typeof audit.list>[1]) =>
      (await audit.list(s, q)).items.map((e) => e.target.id);

    expect(await ids({ roadmapId: 'R1', action: 'invite.create' })).toEqual(['i3', 'i1']);
    expect(await ids({ roadmapId: 'R1', actorId: 'u2' })).toEqual(['x']);
    expect(
      await ids({ roadmapId: 'R1', from: new Date('2026-01-03T00:00:00Z'), to: new Date('2026-01-07T00:00:00Z') }),
    ).toEqual(['x']);
    expect(await ids({ roadmapId: 'R1', from: new Date('2026-01-05T00:00:00Z') })).toEqual(['i3', 'x']);
  });

  test('Audit log: list is scoped to tenant and roadmap', async () => {
    await audit.record(scoped(db, 'A'), input({ target: { type: 'roadmap', id: 'a-r1' } }));
    await audit.record(scoped(db, 'A'), input({ roadmapId: 'R2', target: { type: 'roadmap', id: 'a-r2' } }));
    await audit.record(scoped(db, 'B'), input({ target: { type: 'roadmap', id: 'b-r1' } }));

    const a = await audit.list(scoped(db, 'A'), { roadmapId: 'R1' });
    expect(a.items.map((e) => e.target.id)).toEqual(['a-r1']);
    const b = await audit.list(scoped(db, 'B'), { roadmapId: 'R1' });
    expect(b.items.map((e) => e.target.id)).toEqual(['b-r1']);
  });

  test('Audit log: secrets are stripped from before/after at any depth', async () => {
    const s = scoped(db, 'A');
    const after = { name: 'x', passwordHash: 'h', nested: { tokenHash: 't', keep: 1, list: [{ passkeys: [1], ok: true }] } };
    await audit.record(s, input({ before: { totp: 'secret', recoveryCodes: ['a'], role: 'viewer' }, after }));

    const [e] = (await audit.list(s, { roadmapId: 'R1' })).items;
    expect(e!.after).toEqual({ name: 'x', nested: { keep: 1, list: [{ ok: true }] } });
    expect(e!.before).toEqual({ role: 'viewer' });
    expect(after.passwordHash).toBe('h'); // caller's object is not mutated
  });

  test('Audit log: limit is clamped to 1..200 and defaults to 50', async () => {
    const s = scoped(db, 'A');
    for (let i = 0; i < 3; i++) await audit.record(s, input());
    expect((await audit.list(s, { roadmapId: 'R1', limit: 0 })).items).toHaveLength(1);
    expect((await audit.list(s, { roadmapId: 'R1', limit: 9999 })).items).toHaveLength(3);
    expect((await audit.list(s, { roadmapId: 'R1' })).items).toHaveLength(3);
  });

  test('Audit log: an invalid cursor throws invalid_cursor', async () => {
    const s = scoped(db, 'A');
    for (const cursor of ['!!!', Buffer.from('nope').toString('base64url'), Buffer.from('bad-date|id').toString('base64url')]) {
      await expect(audit.list(s, { roadmapId: 'R1', cursor })).rejects.toThrow('invalid_cursor');
    }
  });

  test('Audit log: ensureIndexes adds the tenant, roadmap, timestamp index', async () => {
    await ensureIndexes(db);
    const idx = await db.collection('auditEvents').indexes();
    expect(idx.some((i) => JSON.stringify(i.key) === JSON.stringify({ tenantId: 1, roadmapId: 1, timestamp: -1 }))).toBe(true);
  });
});

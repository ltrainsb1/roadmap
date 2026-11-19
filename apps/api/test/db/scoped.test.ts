import type { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { connectDb } from '../../src/db/client.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { scoped } from '../../src/db/scoped.ts';
import { unscoped } from '../../src/db/unscoped.ts';
import { startMongo, type TestMongo } from '../helpers.ts';

let mongo: TestMongo;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongo = startMongo();
  ({ client, db } = await connectDb(mongo.uri, 'scoped_test'));
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await db.dropDatabase();
});

const user = (id: string, email: string) => ({
  _id: id,
  email,
  name: 'N',
  timezone: 'UTC',
  passwordHash: null,
  failedLogins: 0,
  lockedUntil: null,
  totp: null,
  pendingTotpSecretEnc: null,
  recoveryCodes: [],
  createdAt: new Date(),
});

describe('scoped', () => {
  test('Tenant isolation: tenant B cannot read tenant A user', async () => {
    await scoped(db, 'A').collection('users').insertOne(user('u1', 'a@x.com'));
    expect(await scoped(db, 'B').collection('users').findOne({ email: 'a@x.com' })).toBeNull();
    expect(await scoped(db, 'A').collection('users').findOne({ email: 'a@x.com' })).toMatchObject({
      _id: 'u1',
      tenantId: 'A',
    });
    expect(await scoped(db, 'B').collection('users').find({})).toEqual([]);
    expect(await scoped(db, 'B').collection('users').countDocuments({})).toBe(0);
  });

  test('Tenant isolation: update and delete never cross tenants', async () => {
    await scoped(db, 'A').collection('users').insertOne(user('u1', 'a@x.com'));
    const b = scoped(db, 'B').collection('users');
    expect((await b.updateOne({ _id: 'u1' }, { $set: { name: 'Hacked' } })).matched).toBe(0);
    expect(await b.findOneAndUpdate({ _id: 'u1' }, { $set: { name: 'Hacked' } })).toBeNull();
    expect((await b.deleteOne({ _id: 'u1' })).deleted).toBe(0);
    expect((await b.deleteMany({})).deleted).toBe(0);
    const still = await scoped(db, 'A').collection('users').findOne({ _id: 'u1' });
    expect(still?.name).toBe('N');
  });

  test('Tenant isolation: $rename onto or away from tenantId is rejected', async () => {
    await scoped(db, 'A').collection('users').insertOne(user('u1', 'a@x.com'));
    const a = scoped(db, 'A').collection('users');
    for (const rename of [{ name: 'tenantId' }, { tenantId: 'x' }]) {
      const update = { $rename: rename } as never;
      await expect(a.updateOne({ _id: 'u1' }, update)).rejects.toThrow(/tenantId/);
      await expect(a.findOneAndUpdate({ _id: 'u1' }, update)).rejects.toThrow(/tenantId/);
    }
    expect(await a.findOne({ _id: 'u1' })).toMatchObject({ tenantId: 'A' });
  });

  test('update, findOneAndUpdate and delete work inside the tenant', async () => {
    const a = scoped(db, 'A').collection('users');
    await a.insertOne(user('u1', 'a@x.com'));
    await a.insertOne(user('u2', 'b@x.com'));
    expect((await a.updateOne({ _id: 'u1' }, { $set: { name: 'New' } })).matched).toBe(1);
    const updated = await a.findOneAndUpdate({ _id: 'u2' }, { $set: { name: 'Two' } });
    expect(updated?.name).toBe('Two');
    const sorted = await a.find({}, { sort: { email: -1 }, limit: 1 });
    expect(sorted.map((u) => u._id)).toEqual(['u2']);
    expect((await a.deleteOne({ _id: 'u1' })).deleted).toBe(1);
    expect((await a.deleteMany({})).deleted).toBe(1);
  });

  test('rejects a filter or doc that names another tenant', async () => {
    const b = scoped(db, 'B').collection('users');
    await expect(b.findOne({ tenantId: 'A' })).rejects.toThrow(/tenantId/);
    await expect(b.findOne({ $or: [{ tenantId: 'A' }] })).rejects.toThrow(/tenantId/);
    await expect(
      b.insertOne({ ...user('u9', 'z@x.com'), tenantId: 'A' } as never),
    ).rejects.toThrow(/tenantId/);
    await expect(b.updateOne({ _id: 'u1' }, { $set: { tenantId: 'A' } })).rejects.toThrow(/tenantId/);
    await expect(b.updateOne({ _id: 'u1' }, { $set: { tenantId: 'B' } })).rejects.toThrow(/tenantId/);
    await expect(b.updateOne({ _id: 'u1' }, { name: 'x' })).rejects.toThrow(/operators/);
    await expect(b.deleteMany({ tenantId: 'A' })).rejects.toThrow(/tenantId/);
    // naming its own tenant is harmless
    expect(await b.findOne({ tenantId: 'B' })).toBeNull();
  });

  test('Tenant isolation: findOneAndUpdate rejects a filter or update that names another tenant', async () => {
    await scoped(db, 'A').collection('users').insertOne(user('u1', 'a@x.com'));
    const b = scoped(db, 'B').collection('users');
    await expect(b.findOneAndUpdate({ tenantId: 'A' }, { $set: { name: 'Hacked' } })).rejects.toThrow(/tenantId/);
    await expect(b.findOneAndUpdate({ $or: [{ tenantId: 'A' }] }, { $set: { name: 'Hacked' } })).rejects.toThrow(/tenantId/);
    await expect(b.findOneAndUpdate({ _id: 'u1' }, { $set: { tenantId: 'A' } })).rejects.toThrow(/tenantId/);
    expect(await scoped(db, 'A').collection('users').findOne({ _id: 'u1' })).toMatchObject({ name: 'N', tenantId: 'A' });
  });

  test('audit collection exposes no update or delete', async () => {
    const audit = scoped(db, 'A').audit;
    expect('updateOne' in audit).toBe(false);
    expect('deleteOne' in audit).toBe(false);
    expect('deleteMany' in audit).toBe(false);
    await audit.insertOne({
      _id: 'e1',
      timestamp: new Date(),
      action: 'roadmap.create',
      actor: { type: 'system' },
      target: { type: 'roadmap', id: 'r1' },
      ip: null,
    });
    await expect(audit.insertOne({ _id: 'e2', timestamp: new Date(), tenantId: 'B' } as never)).rejects.toThrow(
      /tenantId/,
    );
    expect(await audit.find({}, { sort: { timestamp: -1 }, limit: 10 })).toHaveLength(1);
    expect(await scoped(db, 'B').audit.find({}, { sort: { timestamp: -1 }, limit: 10 })).toEqual([]);
  });

  test('withTransaction commits on success and rolls back on error, scoped to the tenant', async () => {
    const s = scoped(db, 'A');
    await s.withTransaction(async (tx) => {
      expect(tx.tenantId).toBe('A');
      await tx.collection('users').insertOne(user('u1', 'a@x.com'));
      await tx.withTransaction((inner) => inner.collection('users').insertOne(user('u2', 'b@x.com')));
    });
    expect(await s.collection('users').countDocuments({})).toBe(2);
    await expect(
      s.withTransaction(async (tx) => {
        await tx.collection('users').insertOne(user('u3', 'c@x.com'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await s.collection('users').findOne({ _id: 'u3' })).toBeNull();
  });
});

describe('unscoped', () => {
  test('pre-auth lookups, challenges and tenants', async () => {
    const un = unscoped(db);
    await un.insertTenant({ _id: 'A', name: 'Acme', createdAt: new Date() });
    await scoped(db, 'A').collection('users').insertOne(user('u1', 'a@x.com'));
    expect((await un.findUserByEmail('a@x.com'))?._id).toBe('u1');
    expect(await un.findUserByEmail('none@x.com')).toBeNull();

    const exp = new Date(Date.now() + 60_000);
    await scoped(db, 'A').collection('sessions').insertOne({
      _id: 's1', userId: 'u1', tokenHash: 'sh', state: 'full', csrfToken: 'c', createdAt: new Date(),
      lastSeenAt: new Date(), expiresAt: exp, ip: '127.0.0.1', userAgent: 'vitest',
    });
    await scoped(db, 'A').collection('invites').insertOne({
      _id: 'i1', roadmapId: 'r', email: 'n@x.com', role: 'contributor', tokenHash: 'ih', invitedBy: 'u1', expiresAt: exp, acceptedAt: null, revokedAt: null,
    });
    await scoped(db, 'A').collection('resetTokens').insertOne({ _id: 'r1', userId: 'u1', tokenHash: 'rh', expiresAt: exp, usedAt: null });
    expect((await un.findSessionByTokenHash('sh'))?._id).toBe('s1');
    expect((await un.findInviteByTokenHash('ih'))?._id).toBe('i1');
    expect((await un.findResetByTokenHash('rh'))?._id).toBe('r1');

    await un.insertChallenge({ _id: 'c1', challenge: 'ch', expiresAt: exp });
    expect((await un.takeChallenge('c1'))?._id).toBe('c1');
    expect(await un.takeChallenge('c1')).toBeNull();

    await db.collection('users').updateOne({ _id: 'u1' as never }, { $set: { passkeys: [{ credentialId: 'cred1' }] } });
    expect((await un.findUserByCredentialId('cred1'))?._id).toBe('u1');
    expect(await un.findUserByCredentialId('nope')).toBeNull();
  });
});

describe('ensureIndexes', () => {
  test('ensureIndexes creates tenant-first indexes and the audit TTL', async () => {
    await ensureIndexes(db);
    await ensureIndexes(db); // idempotent
    const names = ['users', 'memberships', 'roadmaps', 'sessions', 'invites', 'resetTokens', 'auditEvents', 'webauthnChallenges'];
    const exceptions = new Set([
      'users.email',
      'sessions.tokenHash',
      'invites.tokenHash',
      'resetTokens.tokenHash',
      'webauthnChallenges._id',
      'users.passkeys.credentialId',
    ]);
    const all: Record<string, Awaited<ReturnType<ReturnType<Db['collection']>['indexes']>>> = {};
    for (const n of names) {
      all[n] = await db.collection(n).indexes();
      for (const ix of all[n]) {
        const first = Object.keys(ix.key)[0]!;
        if (first === '_id') continue;
        // TTL indexes must be single-field, so they cannot lead with tenantId.
        if (ix.expireAfterSeconds !== undefined) continue;
        if (first === 'tenantId') continue;
        expect(exceptions.has(`${n}.${first}`), `${n} index ${JSON.stringify(ix.key)}`).toBe(true);
      }
    }
    const find = (c: string, key: Record<string, number>) =>
      all[c]!.find((i) => JSON.stringify(i.key) === JSON.stringify(key));
    expect(find('auditEvents', { timestamp: 1 })?.expireAfterSeconds).toBe(2592000);
    for (const c of ['sessions', 'resetTokens', 'webauthnChallenges']) {
      expect(find(c, { expiresAt: 1 })?.expireAfterSeconds).toBe(0);
    }
    const m = find('memberships', { tenantId: 1, roadmapId: 1, userId: 1 });
    expect(m?.unique).toBe(true);
    expect(find('users', { email: 1 })?.unique).toBe(true);
    expect(find('users', { 'passkeys.credentialId': 1 })?.sparse).toBe(true);
  });
});

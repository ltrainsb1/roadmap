import { randomUUID } from 'node:crypto';
import type { Role } from '@roadmap/shared';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { inject } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { connectDb, type Db } from '../src/db/client.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { scoped } from '../src/db/scoped.ts';
import type { MembershipDoc, RoadmapDoc, TenantDoc, UserDoc } from '../src/db/types.ts';
import { unscoped } from '../src/db/unscoped.ts';

export interface TestMongo {
  uri: string;
}

/** The MongoDB that global-setup started for this run (container or in-process); shared by every test file. */
export function startMongo(): TestMongo {
  return { uri: inject('mongoUri') };
}

export interface Seeder {
  tenant(name?: string): Promise<TenantDoc>;
  user(
    tenantId: string,
    o?: { email?: string; password?: string; totp?: boolean },
  ): Promise<UserDoc & { totpSecret?: string }>;
  /** Creates the roadmap and the owner's membership. */
  roadmap(tenantId: string, ownerId: string, name?: string): Promise<RoadmapDoc>;
  member(
    tenantId: string,
    roadmapId: string,
    userId: string,
    role: Role,
  ): Promise<MembershipDoc>;
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  seed: Seeder;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Registers extra routes before the app is ready. */
  routes?: (app: FastifyInstance) => void;
  /** Clock for the session store. */
  now?: () => Date;
  /** Replaces global fetch for the breached-password check. */
  fetch?: typeof fetch;
  /** Environment overrides, e.g. `{ HIBP_ENABLED: 'true' }`. */
  env?: Record<string, string>;
}

// Argon2id (the default algorithm) at the minimum cost the library accepts.
const SEED_HASH_PARAMS = { memoryCost: 8, timeCost: 1, parallelism: 1 } as const;

const TEST_ENV = {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://unused',
  APP_ORIGIN: 'http://localhost:5173',
  TOTP_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAILER: 'memory',
  HIBP_ENABLED: 'false',
};

export async function makeTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const mongo = startMongo();
  const dbName = `test_${randomUUID().replaceAll('-', '')}`;
  const config: Config = loadConfig({ ...TEST_ENV, ...opts.env, MONGO_URI: mongo.uri, MONGO_DB: dbName });
  const { client, db } = await connectDb(mongo.uri, dbName);
  await ensureIndexes(db);
  const app = await buildApp({
    config,
    db,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  opts.routes?.(app);

  const un = unscoped(db);
  const seed: Seeder = {
    async tenant(name = 'Acme') {
      const t: TenantDoc = { _id: uuidv7(), name, createdAt: new Date() };
      await un.insertTenant(t);
      return t;
    },
    async user(tenantId, o = {}) {
      const id = uuidv7();
      return scoped(db, tenantId).collection('users').insertOne({
        _id: id,
        email: o.email ?? `user-${id}@example.com`,
        name: 'Test User',
        timezone: 'UTC',
        // Real argon2id, but cheap: production cost would make every seeded user take ~50 ms.
        passwordHash: o.password === undefined ? null : await hash(o.password, SEED_HASH_PARAMS),
        failedLogins: 0,
        lockedUntil: null,
        // The TOTP task replaces this marker with a real encrypted secret.
        ...(o.totp ? { totp: { secretEnc: 'seeded' } } : {}),
        createdAt: new Date(),
      });
    },
    async roadmap(tenantId, ownerId, name = 'Roadmap') {
      const s = scoped(db, tenantId);
      const r = await s.collection('roadmaps').insertOne({
        _id: uuidv7(),
        name,
        createdAt: new Date(),
      });
      await s
        .collection('memberships')
        .insertOne({ _id: uuidv7(), roadmapId: r._id, userId: ownerId, role: 'owner' });
      return r;
    },
    member: (tenantId, roadmapId, userId, role) =>
      scoped(db, tenantId)
        .collection('memberships')
        .insertOne({ _id: uuidv7(), roadmapId, userId, role }),
  };

  return {
    app,
    db,
    seed,
    async close() {
      await app.close();
      await db.dropDatabase();
      await client.close();
    },
  };
}

/** Creates a full session straight through the session store; returns headers' values for requests. */
export async function signInAs(
  app: FastifyInstance,
  db: Db,
  userId: string,
): Promise<{ cookie: string; csrf: string }> {
  const user = await db.collection<UserDoc>('users').findOne({ _id: userId });
  if (!user) throw new Error(`signInAs: no user ${userId}`);
  const { token, session } = await app.sessions.create(
    scoped(db, user.tenantId),
    userId,
    'full',
    { ip: '127.0.0.1', userAgent: 'vitest' },
  );
  return { cookie: `__Host-sid=${token}`, csrf: session.csrfToken };
}

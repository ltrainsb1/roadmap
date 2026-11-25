import { randomUUID } from 'node:crypto';
import type { ProjectStatus, Role } from '@roadmap/shared';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { inject } from 'vitest';
import { authenticator } from 'otplib';
import type { PasskeyVerifiers } from '../src/auth/passkeys.ts';
import { encryptSecret } from '../src/auth/crypto.ts';
import { generateRecoveryCodes } from '../src/auth/recovery.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { connectDb, type Db } from '../src/db/client.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { scoped } from '../src/db/scoped.ts';
import type { AttachmentDoc, MembershipDoc, NoteDoc, ProjectDoc, RoadmapDoc, TenantDoc, UserDoc } from '../src/db/types.ts';
import { MemoryObjectStore, type ObjectStore } from '../src/files/object-store.ts';
import { FakeScanner, type Scanner } from '../src/files/scanner.ts';
import { FakePdfRenderer, type PdfRenderer } from '../src/snapshots/pdf-renderer.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
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
  ): Promise<UserDoc & { totpSecret?: string; plainRecoveryCodes?: string[] }>;
  /** Creates the roadmap and the owner's membership. */
  roadmap(tenantId: string, ownerId: string, name?: string): Promise<RoadmapDoc>;
  member(
    tenantId: string,
    roadmapId: string,
    userId: string,
    role: Role,
  ): Promise<MembershipDoc>;
  /** Goes through the scoped collection; computes depth, path and rank the way the create route does. */
  project(
    tenantId: string,
    roadmapId: string,
    o?: {
      parentId?: string;
      title?: string;
      assigneeIds?: string[];
      status?: ProjectStatus;
      startDate?: string;
      endDate?: string;
      archived?: boolean;
    },
  ): Promise<ProjectDoc>;
  /** A top-level note with body "Note" unless `over` says otherwise; goes through the scoped collection. */
  note(
    tenantId: string,
    roadmapId: string,
    projectId: string,
    authorId: string,
    over?: Partial<Omit<NoteDoc, 'tenantId' | 'roadmapId' | 'projectId' | 'authorId'>>,
  ): Promise<NoteDoc>;
  /**
   * Puts `body` (default "file body") in `TestApp.files` under the usual key and inserts the record; the name
   * defaults to "file.txt" and the size to the body's length.
   */
  attachment(
    tenantId: string,
    roadmapId: string,
    projectId: string,
    uploadedById: string,
    over?: Partial<Pick<AttachmentDoc, '_id' | 'name' | 'size' | 'createdAt'>> & { body?: Buffer },
  ): Promise<AttachmentDoc>;
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  /** What the app emailed. */
  mail: MemoryMailer;
  /** The app's object store, unless `objectStore` replaced it. */
  files: MemoryObjectStore;
  /** The app's virus scanner, unless `scanner` replaced it. */
  scanner: FakeScanner;
  /** The app's PDF renderer, unless `pdfRenderer` replaced it. */
  pdf: FakePdfRenderer;
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
  /** Replaces the WebAuthn verifiers (real ceremonies need a browser). */
  webauthn?: PasskeyVerifiers;
  /** Environment overrides, e.g. `{ HIBP_ENABLED: 'true' }`. */
  env?: Record<string, string>;
  /** Replaces the per-roadmap item limit. */
  maxProjectItems?: number;
  /** Replaces the per-item note limit. */
  maxNotesPerItem?: number;
  /** Replaces the memory object store the app is given (`TestApp.files` is then unused by the app). */
  objectStore?: ObjectStore;
  /** Replaces the fake scanner the app is given (`TestApp.scanner` is then unused by the app). */
  scanner?: Scanner;
  /** Replaces the per-item file limit. */
  maxFilesPerItem?: number;
  /** Replaces how many uploads the app reads at once. */
  maxConcurrentUploads?: number;
  /** Replaces how long the app waits for an upload's body. */
  uploadReadTimeoutMs?: number;
  /** Replaces the per-roadmap snapshot limit. */
  maxSnapshots?: number;
  /** Replaces the most notes one snapshot may hold. */
  maxSnapshotNotes?: number;
  /** Replaces the fake PDF renderer the app is given (`TestApp.pdf` is then unused by the app). */
  pdfRenderer?: PdfRenderer;
  /** Replaces how many PDFs the app makes at once. */
  maxPdfRenders?: number;
  /** Wraps the database the app is given (seeding still uses the plain one), so a test can pause a query. */
  wrapDb?: (db: Db) => Db;
}

// Argon2id (the default algorithm) at the minimum cost the library accepts.
const SEED_HASH_PARAMS = { memoryCost: 8, timeCost: 1, parallelism: 1 } as const;

export const TEST_TOTP_KEY = Buffer.alloc(32, 7);
export const TEST_UNSUBSCRIBE_KEY = Buffer.alloc(32, 8);

export const TEST_ENV = {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://unused',
  APP_ORIGIN: 'http://localhost:5173',
  TOTP_ENC_KEY: TEST_TOTP_KEY.toString('base64'),
  UNSUBSCRIBE_KEY: TEST_UNSUBSCRIBE_KEY.toString('base64'),
  MAILER: 'memory',
  HIBP_ENABLED: 'false',
  FILES: 'memory',
  SCANNER: 'fake',
};

export async function makeTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const mongo = startMongo();
  const dbName = `test_${randomUUID().replaceAll('-', '')}`;
  const config: Config = loadConfig({ ...TEST_ENV, ...opts.env, MONGO_URI: mongo.uri, MONGO_DB: dbName });
  const { client, db } = await connectDb(mongo.uri, dbName);
  await ensureIndexes(db);
  const mail = new MemoryMailer();
  const files = new MemoryObjectStore(config.appOrigin, opts.now);
  const scanner = new FakeScanner();
  const pdf = new FakePdfRenderer();
  const app = await buildApp({
    config,
    db: opts.wrapDb ? opts.wrapDb(db) : db,
    mailer: mail,
    objectStore: opts.objectStore ?? files,
    scanner: opts.scanner ?? scanner,
    pdfRenderer: opts.pdfRenderer ?? pdf,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.webauthn ? { webauthn: opts.webauthn } : {}),
    ...(opts.maxProjectItems !== undefined ? { maxProjectItems: opts.maxProjectItems } : {}),
    ...(opts.maxNotesPerItem !== undefined ? { maxNotesPerItem: opts.maxNotesPerItem } : {}),
    ...(opts.maxFilesPerItem !== undefined ? { maxFilesPerItem: opts.maxFilesPerItem } : {}),
    ...(opts.maxConcurrentUploads !== undefined ? { maxConcurrentUploads: opts.maxConcurrentUploads } : {}),
    ...(opts.uploadReadTimeoutMs !== undefined ? { uploadReadTimeoutMs: opts.uploadReadTimeoutMs } : {}),
    ...(opts.maxSnapshots !== undefined ? { maxSnapshots: opts.maxSnapshots } : {}),
    ...(opts.maxSnapshotNotes !== undefined ? { maxSnapshotNotes: opts.maxSnapshotNotes } : {}),
    ...(opts.maxPdfRenders !== undefined ? { maxPdfRenders: opts.maxPdfRenders } : {}),
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
      const totpSecret = o.totp ? authenticator.generateSecret(20) : undefined;
      const recovery = o.totp ? generateRecoveryCodes() : undefined;
      const doc = await scoped(db, tenantId).collection('users').insertOne({
        _id: id,
        email: o.email ?? `user-${id}@example.com`,
        name: 'Test User',
        timezone: 'UTC',
        // Real argon2id, but cheap: production cost would make every seeded user take ~50 ms.
        passwordHash: o.password === undefined ? null : await hash(o.password, SEED_HASH_PARAMS),
        failedLogins: 0,
        lockedUntil: null,
        totp: totpSecret ? { secretEnc: encryptSecret(totpSecret, TEST_TOTP_KEY), lastStep: 0 } : null,
        pendingTotpSecretEnc: null,
        recoveryCodes: (recovery?.hashes ?? []).map((hash) => ({ hash, usedAt: null })),
        createdAt: new Date(),
      });
      return {
        ...doc,
        ...(totpSecret ? { totpSecret } : {}),
        ...(recovery ? { plainRecoveryCodes: recovery.codes } : {}),
      };
    },
    async roadmap(tenantId, ownerId, name = 'Roadmap') {
      const s = scoped(db, tenantId);
      const r = await s.collection('roadmaps').insertOne({
        _id: uuidv7(),
        name,
        description: '',
        ownerId,
        archived: false,
        createdAt: new Date(),
      });
      await s
        .collection('memberships')
        .insertOne({ _id: uuidv7(), roadmapId: r._id, userId: ownerId, role: 'owner', createdAt: new Date() });
      return r;
    },
    member: (tenantId, roadmapId, userId, role) =>
      scoped(db, tenantId)
        .collection('memberships')
        .insertOne({ _id: uuidv7(), roadmapId, userId, role, createdAt: new Date() }),
    async project(tenantId, roadmapId, o = {}) {
      const s = scoped(db, tenantId);
      const parent = o.parentId ? await s.collection('projects').findOne({ _id: o.parentId, roadmapId }) : null;
      if (o.parentId && !parent) throw new Error(`seed.project: no parent ${o.parentId}`);
      const siblings = await s.collection('projects').find({ roadmapId, parentId: parent?._id ?? null });
      const now = new Date();
      return s.collection('projects').insertOne({
        _id: uuidv7(),
        roadmapId,
        parentId: parent?._id ?? null,
        depth: ((parent?.depth ?? 0) + 1) as ProjectDoc['depth'],
        path: parent ? [...parent.path, parent._id] : [],
        title: o.title ?? 'Item',
        description: '',
        status: o.status ?? 'not_started',
        startDate: o.startDate ?? null,
        endDate: o.endDate ?? null,
        milestones: [],
        tags: [],
        links: [],
        blockedBy: [],
        assigneeIds: o.assigneeIds ?? [],
        rank: siblings.reduce((max, x) => Math.max(max, x.rank + 1), 0),
        priorityLabel: null,
        archived: o.archived ?? false,
        version: 1,
        createdBy: 'seed',
        createdAt: now,
        updatedAt: now,
      });
    },
    note: (tenantId, roadmapId, projectId, authorId, over = {}) =>
      scoped(db, tenantId)
        .collection('notes')
        .insertOne({
          _id: uuidv7(),
          parentId: null,
          body: 'Note',
          mentions: [],
          createdAt: new Date(),
          editedAt: null,
          deletedAt: null,
          ...over,
          roadmapId,
          projectId,
          authorId,
        }),
    async attachment(tenantId, roadmapId, projectId, uploadedById, over = {}) {
      const { body = Buffer.from('file body'), ...rest } = over;
      const _id = rest._id ?? uuidv7();
      const key = `${tenantId}/${roadmapId}/${_id}`;
      await files.put(key, body);
      return scoped(db, tenantId).collection('attachments').insertOne({
        name: 'file.txt',
        size: body.length,
        createdAt: new Date(),
        ...rest,
        _id,
        roadmapId,
        projectId,
        uploadedById,
        key,
      });
    },
  };

  return {
    app,
    db,
    config,
    mail,
    files,
    scanner,
    pdf,
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

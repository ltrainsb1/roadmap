import type { ClientSession, Db, Filter, Sort, UpdateFilter } from 'mongodb';
import type {
  AuditEventDoc,
  InviteDoc,
  MembershipDoc,
  ResetTokenDoc,
  RoadmapDoc,
  SessionDoc,
  UserDoc,
} from './types.ts';

export type CollectionName =
  | 'users'
  | 'memberships'
  | 'roadmaps'
  | 'sessions'
  | 'invites'
  | 'resetTokens';

interface DocMap {
  users: UserDoc;
  memberships: MembershipDoc;
  roadmaps: RoadmapDoc;
  sessions: SessionDoc;
  invites: InviteDoc;
  resetTokens: ResetTokenDoc;
}
export type DocFor<N extends CollectionName> = DocMap[N];

export interface ScopedCollection<T extends { tenantId: string }> {
  findOne(filter: Filter<T>): Promise<T | null>;
  find(filter: Filter<T>, opts?: { sort?: Sort; limit?: number }): Promise<T[]>;
  insertOne(doc: Omit<T, 'tenantId'>): Promise<T>;
  updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<{ matched: number }>;
  findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T>): Promise<T | null>;
  deleteOne(filter: Filter<T>): Promise<{ deleted: number }>;
  deleteMany(filter: Filter<T>): Promise<{ deleted: number }>;
  countDocuments(filter: Filter<T>): Promise<number>;
}

export interface ScopedDb {
  tenantId: string;
  collection<N extends CollectionName>(name: N): ScopedCollection<DocFor<N>>;
  audit: {
    insertOne(doc: Omit<AuditEventDoc, 'tenantId'>): Promise<void>;
    find(
      filter: Filter<AuditEventDoc>,
      opts: { sort: Sort; limit: number },
    ): Promise<AuditEventDoc[]>;
  };
  withTransaction<R>(fn: (s: ScopedDb) => Promise<R>): Promise<R>;
}

/** Throws if `tenantId` appears anywhere in `value` (at any depth) with a value other than `tenantId`. */
function assertNoForeignTenant(value: unknown, tenantId: string, where: string): void {
  if (Array.isArray(value)) {
    for (const v of value) assertNoForeignTenant(v, tenantId, where);
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'tenantId' && v !== tenantId) {
      throw new Error(`${where} names a different tenantId than the scope`);
    }
    assertNoForeignTenant(v, tenantId, where);
  }
}

/** Update operators may never touch tenantId, even to the current value. */
function assertUpdateSafe(update: unknown, tenantId: string): void {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error('update must be an operator document');
  }
  for (const [op, body] of Object.entries(update)) {
    if (!op.startsWith('$')) throw new Error('update must use operators, not a replacement document');
    if (body !== null && typeof body === 'object' && 'tenantId' in body) {
      throw new Error(`${op} must not modify tenantId`);
    }
  }
  assertNoForeignTenant(update, tenantId, 'update');
}

// Wrapping in $and means even a filter that slipped past the check cannot widen the tenant.
function scopeFilter<T>(filter: Filter<T>, tenantId: string): Filter<T> {
  assertNoForeignTenant(filter, tenantId, 'filter');
  return { $and: [{ tenantId }, filter] } as Filter<T>;
}

function makeScoped(db: Db, tenantId: string, session?: ClientSession): ScopedDb {
  const opts = session ? { session } : {};

  function collection<N extends CollectionName>(name: N): ScopedCollection<DocFor<N>> {
    type T = DocFor<N>;
    // The driver's generics cannot express our merged filters; the casts stay inside this module.
    const col = db.collection(name) as unknown as import('mongodb').Collection<T>;
    return {
      findOne: async (filter) => (await col.findOne(scopeFilter(filter, tenantId), opts)) as T | null,
      async find(filter, o = {}) {
        let cursor = col.find(scopeFilter(filter, tenantId), opts);
        if (o.sort) cursor = cursor.sort(o.sort);
        if (o.limit !== undefined) cursor = cursor.limit(o.limit);
        return (await cursor.toArray()) as T[];
      },
      async insertOne(doc) {
        assertNoForeignTenant(doc, tenantId, 'doc');
        const full = { ...doc, tenantId } as unknown as T;
        await col.insertOne(full as never, opts);
        return full;
      },
      async updateOne(filter, update) {
        assertUpdateSafe(update, tenantId);
        const r = await col.updateOne(scopeFilter(filter, tenantId), update, opts);
        return { matched: r.matchedCount };
      },
      async findOneAndUpdate(filter, update) {
        assertUpdateSafe(update, tenantId);
        return (await col.findOneAndUpdate(scopeFilter(filter, tenantId), update, {
          ...opts,
          returnDocument: 'after',
        })) as T | null;
      },
      async deleteOne(filter) {
        const r = await col.deleteOne(scopeFilter(filter, tenantId), opts);
        return { deleted: r.deletedCount };
      },
      async deleteMany(filter) {
        const r = await col.deleteMany(scopeFilter(filter, tenantId), opts);
        return { deleted: r.deletedCount };
      },
      countDocuments: async (filter) => col.countDocuments(scopeFilter(filter, tenantId), opts),
    };
  }

  const auditCol = () => db.collection<AuditEventDoc>('auditEvents');

  return {
    tenantId,
    collection,
    // Append-only: deliberately no update or delete.
    audit: {
      async insertOne(doc) {
        assertNoForeignTenant(doc, tenantId, 'doc');
        await auditCol().insertOne({ ...doc, tenantId }, opts);
      },
      find: async (filter, o) =>
        auditCol().find(scopeFilter(filter, tenantId), opts).sort(o.sort).limit(o.limit).toArray(),
    },
    async withTransaction<R>(fn: (s: ScopedDb) => Promise<R>): Promise<R> {
      if (session) return fn(makeScoped(db, tenantId, session)); // already inside a transaction
      const s = db.client.startSession();
      try {
        return await s.withTransaction(() => fn(makeScoped(db, tenantId, s)));
      } finally {
        await s.endSession();
      }
    },
  };
}

export function scoped(db: Db, tenantId: string): ScopedDb {
  return makeScoped(db, tenantId);
}

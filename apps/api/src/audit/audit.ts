import type { AuditActionName } from '@roadmap/shared';
import { v7 as uuidv7 } from 'uuid';
import type { ScopedDb } from '../db/scoped.ts';
import type { AuditActorDoc, AuditEventDoc } from '../db/types.ts';

export type AuditActor = AuditActorDoc;

export type AuditAction = AuditActionName;

export interface AuditInput {
  action: AuditAction;
  actor: AuditActor;
  roadmapId?: string;
  target: { type: string; id: string };
  before?: unknown;
  after?: unknown;
  ip: string | null;
}

export interface AuditQuery {
  roadmapId: string;
  action?: AuditAction;
  actorId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface AuditLog {
  record(s: ScopedDb, e: AuditInput): Promise<void>;
  list(s: ScopedDb, q: AuditQuery): Promise<{ items: AuditEventDoc[]; nextCursor: string | null }>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SECRET_KEYS = new Set(['passwordHash', 'totp', 'recoveryCodes', 'tokenHash', 'passkeys']);

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(v);
  }
  return out;
}

function encodeCursor(e: AuditEventDoc): string {
  return Buffer.from(`${e.timestamp.toISOString()}|${e._id}`).toString('base64url');
}

function decodeCursor(cursor: string): { timestamp: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  const timestamp = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (sep < 0 || Number.isNaN(timestamp.getTime()) || id === '') throw new Error('invalid_cursor');
  return { timestamp, id };
}

export function createAuditLog(): AuditLog {
  return {
    async record(s, e) {
      const doc: Omit<AuditEventDoc, 'tenantId'> = {
        _id: uuidv7(),
        timestamp: new Date(),
        action: e.action,
        actor: e.actor,
        ...(e.roadmapId !== undefined && { roadmapId: e.roadmapId }),
        target: e.target,
        ...(e.before !== undefined && { before: stripSecrets(e.before) }),
        ...(e.after !== undefined && { after: stripSecrets(e.after) }),
        ip: e.ip,
      };
      await s.audit.insertOne(doc);
    },

    async list(s, q) {
      const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const clauses: Record<string, unknown>[] = [{ roadmapId: q.roadmapId }];
      if (q.action) clauses.push({ action: q.action });
      if (q.actorId) clauses.push({ $or: [{ 'actor.userId': q.actorId }, { 'actor.onBehalfOf': q.actorId }] });
      if (q.from || q.to) {
        clauses.push({ timestamp: { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) } });
      }
      if (q.cursor !== undefined) {
        const c = decodeCursor(q.cursor);
        clauses.push({ $or: [{ timestamp: { $lt: c.timestamp } }, { timestamp: c.timestamp, _id: { $lt: c.id } }] });
      }
      // One extra row tells us whether another page exists.
      const rows = await s.audit.find({ $and: clauses }, {
        sort: { timestamp: -1, _id: -1 },
        limit: limit + 1,
      });
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null };
    },
  };
}

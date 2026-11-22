import { randomBytes } from 'node:crypto';
import {
  SNAPSHOT_LIMITS,
  createSnapshotRequestSchema,
  createSnapshotResponseSchema,
  snapshotListSchema,
  type SnapshotSummary,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import { hashPassword } from '../auth/passwords.ts';
import type { SnapshotDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import type { ObjectStore } from '../files/object-store.ts';
import { roadmapParams } from '../params.ts';
import { deleteStoredFiles } from '../projects/content.ts';
import { freezeRoadmap } from './freeze.ts';
import { deleteSnapshots } from './store.ts';

export interface SnapshotRouteDeps {
  now: () => Date;
  /** Where the snapshots' PDFs are kept; revoking deletes them. */
  objectStore: ObjectStore;
  /** Most snapshots one roadmap may hold; defaults to the shared limit. Tests lower it. */
  maxSnapshots?: number;
  /** Most notes one snapshot may hold; defaults to the shared limit. Tests lower it. */
  maxNotes?: number;
}

const DAY_MS = 86_400_000;
const snapshotParams = roadmapParams.extend({ snapshotId: z.string().min(1).max(100) });
const noContent = { 204: z.null().describe('No content') };
const config = { auth: { level: 'full', action: 'snapshot.create' } } as const;

/** YYYY-MM-DD of the UTC day after `now`: the latest "as of" accepted, so "today" works in every time zone. */
const latestAsOf = (now: Date) => new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);

function toSummary(doc: SnapshotDoc, createdByName: string | null): SnapshotSummary {
  return {
    id: doc._id,
    linkId: doc.linkId,
    name: doc.name,
    asOf: doc.asOf,
    createdAt: doc.createdAt.toISOString(),
    createdByName,
    expiresAt: doc.expiresAt?.toISOString() ?? null,
    include: doc.include,
    itemCount: doc.itemCount,
    noteCount: doc.noteCount,
    lockedUntil: doc.lockedUntil?.toISOString() ?? null,
    openCount: doc.openCount,
    lastOpenedAt: doc.lastOpenedAt?.toISOString() ?? null,
  };
}

export function registerSnapshotRoutes(app: FastifyInstance, deps: SnapshotRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const maxSnapshots = deps.maxSnapshots ?? SNAPSHOT_LIMITS.perRoadmap;
  const maxNotes = deps.maxNotes ?? SNAPSHOT_LIMITS.notes;
  const base = '/api/roadmaps/:roadmapId/snapshots';

  r.get(base, { config, schema: { params: roadmapParams, response: { 200: snapshotListSchema } } }, async (req) => {
    const db = req.actor!.db;
    const { roadmapId } = req.params;
    const docs = await db.collection('snapshots').find({ roadmapId }, { sort: { createdAt: -1, _id: -1 } });
    const users = await db.collection('users').find({ _id: { $in: [...new Set(docs.map((d) => d.createdBy))] } });
    const names = new Map(users.map((u) => [u._id, u.name]));
    return { snapshots: docs.map((d) => toSummary(d, names.get(d.createdBy) ?? null)) };
  });

  r.post(
    base,
    { config, schema: { params: roadmapParams, body: createSnapshotRequestSchema, response: { 201: createSnapshotResponseSchema } } },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId } = req.params;
      const { name, asOf, password, include } = req.body;
      const now = deps.now();
      if (asOf > latestAsOf(now)) throw new HttpError(422, 'as_of_in_future');
      const expiresAt = req.body.expiresAt === null ? null : new Date(req.body.expiresAt);
      if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) throw new HttpError(422, 'expiry_in_past');
      if (expiresAt !== null && expiresAt.getTime() - now.getTime() > SNAPSHOT_LIMITS.maxExpiryDays * DAY_MS) {
        throw new HttpError(422, 'expiry_too_far');
      }
      // Hashed before the transaction: it is slow, and a retry of the transaction need not repeat it.
      const passwordHash = await hashPassword(password);
      const id = uuidv7();
      const linkId = randomBytes(24).toString('base64url');
      await actor.db.withTransaction(async (s) => {
        // Every create writes the roadmap document, and so does the roadmap's delete. Two creates at once, or a
        // create and the delete, conflict and one retries: the count below sees the other create, and no snapshot is
        // left behind for a roadmap that is gone. Nothing matched: the roadmap was deleted after the auth hook passed.
        const roadmap = await s
          .collection('roadmaps')
          .findOneAndUpdate({ _id: roadmapId }, { $inc: { snapshotRevision: 1 } });
        if (!roadmap) throw new HttpError(404, 'not_found');
        const snapshots = s.collection('snapshots');
        if ((await snapshots.countDocuments({ roadmapId })) >= maxSnapshots) {
          throw new HttpError(422, 'too_many_snapshots');
        }
        await snapshots.insertOne({
          _id: id,
          roadmapId,
          linkId,
          name,
          asOf,
          roadmapName: roadmap.name,
          include,
          passwordHash,
          expiresAt,
          itemCount: 0,
          noteCount: 0,
          failedUnlocks: 0,
          lockedUntil: null,
          openCount: 0,
          lastOpenedAt: null,
          pdfs: {},
          createdBy: actor.userId,
          createdAt: now,
        });
        const counts = await freezeRoadmap(s, { roadmapId, snapshotId: id, include, maxNotes });
        await snapshots.updateOne({ _id: id, roadmapId }, { $set: counts });
        await audit.record(s, {
          action: 'snapshot.create',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'snapshot', id },
          after: { name, asOf, include, expiresAt: expiresAt?.toISOString() ?? null },
          ip: req.ip,
        });
      });
      return reply.status(201).send({ id, linkId });
    },
  );

  r.delete(`${base}/:snapshotId`, { config, schema: { params: snapshotParams, response: noContent } }, async (req, reply) => {
    const actor = req.actor!;
    const { roadmapId, snapshotId } = req.params;
    const keys = await actor.db.withTransaction(async (s) => {
      const snapshot = await s.collection('snapshots').findOne({ _id: snapshotId, roadmapId });
      if (!snapshot) throw new HttpError(404, 'not_found');
      const { keys } = await deleteSnapshots(s, { roadmapId, snapshotId });
      await audit.record(s, {
        action: 'snapshot.revoke',
        actor: { type: 'user', userId: actor.userId },
        roadmapId,
        target: { type: 'snapshot', id: snapshotId },
        before: { name: snapshot.name },
        ip: req.ip,
      });
      return keys;
    });
    await deleteStoredFiles(deps.objectStore, keys, req.log);
    return reply.status(204).send(null);
  });
}

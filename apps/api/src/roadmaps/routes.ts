import {
  createRoadmapRequestSchema,
  idResponseSchema,
  roadmapListResponseSchema,
  type Membership,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import type { ScopedDb } from '../db/scoped.ts';

/** The roadmaps a user belongs to (archived ones excluded), by name. Source for /api/me and the picker. */
export async function listMemberships(db: ScopedDb, userId: string): Promise<Membership[]> {
  const memberships = await db.collection('memberships').find({ userId });
  const roadmaps = await db.collection('roadmaps').find({ _id: { $in: memberships.map((m) => m.roadmapId) } });
  const live = new Map(roadmaps.filter((rm) => !rm.archived).map((rm) => [rm._id, rm.name]));
  return memberships
    .filter((m) => live.has(m.roadmapId))
    .map((m) => ({ roadmapId: m.roadmapId, roadmapName: live.get(m.roadmapId)!, role: m.role }))
    .sort((a, b) => a.roadmapName.localeCompare(b.roadmapName));
}

export function registerRoadmapRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  // No action: any signed-in user may start a roadmap of their own.
  r.post(
    '/api/roadmaps',
    {
      config: { auth: { level: 'full' } },
      schema: { body: createRoadmapRequestSchema, response: { 201: idResponseSchema } },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const now = new Date();
      const id = uuidv7();
      const description = req.body.description ?? '';
      await actor.db.withTransaction(async (s) => {
        await s.collection('roadmaps').insertOne({
          _id: id,
          name: req.body.name,
          description,
          ownerId: actor.userId,
          archived: false,
          createdAt: now,
        });
        await s
          .collection('memberships')
          .insertOne({ _id: uuidv7(), roadmapId: id, userId: actor.userId, role: 'owner', createdAt: now });
        await audit.record(s, {
          action: 'roadmap.create',
          actor: { type: 'user', userId: actor.userId },
          roadmapId: id,
          target: { type: 'roadmap', id },
          after: { name: req.body.name, description },
          ip: req.ip,
        });
      });
      return reply.status(201).send({ id });
    },
  );

  r.get(
    '/api/roadmaps',
    { config: { auth: { level: 'full' } }, schema: { response: { 200: roadmapListResponseSchema } } },
    async (req) => listMemberships(req.actor!.db, req.actor!.userId),
  );
}

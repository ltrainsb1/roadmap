import {
  MAX_DEPTH,
  createProjectRequestSchema,
  projectListSchema,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import type { ProjectDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { loadProject, parentAssignedCtx, toProjectDto } from './access.ts';

export interface ProjectRouteDeps {
  now: () => Date;
  maxItems: number;
}

const roadmapParams = z.object({ roadmapId: z.string().min(1).max(100) });

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  r.post(
    '/api/roadmaps/:roadmapId/projects',
    {
      config: { auth: { level: 'full', action: 'project.create', ctx: parentAssignedCtx } },
      schema: {
        params: roadmapParams,
        body: createProjectRequestSchema,
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId } = req.params;
      const { parentId, title } = req.body;
      const id = await actor.db.withTransaction(async (s) => {
        const parent = parentId === null ? null : await loadProject(s, roadmapId, parentId);
        if (parent?.archived) throw new HttpError(409, 'parent_archived');
        if (parent && parent.depth >= MAX_DEPTH) throw new HttpError(422, 'too_deep');
        const projects = s.collection('projects');
        if ((await projects.countDocuments({ roadmapId })) >= deps.maxItems) {
          throw new HttpError(422, 'too_many_items');
        }
        const [last] = await projects.find({ roadmapId, parentId }, { sort: { rank: -1 }, limit: 1 });
        const now = deps.now();
        const doc = await projects.insertOne({
          _id: uuidv7(),
          roadmapId,
          parentId,
          depth: ((parent?.depth ?? 0) + 1) as ProjectDoc['depth'],
          path: parent ? [...parent.path, parent._id] : [],
          title,
          description: '',
          status: 'not_started',
          startDate: null,
          endDate: null,
          milestones: [],
          tags: [],
          links: [],
          blockedBy: [],
          assigneeIds: [],
          rank: last ? last.rank + 1 : 0,
          priorityLabel: null,
          archived: false,
          version: 1,
          createdBy: actor.userId,
          createdAt: now,
          updatedAt: now,
        });
        await audit.record(s, {
          action: 'project.create',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'project', id: doc._id },
          after: { title, parentId },
          ip: req.ip,
        });
        return doc._id;
      });
      return reply.status(201).send({ id });
    },
  );

  r.get(
    '/api/roadmaps/:roadmapId/projects',
    {
      config: { auth: { level: 'full', action: 'roadmap.view' } },
      schema: { params: roadmapParams, response: { 200: projectListSchema } },
    },
    async (req) => {
      const docs = await req.actor!.db.collection('projects').find({ roadmapId: req.params.roadmapId });
      return { items: docs.map(toProjectDto) };
    },
  );
}

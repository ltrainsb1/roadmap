import { projectSchema, setAssigneesRequestSchema } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import { HttpError } from '../errors.ts';
import { loadProject, toProjectDto } from './access.ts';

export interface AssignRouteDeps {
  now: () => Date;
}

const projectParams = z.object({
  roadmapId: z.string().min(1).max(100),
  projectId: z.string().min(1).max(100),
});

export function registerAssignRoutes(app: FastifyInstance, deps: AssignRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  r.put(
    '/api/roadmaps/:roadmapId/projects/:projectId/assignees',
    {
      config: { auth: { level: 'full', action: 'project.assign' } },
      schema: { params: projectParams, body: setAssigneesRequestSchema, response: { 200: projectSchema } },
    },
    async (req) => {
      const actor = req.actor!;
      const { roadmapId, projectId } = req.params;
      const wanted = [...new Set(req.body.userIds)];
      return actor.db.withTransaction(async (s) => {
        const current = await loadProject(s, roadmapId, projectId);
        // Read inside this transaction: if a member is removed meanwhile, the removal also rewrites the items that
        // name them, so a write here that overlaps it conflicts and retries against the new membership list.
        if (wanted.length > 0) {
          const members = await s.collection('memberships').find({ roadmapId, userId: { $in: wanted } });
          if (members.length !== wanted.length) throw new HttpError(422, 'not_a_member');
        }
        const same = wanted.length === current.assigneeIds.length && wanted.every((id) => current.assigneeIds.includes(id));
        if (same) return toProjectDto(current);

        const updated = await s
          .collection('projects')
          .findOneAndUpdate(
            { _id: projectId, roadmapId },
            { $set: { assigneeIds: wanted, updatedAt: deps.now() }, $inc: { version: 1 } },
          );
        if (!updated) throw new HttpError(404, 'not_found');
        await audit.record(s, {
          action: 'project.assign',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'project', id: projectId },
          before: { title: current.title, assigneeIds: current.assigneeIds },
          after: { title: updated.title, assigneeIds: updated.assigneeIds },
          ip: req.ip,
        });
        return toProjectDto(updated);
      });
    },
  );
}

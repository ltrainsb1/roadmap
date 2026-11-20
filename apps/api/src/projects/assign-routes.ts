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
      const { version } = req.body;
      return actor.db.withTransaction(async (s) => {
        const current = await loadProject(s, roadmapId, projectId);
        // A client that sends the version its list was built from never drops someone it had not seen assigned.
        if (version !== undefined && current.version !== version) throw new HttpError(409, 'conflict');
        const same = wanted.length === current.assigneeIds.length && wanted.every((id) => current.assigneeIds.includes(id));
        if (same) return toProjectDto(current);
        if (wanted.length > 0) {
          // The guard against a concurrent member removal is the membershipRevision increment after this read: removal writes the
          // same roadmap document, so one of the two transactions conflicts and retries against the new membership list.
          const members = await s.collection('memberships').find({ roadmapId, userId: { $in: wanted } });
          if (members.length !== wanted.length) throw new HttpError(422, 'not_a_member');
          await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { membershipRevision: 1 } });
        }

        const updated = await s
          .collection('projects')
          .findOneAndUpdate(
            { _id: projectId, roadmapId, ...(version !== undefined && { version }) },
            { $set: { assigneeIds: wanted, updatedAt: deps.now() }, $inc: { version: 1 } },
          );
        // Gone or changed since the read above: a versioned request treats both as a conflict, as the edit route does.
        if (!updated) throw version !== undefined ? new HttpError(409, 'conflict') : new HttpError(404, 'not_found');
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

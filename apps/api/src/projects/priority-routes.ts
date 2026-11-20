import { priorityLabelRequestSchema, projectSchema, reorderRequestSchema } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createAuditLog } from '../audit/audit.ts';
import { HttpError } from '../errors.ts';
import { loadProject, toProjectDto } from './access.ts';
import { projectParams, roadmapParams } from '../params.ts';

export interface PriorityRouteDeps {
  now: () => Date;
}


export function registerPriorityRoutes(app: FastifyInstance, deps: PriorityRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  // Fastify matches this static path before /projects/:projectId/..., so "order" is never read as an item id.
  r.put(
    '/api/roadmaps/:roadmapId/projects/order',
    {
      config: { auth: { level: 'full', action: 'project.setPriority' } },
      schema: { params: roadmapParams, body: reorderRequestSchema },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId } = req.params;
      const { parentId, orderedIds } = req.body;
      await actor.db.withTransaction(async (s) => {
        const parent = parentId === null ? null : await loadProject(s, roadmapId, parentId);
        const projects = s.collection('projects');
        const siblings = await projects.find({ roadmapId, parentId, archived: false }, { sort: { rank: 1, _id: 1 } });
        const stored = new Set(siblings.map((x) => x._id));
        if (orderedIds.length !== stored.size || new Set(orderedIds).size !== stored.size || !orderedIds.every((id) => stored.has(id))) {
          throw new HttpError(409, 'order_stale');
        }
        const byId = new Map(siblings.map((x) => [x._id, x]));
        const moved = orderedIds.filter((id, index) => byId.get(id)!.rank !== index);
        // Equal to the stored order: nothing to write, nothing to audit.
        if (moved.length === 0) return;

        // Two reorders can change different items, so writing only the changed ranks would not make them conflict
        // and the result could blend both lists. Every reorder that writes bumps this one document, so MongoDB
        // reports a write conflict to the second transaction; it retries, re-reads the siblings and validates again.
        await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { orderRevision: 1 } });
        for (const id of moved) {
          await projects.updateOne({ _id: id, roadmapId }, { $set: { rank: orderedIds.indexOf(id) } });
        }
        await audit.record(s, {
          action: 'project.reorder',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: parent ? { type: 'project', id: parent._id } : { type: 'roadmap', id: roadmapId },
          after: { parentTitle: parent?.title ?? null, orderedIds },
          ip: req.ip,
        });
      });
      return reply.status(204).send();
    },
  );

  r.put(
    '/api/roadmaps/:roadmapId/projects/:projectId/priority-label',
    {
      config: { auth: { level: 'full', action: 'project.setPriority' } },
      schema: { params: projectParams, body: priorityLabelRequestSchema, response: { 200: projectSchema } },
    },
    async (req) => {
      const actor = req.actor!;
      const { roadmapId, projectId } = req.params;
      const { label } = req.body;
      return actor.db.withTransaction(async (s) => {
        const current = await loadProject(s, roadmapId, projectId);
        if (current.priorityLabel === label) return toProjectDto(current);
        const updated = await s
          .collection('projects')
          .findOneAndUpdate(
            { _id: projectId, roadmapId },
            { $set: { priorityLabel: label, updatedAt: deps.now() }, $inc: { version: 1 } },
          );
        if (!updated) throw new HttpError(404, 'not_found');
        await audit.record(s, {
          action: 'project.priority_label',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'project', id: projectId },
          before: { title: current.title, priorityLabel: current.priorityLabel },
          after: { title: updated.title, priorityLabel: updated.priorityLabel },
          ip: req.ip,
        });
        return toProjectDto(updated);
      });
    },
  );
}

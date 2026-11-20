import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { ScopedDb } from '../db/scoped.ts';
import type { ProjectDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { assignedCtx, loadProject } from './access.ts';
import { projectParams } from '../params.ts';


/** Every item in the roadmap under `item`, at any depth. */
const descendantsOf = (s: ScopedDb, item: ProjectDoc) =>
  s.collection('projects').find({ roadmapId: item.roadmapId, path: item._id });

/** The non-archived siblings of `item` keep their order and get ranks 0..n-1; only changed ranks are written. */
async function closeRankGap(s: ScopedDb, item: ProjectDoc): Promise<void> {
  const projects = s.collection('projects');
  const siblings = await projects.find(
    { roadmapId: item.roadmapId, parentId: item.parentId, archived: false, _id: { $ne: item._id } },
    { sort: { rank: 1, _id: 1 } },
  );
  for (const [index, sibling] of siblings.entries()) {
    if (sibling.rank !== index) await projects.updateOne({ _id: sibling._id, roadmapId: item.roadmapId }, { $set: { rank: index } });
  }
}

// Every transaction that changes sibling order bumps the roadmap document, as the reorder route does, so two
// concurrent order changes in one roadmap conflict and one retries against fresh data.
const bumpOrderRevision = (s: ScopedDb, roadmapId: string, extra: { dependencyRevision?: 1 } = {}) =>
  s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { orderRevision: 1, ...extra } });

export function registerLifecycleRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const base = '/api/roadmaps/:roadmapId/projects/:projectId';
  const config = { auth: { level: 'full', action: 'project.delete', ctx: assignedCtx } } as const;

  r.post(`${base}/archive`, { config, schema: { params: projectParams } }, async (req, reply) => {
    const actor = req.actor!;
    const { roadmapId, projectId } = req.params;
    await actor.db.withTransaction(async (s) => {
      const item = await loadProject(s, roadmapId, projectId);
      if (item.archived) return;
      const count = (await descendantsOf(s, item)).length + 1;
      await s
        .collection('projects')
        .updateMany({ roadmapId, $or: [{ _id: projectId }, { path: projectId }] }, { $set: { archived: true } });
      await closeRankGap(s, item);
      await bumpOrderRevision(s, roadmapId);
      await audit.record(s, {
        action: 'project.archive',
        actor: { type: 'user', userId: actor.userId },
        roadmapId,
        target: { type: 'project', id: projectId },
        after: { title: item.title, count },
        ip: req.ip,
      });
    });
    return reply.status(204).send();
  });

  r.post(`${base}/unarchive`, { config, schema: { params: projectParams } }, async (req, reply) => {
    const actor = req.actor!;
    const { roadmapId, projectId } = req.params;
    await actor.db.withTransaction(async (s) => {
      const item = await loadProject(s, roadmapId, projectId);
      if (!item.archived) return;
      if (item.parentId !== null && (await loadProject(s, roadmapId, item.parentId)).archived) {
        throw new HttpError(409, 'parent_archived');
      }
      const projects = s.collection('projects');
      const siblings = await projects.find({ roadmapId, parentId: item.parentId, archived: false });
      const rank = siblings.reduce((max, x) => Math.max(max, x.rank + 1), 0);
      const count = (await descendantsOf(s, item)).length + 1;
      await projects.updateMany({ roadmapId, path: projectId }, { $set: { archived: false } });
      await projects.updateOne({ _id: projectId, roadmapId }, { $set: { archived: false, rank } });
      await bumpOrderRevision(s, roadmapId);
      await audit.record(s, {
        action: 'project.unarchive',
        actor: { type: 'user', userId: actor.userId },
        roadmapId,
        target: { type: 'project', id: projectId },
        after: { title: item.title, count },
        ip: req.ip,
      });
    });
    return reply.status(204).send();
  });

  r.delete(base, { config, schema: { params: projectParams, response: { 200: z.object({ deleted: z.number() }) } } }, async (req) => {
    const actor = req.actor!;
    const { roadmapId, projectId } = req.params;
    return actor.db.withTransaction(async (s) => {
      const item = await loadProject(s, roadmapId, projectId);
      const ids = [item._id, ...(await descendantsOf(s, item)).map((x) => x._id)];
      const projects = s.collection('projects');
      const { deleted } = await projects.deleteMany({ roadmapId, _id: { $in: ids } });
      // The version goes up with the pull: a form opened before the delete still lists the deleted item, and its
      // next save must be a conflict the person can reload from, not a refusal about an item they never chose.
      await projects.updateMany({ roadmapId, blockedBy: { $in: ids } }, { $pull: { blockedBy: { $in: ids } }, $inc: { version: 1 } });
      await closeRankGap(s, item);
      // Always bump dependencyRevision, not only when the pull matched: an edit that adds this item as a blocker
      // reads it before the delete commits, and the shared roadmap write is what makes that edit conflict and retry.
      await bumpOrderRevision(s, roadmapId, { dependencyRevision: 1 });
      await audit.record(s, {
        action: 'project.delete',
        actor: { type: 'user', userId: actor.userId },
        roadmapId,
        target: { type: 'project', id: projectId },
        before: { title: item.title, count: deleted },
        ip: req.ip,
      });
      return { deleted };
    });
  });
}

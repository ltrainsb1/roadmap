import type { Project } from '@roadmap/shared';
import type { FastifyRequest } from 'fastify';
import type { ScopedDb } from '../db/scoped.ts';
import type { ProjectDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import type { PolicyContext } from '../policy/policy.ts';

/** The item in this roadmap, or 404 not_found. Never returns another roadmap's or tenant's item. */
export async function loadProject(db: ScopedDb, roadmapId: string, projectId: string): Promise<ProjectDoc> {
  const doc = await db.collection('projects').findOne({ _id: projectId, roadmapId });
  if (!doc) throw new HttpError(404, 'not_found');
  return doc;
}

/** True if the user is an assignee of the item or of any ancestor. One query reads all the ancestors. */
export async function isAssignedTo(db: ScopedDb, item: ProjectDoc, userId: string): Promise<boolean> {
  if (item.assigneeIds.includes(userId)) return true;
  if (item.path.length === 0) return false;
  const ancestors = await db
    .collection('projects')
    .find({ _id: { $in: item.path }, roadmapId: item.roadmapId, assigneeIds: userId });
  return ancestors.length > 0;
}

/** ctx for routes with :projectId. */
export async function assignedCtx(req: FastifyRequest): Promise<PolicyContext> {
  const { roadmapId, projectId } = req.params as { roadmapId: string; projectId: string };
  const actor = req.actor!;
  const item = await loadProject(actor.db, roadmapId, projectId);
  return { isAssigned: await isAssignedTo(actor.db, item, actor.userId) };
}

/** ctx for create: assignment on the body's parentId chain; a null parentId gives { isAssigned: false }. */
export async function parentAssignedCtx(req: FastifyRequest): Promise<PolicyContext> {
  const { roadmapId } = req.params as { roadmapId: string };
  const { parentId } = req.body as { parentId: string | null };
  if (parentId === null) return { isAssigned: false };
  const actor = req.actor!;
  const parent = await loadProject(actor.db, roadmapId, parentId);
  return { isAssigned: await isAssignedTo(actor.db, parent, actor.userId) };
}

export function toProjectDto(doc: ProjectDoc): Project {
  return {
    id: doc._id,
    parentId: doc.parentId,
    depth: doc.depth,
    path: doc.path,
    title: doc.title,
    description: doc.description,
    status: doc.status,
    startDate: doc.startDate,
    endDate: doc.endDate,
    milestones: doc.milestones,
    tags: doc.tags,
    links: doc.links,
    blockedBy: doc.blockedBy,
    assigneeIds: doc.assigneeIds,
    rank: doc.rank,
    priorityLabel: doc.priorityLabel,
    archived: doc.archived,
    version: doc.version,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

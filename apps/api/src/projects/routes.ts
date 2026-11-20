import {
  MAX_DEPTH,
  createProjectRequestSchema,
  projectListSchema,
  projectSchema,
  type Milestone,
  type ProjectLink,
  wouldCycle,
  updateProjectBodySchema,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import type { ProjectDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { assignedCtx, loadProject, parentAssignedCtx, toProjectDto } from './access.ts';

export interface ProjectRouteDeps {
  now: () => Date;
  maxItems: number;
}

const roadmapParams = z.object({ roadmapId: z.string().min(1).max(100) });
const projectParams = roadmapParams.extend({ projectId: z.string().min(1).max(100) });

/** Keeps the stored id of an entry the item already has, once; anything else is new and gets a fresh id. */
function resolveIds<T extends { id?: string | undefined }>(entries: T[], stored: Array<{ id: string }>): Array<T & { id: string }> {
  const available = new Set(stored.map((e) => e.id));
  return entries.map((e) => {
    const keep = e.id !== undefined && available.delete(e.id);
    return { ...e, id: keep ? e.id! : uuidv7() };
  });
}

const resolveLinks = (entries: Array<Omit<ProjectLink, 'id'> & { id?: string | undefined }>, stored: ProjectLink[]): ProjectLink[] =>
  resolveIds(entries, stored).map(({ id, label, url }) => ({ id, label, url }));
const resolveMilestones = (entries: Array<Omit<Milestone, 'id'> & { id?: string | undefined }>, stored: Milestone[]): Milestone[] =>
  resolveIds(entries, stored).map(({ id, name, date }) => ({ id, name, date }));

const sameLinks = (a: ProjectLink[], b: ProjectLink[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label && x.url === b[i]!.url);
const sameMilestones = (a: Milestone[], b: Milestone[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.name === b[i]!.name && x.date === b[i]!.date);
const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const EDITABLE_FIELDS = ['title', 'description', 'status', 'startDate', 'endDate', 'milestones', 'tags', 'links', 'blockedBy'] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

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
        // A create appends to a sibling order, so it writes the same document as reorder, archive, unarchive and
        // delete. A create that races one of them (or another create) conflicts and retries, re-reading the parent
        // and the last rank: no live child under an archived parent, no orphan, no two siblings with one rank.
        // Nothing matched: the roadmap was deleted after the auth hook passed, so nothing may be added to it.
        const { matched } = await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { orderRevision: 1 } });
        if (matched === 0) throw new HttpError(404, 'not_found');
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

  r.patch(
    '/api/roadmaps/:roadmapId/projects/:projectId',
    {
      config: { auth: { level: 'full', action: 'project.edit', ctx: assignedCtx } },
      schema: { params: projectParams, body: updateProjectBodySchema, response: { 200: projectSchema } },
    },
    async (req) => {
      const actor = req.actor!;
      const { roadmapId, projectId } = req.params;
      const { version, ...fields } = req.body;
      return actor.db.withTransaction(async (s) => {
        const projects = s.collection('projects');
        const current = await loadProject(s, roadmapId, projectId);
        if (current.version !== version) throw new HttpError(409, 'conflict');

        const { links, milestones, ...plain } = fields;
        const wanted = {
          ...plain,
          ...(links !== undefined ? { links: resolveLinks(links, current.links) } : {}),
          ...(milestones !== undefined ? { milestones: resolveMilestones(milestones, current.milestones) } : {}),
        };
        const changes: Partial<Pick<ProjectDoc, EditableField>> = {};
        const differs = (key: EditableField): boolean => {
          if (key === 'links') return wanted.links !== undefined && !sameLinks(wanted.links, current.links);
          if (key === 'milestones') {
            return wanted.milestones !== undefined && !sameMilestones(wanted.milestones, current.milestones);
          }
          if (key === 'tags') return wanted.tags !== undefined && !sameIds(wanted.tags, current.tags);
          if (key === 'blockedBy') return wanted.blockedBy !== undefined && !sameIds(wanted.blockedBy, current.blockedBy);
          return wanted[key] !== undefined && wanted[key] !== current[key];
        };
        for (const key of EDITABLE_FIELDS) {
          if (differs(key)) Object.assign(changes, { [key]: wanted[key] });
        }
        const changed = Object.keys(changes) as EditableField[];
        if (changed.length === 0) return toProjectDto(current);

        const startDate = changes.startDate !== undefined ? changes.startDate : current.startDate;
        const endDate = changes.endDate !== undefined ? changes.endDate : current.endDate;
        if (startDate && endDate && endDate < startDate) throw new HttpError(422, 'date_order');

        if (changes.blockedBy !== undefined) {
          const items = await projects.find({ roadmapId });
          const byId = new Map(items.map((doc) => [doc._id, toProjectDto(doc)]));
          if (changes.blockedBy.some((id) => !byId.has(id))) throw new HttpError(422, 'unknown_item');
          if (wouldCycle(projectId, changes.blockedBy, byId)) throw new HttpError(422, 'dependency_cycle');
          // The version filter below guards only this item, so two requests editing two different items could each
          // pass the check above and together close a cycle. Every blocked-by change writes this one document, so
          // MongoDB reports a write conflict to the second transaction; it retries, re-reads and sees the cycle.
          await s.collection('roadmaps').updateOne({ _id: roadmapId }, { $inc: { dependencyRevision: 1 } });
        }

        const updated = await projects.findOneAndUpdate(
          { _id: projectId, roadmapId, version },
          { $set: { ...changes, updatedAt: deps.now() }, $inc: { version: 1 } },
        );
        if (!updated) throw new HttpError(409, 'conflict');

        const pick = (doc: Pick<ProjectDoc, EditableField>) =>
          Object.fromEntries(changed.map((k) => [k, doc[k]]));
        await audit.record(s, {
          action: 'project.update',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'project', id: projectId },
          before: { title: current.title, ...pick(current) },
          after: { title: updated.title, ...pick(updated) },
          ip: req.ip,
        });
        return toProjectDto(updated);
      });
    },
  );
}

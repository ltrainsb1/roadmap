import {
  MAX_DEPTH,
  createProjectRequestSchema,
  projectListSchema,
  projectSchema,
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

/** Keeps the stored id of an entry the item already has; anything else is new and gets a fresh id. */
function withIds<T extends { id?: string | undefined }>(entries: T[], stored: Array<{ id: string }>): Array<T & { id: string }> {
  const known = new Set(stored.map((e) => e.id));
  return entries.map((e) => ({ ...e, id: e.id !== undefined && known.has(e.id) ? e.id : uuidv7() }));
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const EDITABLE_FIELDS = ['title', 'description', 'status', 'startDate', 'endDate', 'milestones', 'tags', 'links'] as const;
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
      const { version, blockedBy, ...fields } = req.body;
      if (blockedBy !== undefined) throw new HttpError(422, 'not_supported');
      return actor.db.withTransaction(async (s) => {
        const projects = s.collection('projects');
        const current = await loadProject(s, roadmapId, projectId);
        if (current.version !== version) throw new HttpError(409, 'conflict');

        const wanted = {
          ...fields,
          ...(fields.links !== undefined ? { links: withIds(fields.links, current.links) } : {}),
          ...(fields.milestones !== undefined
            ? { milestones: withIds(fields.milestones, current.milestones) }
            : {}),
        };
        const changes: Partial<Pick<ProjectDoc, EditableField>> = {};
        for (const key of EDITABLE_FIELDS) {
          const value = wanted[key];
          if (value !== undefined && !sameValue(value, current[key])) Object.assign(changes, { [key]: value });
        }
        const changed = Object.keys(changes) as EditableField[];
        if (changed.length === 0) return toProjectDto(current);

        const startDate = changes.startDate !== undefined ? changes.startDate : current.startDate;
        const endDate = changes.endDate !== undefined ? changes.endDate : current.endDate;
        if (startDate && endDate && endDate < startDate) throw new HttpError(422, 'date_order');

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

import '@fastify/multipart';
import {
  NOTE_LIMITS,
  attachmentListSchema,
  attachmentSchema,
  cleanFileName,
  downloadLinkSchema,
  type Attachment,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import type { ScopedDb } from '../db/scoped.ts';
import type { AttachmentDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { DOWNLOAD_SECONDS, type ObjectStore } from '../files/object-store.ts';
import { ScanUnavailableError, type Scanner } from '../files/scanner.ts';
import { assignedCtx, loadProject } from '../projects/access.ts';
import { assertOpenForContent, deleteStoredFiles } from '../projects/content.ts';
import { projectParams } from '../params.ts';

export interface AttachmentRouteDeps {
  now: () => Date;
  objectStore: ObjectStore;
  scanner: Scanner;
  maxFilesPerItem?: number;
}

const attachmentParams = projectParams.extend({ attachmentId: z.string().min(1).max(100) });
const noContent = { 204: z.null().describe('No content') };

const FORMER_MEMBER = 'Former member';

/** A file on this item, or 404 not_found. */
async function loadAttachment(
  s: ScopedDb,
  roadmapId: string,
  projectId: string,
  attachmentId: string,
): Promise<AttachmentDoc> {
  const doc = await s.collection('attachments').findOne({ _id: attachmentId, roadmapId, projectId });
  if (!doc) throw new HttpError(404, 'not_found');
  return doc;
}

function toAttachmentDto(doc: AttachmentDoc, uploadedByName: string): Attachment {
  return {
    id: doc._id,
    projectId: doc.projectId,
    name: doc.name,
    size: doc.size,
    uploadedById: doc.uploadedById,
    uploadedByName,
    createdAt: doc.createdAt.toISOString(),
  };
}

const validation = () => new HttpError(400, 'validation');

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const maxFiles = deps.maxFilesPerItem ?? NOTE_LIMITS.filesPerItem;
  const base = '/api/roadmaps/:roadmapId/projects/:projectId/attachments';

  /**
   * The one part named `file`, read into memory. The plugin's limits (one file, no fields, 25 MB) end the read
   * early: too large is 413 file_too_large; anything else that is not exactly one `file` part is 400 validation.
   */
  async function readUpload(req: FastifyRequest): Promise<{ rawName: string; body: Buffer }> {
    if (!req.isMultipart()) throw validation();
    const { RequestFileTooLargeError, FilesLimitError, FieldsLimitError, PartsLimitError } = app.multipartErrors;
    let found: { rawName: string; body: Buffer } | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file' || found) throw validation();
        found = { rawName: part.filename, body: await part.toBuffer() };
      }
    } catch (err) {
      if (err instanceof RequestFileTooLargeError) throw new HttpError(413, 'file_too_large');
      if (err instanceof FilesLimitError || err instanceof FieldsLimitError || err instanceof PartsLimitError) {
        throw validation();
      }
      throw err;
    }
    if (!found) throw validation();
    return found;
  }

  r.get(
    base,
    {
      config: { auth: { level: 'full', action: 'roadmap.view', roadmapParam: 'roadmapId' } },
      schema: { params: projectParams, response: { 200: attachmentListSchema } },
    },
    async (req) => {
      const db = req.actor!.db;
      const { roadmapId, projectId } = req.params;
      await loadProject(db, roadmapId, projectId);
      const docs = await db.collection('attachments').find({ roadmapId, projectId }, { sort: { createdAt: 1, _id: 1 } });
      const users = await db.collection('users').find({ _id: { $in: [...new Set(docs.map((d) => d.uploadedById))] } });
      const names = new Map(users.map((u) => [u._id, u.name]));
      return { attachments: docs.map((d) => toAttachmentDto(d, names.get(d.uploadedById) ?? FORMER_MEMBER)) };
    },
  );

  r.post(
    base,
    {
      config: { auth: { level: 'full', action: 'project.edit', roadmapParam: 'roadmapId', ctx: assignedCtx } },
      schema: { params: projectParams, response: { 201: attachmentSchema } },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, projectId } = req.params;
      const { rawName, body } = await readUpload(req);
      if (body.length === 0) throw new HttpError(422, 'empty_file');
      const name = cleanFileName(rawName);

      let verdict;
      try {
        verdict = await deps.scanner.scan(body);
      } catch (err) {
        if (err instanceof ScanUnavailableError) {
          req.log.warn({ err }, 'virus scan unavailable');
          throw new HttpError(503, 'scan_unavailable');
        }
        throw err;
      }
      if (!verdict.clean) {
        await audit.record(actor.db, {
          action: 'attachment.rejected',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'project', id: projectId },
          after: { name, size: body.length, signature: verdict.signature },
          ip: req.ip,
        });
        throw new HttpError(422, 'file_infected');
      }

      const id = uuidv7();
      // Ids only: the name the browser sent never reaches the store.
      const key = `${actor.tenantId}/${roadmapId}/${id}`;
      await deps.objectStore.put(key, body);
      let file: Attachment;
      try {
        file = await actor.db.withTransaction(async (s) => {
          await assertOpenForContent(s, roadmapId, projectId);
          const attachments = s.collection('attachments');
          if ((await attachments.countDocuments({ roadmapId, projectId })) >= maxFiles) {
            throw new HttpError(422, 'too_many_files');
          }
          const doc = await attachments.insertOne({
            _id: id,
            roadmapId,
            projectId,
            name,
            size: body.length,
            key,
            uploadedById: actor.userId,
            createdAt: deps.now(),
          });
          await audit.record(s, {
            action: 'attachment.create',
            actor: { type: 'user', userId: actor.userId },
            roadmapId,
            target: { type: 'attachment', id },
            after: { projectId, name, size: doc.size },
            ip: req.ip,
          });
          const uploader = await s.collection('users').findOne({ _id: actor.userId });
          return toAttachmentDto(doc, uploader?.name ?? FORMER_MEMBER);
        });
      } catch (err) {
        // No record was committed, so the object must not stay behind.
        await deleteStoredFiles(deps.objectStore, [key], req.log);
        throw err;
      }
      return reply.status(201).send(file);
    },
  );

  r.get(
    `${base}/:attachmentId/download`,
    {
      config: { auth: { level: 'full', action: 'roadmap.view', roadmapParam: 'roadmapId' } },
      schema: { params: attachmentParams, response: { 200: downloadLinkSchema } },
    },
    async (req) => {
      const { roadmapId, projectId, attachmentId } = req.params;
      const doc = await loadAttachment(req.actor!.db, roadmapId, projectId, attachmentId);
      const url = await deps.objectStore.signedGetUrl(doc.key, { fileName: doc.name, expiresSeconds: DOWNLOAD_SECONDS });
      return { url };
    },
  );

  r.delete(
    `${base}/:attachmentId`,
    {
      config: { auth: { level: 'full', action: 'project.edit', roadmapParam: 'roadmapId', ctx: assignedCtx } },
      schema: { params: attachmentParams, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, projectId, attachmentId } = req.params;
      const key = await actor.db.withTransaction(async (s) => {
        await assertOpenForContent(s, roadmapId, projectId);
        const doc = await loadAttachment(s, roadmapId, projectId, attachmentId);
        await s.collection('attachments').deleteOne({ _id: attachmentId, roadmapId });
        await audit.record(s, {
          action: 'attachment.delete',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'attachment', id: attachmentId },
          before: { projectId, name: doc.name, size: doc.size },
          ip: req.ip,
        });
        return doc.key;
      });
      await deleteStoredFiles(deps.objectStore, [key], req.log);
      return reply.status(204).send(null);
    },
  );
}

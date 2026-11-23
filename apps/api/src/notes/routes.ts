import {
  NOTE_LIMITS,
  createNoteBodySchema,
  findMentions,
  noteBodySchema,
  noteListSchema,
  noteSchema,
  type Mention,
  type Note,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createAuditLog } from '../audit/audit.ts';
import type { ScopedDb } from '../db/scoped.ts';
import type { NoteDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { deleteMentions, notifyMentioned, updateMentions } from '../notifications/outbox.ts';
import type { PolicyContext } from '../policy/policy.ts';
import { loadProject } from '../projects/access.ts';
import { assertOpenForContent } from '../projects/content.ts';
import { projectParams } from '../params.ts';

export interface NoteRouteDeps {
  now: () => Date;
  maxNotesPerItem?: number;
}

const noteParams = projectParams.extend({ noteId: z.string().min(1).max(100) });
const noContent = { 204: z.null().describe('No content') };

const FORMER_MEMBER = 'Former member';

/** A live (not deleted) note on this item, or 404 not_found. */
async function loadNote(s: ScopedDb, roadmapId: string, projectId: string, noteId: string): Promise<NoteDoc> {
  const note = await s.collection('notes').findOne({ _id: noteId, roadmapId, projectId, deletedAt: null });
  if (!note) throw new HttpError(404, 'not_found');
  return note;
}

/** ctx for edit and delete: whether the caller wrote the note. */
async function authorCtx(req: FastifyRequest): Promise<PolicyContext> {
  const { roadmapId, projectId, noteId } = req.params as z.infer<typeof noteParams>;
  const actor = req.actor!;
  const note = await loadNote(actor.db, roadmapId, projectId, noteId);
  return { isAuthor: note.authorId === actor.userId };
}

/**
 * The people mentioned in `body`: current members of the roadmap whose id the client sent and whose `@Name`
 * appears in the text, each with their current name. Ids of anyone else are dropped without an error.
 */
async function mentionsIn(s: ScopedDb, roadmapId: string, body: string, mentionIds: string[]): Promise<Mention[]> {
  if (mentionIds.length === 0) return [];
  const members = await s.collection('memberships').find({ roadmapId, userId: { $in: mentionIds } });
  const users = await s.collection('users').find({ _id: { $in: members.map((m) => m.userId) } });
  const byId = new Map(users.map((u) => [u._id, u]));
  // In the order the client sent them, so the first of two people with one name wins.
  const candidates = [...new Set(mentionIds)].flatMap((id) => {
    const u = byId.get(id);
    return u ? [{ userId: u._id, name: u.name }] : [];
  });
  return findMentions(body, candidates);
}

async function nameOf(s: ScopedDb, userId: string): Promise<string> {
  return (await s.collection('users').findOne({ _id: userId }))?.name ?? FORMER_MEMBER;
}

function toNoteDto(doc: NoteDoc, authorName: string): Note {
  const deleted = doc.deletedAt !== null;
  return {
    id: doc._id,
    projectId: doc.projectId,
    parentId: doc.parentId,
    authorId: doc.authorId,
    authorName,
    body: deleted ? '' : doc.body,
    mentions: deleted ? [] : doc.mentions,
    createdAt: doc.createdAt.toISOString(),
    editedAt: doc.editedAt?.toISOString() ?? null,
    deleted,
  };
}

const mentionIdsOf = (mentions: Mention[]) => mentions.map((m) => m.userId);

export function registerNoteRoutes(app: FastifyInstance, deps: NoteRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const maxNotes = deps.maxNotesPerItem ?? NOTE_LIMITS.notesPerItem;
  const base = '/api/roadmaps/:roadmapId/projects/:projectId/notes';

  r.get(
    base,
    {
      config: { auth: { level: 'full', action: 'roadmap.view', roadmapParam: 'roadmapId' } },
      schema: { params: projectParams, response: { 200: noteListSchema } },
    },
    async (req) => {
      const db = req.actor!.db;
      const { roadmapId, projectId } = req.params;
      await loadProject(db, roadmapId, projectId);
      const docs = await db.collection('notes').find({ roadmapId, projectId }, { sort: { createdAt: 1, _id: 1 } });
      const users = await db.collection('users').find({ _id: { $in: [...new Set(docs.map((d) => d.authorId))] } });
      const names = new Map(users.map((u) => [u._id, u.name]));
      return { notes: docs.map((d) => toNoteDto(d, names.get(d.authorId) ?? FORMER_MEMBER)) };
    },
  );

  r.post(
    base,
    {
      config: { auth: { level: 'full', action: 'note.create', roadmapParam: 'roadmapId' } },
      schema: { params: projectParams, body: createNoteBodySchema, response: { 201: noteSchema } },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, projectId } = req.params;
      const { body, mentionIds, parentId } = req.body;
      const note = await actor.db.withTransaction(async (s) => {
        const item = await assertOpenForContent(s, roadmapId, projectId);
        const notes = s.collection('notes');
        if (parentId !== null) {
          // A deleted top-level note is kept only while it has replies, so it can take more. The delete of its last
          // reply runs assertOpenForContent too, so the two transactions conflict and never leave a reply orphaned.
          const parent = await notes.findOne({ _id: parentId, roadmapId, projectId, parentId: null });
          if (!parent) throw new HttpError(422, 'unknown_note');
        }
        if ((await notes.countDocuments({ roadmapId, projectId })) >= maxNotes) {
          throw new HttpError(422, 'too_many_notes');
        }
        const doc = await notes.insertOne({
          _id: uuidv7(),
          roadmapId,
          projectId,
          parentId,
          authorId: actor.userId,
          body,
          mentions: await mentionsIn(s, roadmapId, body, mentionIds),
          createdAt: deps.now(),
          editedAt: null,
          deletedAt: null,
        });
        const userIds = mentionIdsOf(doc.mentions);
        await notifyMentioned(s, {
          roadmapId,
          item,
          actorId: actor.userId,
          noteId: doc._id,
          noteBody: body,
          userIds,
          now: doc.createdAt,
        });
        await audit.record(s, {
          action: 'note.create',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'note', id: doc._id },
          after: { projectId, parentId, mentionIds: mentionIdsOf(doc.mentions) },
          ip: req.ip,
        });
        return toNoteDto(doc, await nameOf(s, actor.userId));
      });
      return reply.status(201).send(note);
    },
  );

  r.patch(
    `${base}/:noteId`,
    {
      config: { auth: { level: 'full', action: 'note.edit', roadmapParam: 'roadmapId', ctx: authorCtx } },
      schema: { params: noteParams, body: noteBodySchema, response: { 200: noteSchema } },
    },
    async (req) => {
      const actor = req.actor!;
      const { roadmapId, projectId, noteId } = req.params;
      const { body, mentionIds } = req.body;
      return actor.db.withTransaction(async (s) => {
        const item = await assertOpenForContent(s, roadmapId, projectId);
        const current = await loadNote(s, roadmapId, projectId, noteId);
        const mentions = await mentionsIn(s, roadmapId, body, mentionIds);
        const authorName = await nameOf(s, current.authorId);
        const sameMentions = mentionIdsOf(mentions).join('\n') === mentionIdsOf(current.mentions).join('\n');
        if (body === current.body && sameMentions) return toNoteDto(current, authorName);
        const now = deps.now();
        const updated = await s
          .collection('notes')
          .findOneAndUpdate({ _id: noteId, roadmapId, projectId }, { $set: { body, mentions, editedAt: now } });
        if (!updated) throw new HttpError(404, 'not_found');
        const before = new Set(mentionIdsOf(current.mentions));
        const added = mentionIdsOf(mentions).filter((id) => !before.has(id));
        // The rows the note wrote before follow its new text, and go for anyone it no longer mentions.
        await updateMentions(s, { roadmapId, noteId, noteBody: body, userIds: mentionIdsOf(mentions) });
        await notifyMentioned(s, { roadmapId, item, actorId: actor.userId, noteId, noteBody: body, userIds: added, now });
        await audit.record(s, {
          action: 'note.update',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'note', id: noteId },
          before: { projectId, mentionIds: mentionIdsOf(current.mentions) },
          after: { projectId, mentionIds: mentionIdsOf(mentions) },
          ip: req.ip,
        });
        return toNoteDto(updated, authorName);
      });
    },
  );

  r.delete(
    `${base}/:noteId`,
    {
      config: { auth: { level: 'full', action: 'note.delete', roadmapParam: 'roadmapId', ctx: authorCtx } },
      schema: { params: noteParams, response: noContent },
    },
    async (req, reply) => {
      const actor = req.actor!;
      const { roadmapId, projectId, noteId } = req.params;
      await actor.db.withTransaction(async (s) => {
        await assertOpenForContent(s, roadmapId, projectId);
        const note = await loadNote(s, roadmapId, projectId, noteId);
        const notes = s.collection('notes');
        // Whether the note goes or stays as a placeholder, its text leaves the mentions it sent.
        await deleteMentions(s, { roadmapId, noteIds: [noteId] });
        if (note.parentId !== null) {
          await notes.deleteOne({ _id: noteId, roadmapId });
          // A deleted note was kept only to hold its thread; with its last reply gone, it goes too.
          const parent = await notes.findOne({ _id: note.parentId, roadmapId, projectId });
          if (parent?.deletedAt && (await notes.countDocuments({ roadmapId, parentId: parent._id })) === 0) {
            await notes.deleteOne({ _id: parent._id, roadmapId });
          }
        } else if ((await notes.countDocuments({ roadmapId, parentId: noteId })) === 0) {
          await notes.deleteOne({ _id: noteId, roadmapId });
        } else {
          await notes.updateOne({ _id: noteId, roadmapId }, { $set: { body: '', mentions: [], deletedAt: deps.now() } });
        }
        await audit.record(s, {
          action: 'note.delete',
          actor: { type: 'user', userId: actor.userId },
          roadmapId,
          target: { type: 'note', id: noteId },
          before: { projectId, parentId: note.parentId, authorId: note.authorId },
          ip: req.ip,
        });
      });
      return reply.status(204).send(null);
    },
  );
}

import { randomBytes } from 'node:crypto';
import {
  cleanFileName,
  downloadLinkSchema,
  snapshotContentSchema,
  snapshotPdfRequestSchema,
  snapshotNotesSchema,
  snapshotStatusSchema,
  unlockRequestSchema,
  type SnapshotItem,
  type SnapshotNote,
  type SnapshotView,
} from '@roadmap/shared';
import type { FastifyInstance, onSendHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import { createLockout, isLocked } from '../auth/lockout.ts';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import { hashToken } from '../auth/tokens.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { SnapshotDoc, SnapshotItemDoc, SnapshotNoteDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { HttpError } from '../errors.ts';
import { DOWNLOAD_SECONDS, type ObjectStore } from '../files/object-store.ts';
import {
  SNAPSHOT_COOKIE,
  VIEWER_SESSION_MS,
  createSnapshotSession,
  isExpired,
  snapshotAccess,
} from './access.ts';
import { PdfBusyError, looksLikePdf, type PdfRenderer } from './pdf-renderer.ts';

/** PDFs being made at once by this process; a request past it is refused at once, never queued. */
export const MAX_PDF_RENDERS = 2;

const linkParams = z.object({ linkId: z.string().min(1).max(128) });
const itemParams = linkParams.extend({ itemId: z.string().min(1).max(100) });
const contentQuery = z.object({ notes: z.literal('all').optional() });
const noContent = { 204: z.null().describe('No content') };
const config = { auth: { level: 'public' } } as const;

/** Nothing a viewer sees may be kept by a browser or a proxy: not the frozen roadmap, not even a refusal. */
const noStore: onSendHookHandler = (_req, reply, payload, done) => {
  void reply.header('cache-control', 'no-store');
  done(null, payload);
};

const locked = () => new HttpError(423, 'snapshot_locked');

function toItem(doc: SnapshotItemDoc): SnapshotItem {
  return {
    id: doc.itemId,
    parentId: doc.parentId,
    depth: doc.depth,
    title: doc.title,
    description: doc.description,
    status: doc.status,
    startDate: doc.startDate,
    endDate: doc.endDate,
    milestones: doc.milestones,
    tags: doc.tags,
    links: doc.links,
    blockedBy: doc.blockedBy,
    priorityLabel: doc.priorityLabel,
    rank: doc.rank,
    ...(doc.assignees !== undefined && { assignees: doc.assignees }),
    ...(doc.noteCount !== undefined && { noteCount: doc.noteCount }),
  };
}

function toNote(doc: SnapshotNoteDoc): SnapshotNote {
  return {
    id: doc.noteId,
    itemId: doc.itemId,
    parentId: doc.parentId,
    authorName: doc.authorName,
    body: doc.body,
    mentions: doc.mentions,
    createdAt: doc.createdAt.toISOString(),
    edited: doc.edited,
    deleted: doc.deleted,
  };
}

const noteSort = { sort: { createdAt: 1, _id: 1 } } as const;
const notesOf = async (s: ScopedDb, snapshot: SnapshotDoc, itemId?: string) =>
  (await s.collection('snapshotNotes').find({ snapshotId: snapshot._id, ...(itemId !== undefined && { itemId }) }, noteSort)).map(
    toNote,
  );

/** The routes a viewer with a link and a password uses. None of them reads `req.actor`. */
export interface SnapshotPublicRouteDeps {
  db: Db;
  now: () => Date;
  objectStore: ObjectStore;
  pdfRenderer: PdfRenderer;
  /** Defaults to MAX_PDF_RENDERS. */
  maxPdfRenders?: number;
}

export function registerSnapshotPublicRoutes(app: FastifyInstance, deps: SnapshotPublicRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);
  const lockout = createLockout('snapshots', 'failedUnlocks');
  // Verified against when there is no stored hash to check, so every unlock costs one argon2 verification.
  // It hashes random bytes nobody knows, and a match against it is never accepted anyway.
  const dummyHash = hashPassword(randomBytes(32).toString('base64url'));
  const base = '/api/snapshots/:linkId';
  const maxRenders = deps.maxPdfRenders ?? MAX_PDF_RENDERS;
  // Counts only renders in flight: a PDF already stored is answered from the store and never takes a slot.
  let rendersInFlight = 0;

  r.get(
    base,
    { config, onSend: noStore, schema: { params: linkParams, response: { 200: snapshotStatusSchema } } },
    async (req) => {
      try {
        await snapshotAccess(req, deps.db, deps.now());
        return { unlocked: true };
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) return { unlocked: false };
        throw err;
      }
    },
  );

  r.post(
    `${base}/unlock`,
    { config, onSend: noStore, schema: { params: linkParams, body: unlockRequestSchema, response: noContent } },
    async (req, reply) => {
      const { linkId } = req.params;
      const now = deps.now();
      const snapshot = await lookup.findSnapshotByLinkId(linkId);
      const expired = snapshot !== null && isExpired(snapshot, now);
      const wasLocked = snapshot !== null && isLocked(snapshot, now);
      // Always run one argon2 verification. With no stored hash to check (no such link, expired, locked) it runs
      // against the dummy, and the result is never a match.
      const stored = snapshot && !expired && !wasLocked ? snapshot.passwordHash : null;
      const ok = (await verifyPassword(stored ?? (await dummyHash), req.body.password)) && stored !== null;
      if (!snapshot) throw new HttpError(404, 'not_found');
      if (expired) throw new HttpError(410, 'snapshot_expired');
      if (wasLocked) throw locked();

      const s = scoped(deps.db, snapshot.tenantId);
      const event = {
        actor: { type: 'system' as const },
        roadmapId: snapshot.roadmapId,
        target: { type: 'snapshot', id: snapshot._id },
        ip: req.ip,
      };
      if (!ok) {
        const { lockedNow } = await lockout.recordFailure(s, snapshot._id, now);
        if (!lockedNow) throw new HttpError(401, 'wrong_password');
        await audit.record(s, { action: 'snapshot.locked', ...event });
        throw locked();
      }

      const token = await s.withTransaction(async (tx) => {
        // Revoked since we read it: the link now answers as if it never existed.
        if (!(await tx.collection('snapshots').findOne({ _id: snapshot._id }))) throw new HttpError(404, 'not_found');
        // Concurrent guesses may have locked the link since we read it. Inside the transaction, a lock written after
        // this read makes the writes below conflict, and the transaction runs again and sees it.
        if (!(await lockout.assertNotLocked(tx, snapshot._id, now))) throw locked();
        await lockout.recordSuccess(tx, snapshot._id);
        await tx.collection('snapshots').updateOne({ _id: snapshot._id }, { $inc: { openCount: 1 }, $set: { lastOpenedAt: now } });
        const viewerToken = await createSnapshotSession(tx, snapshot._id, 'viewer', now);
        await audit.record(tx, { action: 'snapshot.access', ...event });
        return viewerToken;
      });
      void reply.setCookie(SNAPSHOT_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: `/api/snapshots/${linkId}`,
        maxAge: VIEWER_SESSION_MS / 1000,
      });
      return reply.status(204).send(null);
    },
  );

  r.get(
    `${base}/content`,
    {
      config,
      onSend: noStore,
      schema: { params: linkParams, querystring: contentQuery, response: { 200: snapshotContentSchema } },
    },
    async (req) => {
      const { snapshot, db } = await snapshotAccess(req, deps.db, deps.now(), { render: true });
      const items = await db
        .collection('snapshotItems')
        .find({ snapshotId: snapshot._id }, { sort: { depth: 1, rank: 1, _id: 1 } });
      const withNotes = req.query.notes === 'all' && snapshot.include.notes;
      return {
        roadmapName: snapshot.roadmapName,
        asOf: snapshot.asOf,
        frozenAt: snapshot.createdAt.toISOString(),
        include: snapshot.include,
        items: items.map(toItem),
        ...(withNotes && { notes: await notesOf(db, snapshot) }),
      };
    },
  );

  r.get(
    `${base}/items/:itemId/notes`,
    { config, onSend: noStore, schema: { params: itemParams, response: { 200: snapshotNotesSchema } } },
    async (req) => {
      const { snapshot, db } = await snapshotAccess(req, deps.db, deps.now());
      const { itemId } = req.params;
      if (!snapshot.include.notes) throw new HttpError(404, 'not_found');
      if (!(await db.collection('snapshotItems').findOne({ snapshotId: snapshot._id, itemId }))) {
        throw new HttpError(404, 'not_found');
      }
      return { notes: await notesOf(db, snapshot, itemId) };
    },
  );

  /**
   * Renders the view's print page through the PDF service, opened with a render token that is deleted before this
   * returns, and keeps the PDF only if the bytes are a PDF and the snapshot still exists. Throws 503 pdf_busy,
   * 502 pdf_failed, or 404 not_found when the snapshot was revoked meanwhile. Returns the object-store key.
   */
  async function makePdf(s: ScopedDb, snapshot: SnapshotDoc, view: SnapshotView, now: Date): Promise<string> {
    const token = await createSnapshotSession(s, snapshot._id, 'render', now);
    let bytes: Buffer;
    try {
      bytes = await deps.pdfRenderer.render({ path: `/s/${snapshot.linkId}/print/${view}`, token });
    } catch (err) {
      if (err instanceof PdfBusyError) throw new HttpError(503, 'pdf_busy');
      app.log.warn({ err: { name: (err as Error).name, message: (err as Error).message } }, 'snapshot pdf failed');
      throw new HttpError(502, 'pdf_failed');
    } finally {
      await s.collection('snapshotSessions').deleteOne({ snapshotId: snapshot._id, tokenHash: hashToken(token) });
    }
    if (!looksLikePdf(bytes)) throw new HttpError(502, 'pdf_failed');

    const key = `${snapshot.tenantId}/${snapshot.roadmapId}/snapshots/${snapshot._id}/${view}.pdf`;
    await deps.objectStore.put(key, bytes);
    const { matched } = await s.collection('snapshots').updateOne({ _id: snapshot._id }, { $set: { [`pdfs.${view}`]: key } });
    if (matched === 0) {
      // Revoked while it was being made: its revoke could not know about this file, so it goes now.
      await deps.objectStore.deleteMany([key]);
      throw new HttpError(404, 'not_found');
    }
    return key;
  }

  r.post(
    `${base}/pdf`,
    {
      config,
      onSend: noStore,
      schema: { params: linkParams, body: snapshotPdfRequestSchema, response: { 200: downloadLinkSchema } },
    },
    async (req) => {
      const now = deps.now();
      // The viewer's cookie only: a render token cannot ask for PDFs.
      const { snapshot, db } = await snapshotAccess(req, deps.db, now);
      const { view } = req.body;
      let key = snapshot.pdfs[view];
      if (key === undefined) {
        if (rendersInFlight >= maxRenders) throw new HttpError(503, 'pdf_busy');
        rendersInFlight += 1;
        try {
          key = await makePdf(db, snapshot, view, now);
        } finally {
          rendersInFlight -= 1;
        }
      }
      const fileName = cleanFileName(`${snapshot.roadmapName} ${view} ${snapshot.asOf}.pdf`);
      return { url: await deps.objectStore.signedGetUrl(key, { fileName, expiresSeconds: DOWNLOAD_SECONDS }) };
    },
  );
}

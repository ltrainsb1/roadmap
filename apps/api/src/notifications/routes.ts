import {
  NOTIFICATION_LIMITS,
  notificationPageSchema,
  notificationPrefsSchema,
  prefsResponseSchema,
  unreadCountSchema,
  type NotificationPage,
  type NotificationPrefs,
  type PrefsResponse,
} from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import type { ScopedCollection, ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { effectivePrefs, toNotifications } from './dto.ts';

type NotificationFilter = Parameters<ScopedCollection<NotificationDoc>['find']>[0];

const MAX_LIMIT = 50;

const listQuery = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(NOTIFICATION_LIMITS.pageSize),
});
const idParams = z.object({ id: z.string().min(1).max(100) });

function encodeCursor(n: NotificationDoc): string {
  return Buffer.from(`${n.createdAt.toISOString()}|${n._id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (sep < 0 || Number.isNaN(createdAt.getTime()) || id === '') throw new HttpError(400, 'bad_cursor');
  return { createdAt, id };
}

/**
 * The caller's rows the list may show: their own, on roadmaps they still belong to. Removal deletes the others; this
 * is the second guard, read once per request so the filter sits in the query and paging stays correct.
 */
async function visible(db: ScopedDb, userId: string): Promise<{ filter: NotificationFilter }> {
  const memberships = await db.collection('memberships').find({ userId });
  return { filter: { userId, roadmapId: { $in: memberships.map((m) => m.roadmapId) } } };
}

export function registerNotificationRoutes(app: FastifyInstance, deps: { now: () => Date }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  r.get(
    '/api/notifications',
    {
      config: { auth: { level: 'full' } },
      schema: { querystring: listQuery, response: { 200: notificationPageSchema } },
    },
    async (req): Promise<NotificationPage> => {
      const actor = req.actor!;
      const { limit, cursor } = req.query;
      const after = cursor === undefined ? null : decodeCursor(cursor);
      const { filter } = await visible(actor.db, actor.userId);
      const notifications = actor.db.collection('notifications');
      const paged: NotificationFilter = after
        ? {
            $and: [
              filter,
              { $or: [{ createdAt: { $lt: after.createdAt } }, { createdAt: after.createdAt, _id: { $lt: after.id } }] },
            ],
          }
        : filter;
      // One extra row tells us whether another page exists.
      const [rows, unread] = await Promise.all([
        notifications.find(paged, { sort: { createdAt: -1, _id: -1 }, limit: limit + 1 }),
        notifications.countDocuments({ ...filter, readAt: null }),
      ]);
      const items = rows.slice(0, limit);

      return {
        items: await toNotifications(actor.db, items),
        nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null,
        unread,
      };
    },
  );

  r.get(
    '/api/notifications/unread-count',
    { config: { auth: { level: 'full' } }, schema: { response: { 200: unreadCountSchema } } },
    async (req) => {
      const actor = req.actor!;
      const { filter } = await visible(actor.db, actor.userId);
      return { unread: await actor.db.collection('notifications').countDocuments({ ...filter, readAt: null }) };
    },
  );

  r.post(
    '/api/notifications/:id/read',
    { config: { auth: { level: 'full' } }, schema: { params: idParams } },
    async (req, reply) => {
      const actor = req.actor!;
      const { filter } = await visible(actor.db, actor.userId);
      const notifications = actor.db.collection('notifications');
      const mine = { ...filter, _id: req.params.id };
      // The readAt filter keeps the first read time when it is marked again.
      const done = await notifications.updateOne({ ...mine, readAt: null }, { $set: { readAt: deps.now() } });
      if (done.matched === 0 && !(await notifications.findOne(mine))) throw new HttpError(404, 'not_found');
      return reply.status(204).send(null);
    },
  );

  r.post('/api/notifications/read-all', { config: { auth: { level: 'full' } } }, async (req, reply) => {
    const actor = req.actor!;
    const { filter } = await visible(actor.db, actor.userId);
    await actor.db.collection('notifications').updateMany({ ...filter, readAt: null }, { $set: { readAt: deps.now() } });
    return reply.status(204).send(null);
  });

  r.get(
    '/api/me/notification-prefs',
    { config: { auth: { level: 'full' } }, schema: { response: { 200: prefsResponseSchema } } },
    async (req): Promise<PrefsResponse> => {
      const actor = req.actor!;
      const user = await actor.db.collection('users').findOne({ _id: actor.userId });
      if (!user) throw new HttpError(401, 'unauthenticated');
      return { prefs: effectivePrefs(user), timezone: user.timezone };
    },
  );

  r.put(
    '/api/me/notification-prefs',
    {
      config: { auth: { level: 'full' } },
      schema: { body: notificationPrefsSchema, response: { 200: prefsResponseSchema } },
    },
    async (req): Promise<PrefsResponse> => {
      const actor = req.actor!;
      const prefs: NotificationPrefs = req.body;
      return actor.db.withTransaction(async (s) => {
        const user = await s.collection('users').findOne({ _id: actor.userId });
        if (!user) throw new HttpError(401, 'unauthenticated');
        await s.collection('users').updateOne({ _id: actor.userId }, { $set: { notificationPrefs: prefs } });
        await audit.record(s, {
          action: 'user.notification_prefs',
          actor: { type: 'user', userId: actor.userId },
          target: { type: 'user', id: actor.userId },
          before: { prefs: effectivePrefs(user) },
          after: { prefs },
          ip: req.ip,
        });
        return { prefs, timezone: user.timezone };
      });
    },
  );
}

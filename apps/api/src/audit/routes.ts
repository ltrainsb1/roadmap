import { auditPageSchema, auditQuerySchema, type AuditPage } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HttpError } from '../errors.ts';
import { createAuditLog } from './audit.ts';
import { roadmapParams } from '../params.ts';


const DAY_MS = 24 * 60 * 60_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** The last instant `to` covers: a date with no time means that whole day (UTC), not its first millisecond. */
const endOf = (to: string): Date => (DATE_ONLY.test(to) ? new Date(new Date(to).getTime() + DAY_MS - 1) : new Date(to));

export function registerAuditRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  r.get(
    '/api/roadmaps/:roadmapId/audit',
    {
      config: { auth: { level: 'full', action: 'audit.view' } },
      schema: { params: roadmapParams, querystring: auditQuerySchema, response: { 200: auditPageSchema } },
    },
    async (req): Promise<AuditPage> => {
      const { from, to, ...rest } = req.query;
      const db = req.actor!.db;
      let page;
      try {
        page = await audit.list(db, {
          roadmapId: req.params.roadmapId,
          ...rest,
          ...(from !== undefined && { from: new Date(from) }),
          ...(to !== undefined && { to: endOf(to) }),
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'invalid_cursor') throw new HttpError(400, 'invalid_cursor');
        throw err;
      }

      // One lookup for the whole page; a user who no longer exists has no name.
      const ids = new Set<string>();
      for (const e of page.items) {
        if (e.actor.type === 'user') ids.add(e.actor.userId);
        if (e.actor.type === 'ai') ids.add(e.actor.onBehalfOf);
      }
      const users = ids.size > 0 ? await db.collection('users').find({ _id: { $in: [...ids] } }) : [];
      const names = new Map(users.map((u) => [u._id, u.name]));

      return {
        items: page.items.map((e) => ({
          id: e._id,
          timestamp: e.timestamp.toISOString(),
          action: e.action,
          actor:
            e.actor.type === 'user'
              ? { type: 'user', userId: e.actor.userId, name: names.get(e.actor.userId) ?? null }
              : e.actor.type === 'ai'
                ? { type: 'ai', userId: e.actor.onBehalfOf, name: names.get(e.actor.onBehalfOf) ?? null }
                : { type: 'system' },
          target: e.target,
          ...(e.before !== undefined && { before: e.before }),
          ...(e.after !== undefined && { after: e.after }),
          ip: e.ip,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
}

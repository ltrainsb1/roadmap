import { NOTIFICATION_TYPES, type NotificationPrefs } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import { createAuditLog } from '../audit/audit.ts';
import type { Db } from '../db/client.ts';
import { scoped } from '../db/scoped.ts';
import { verifyUnsubscribe } from '../mail/unsubscribe.ts';
import { effectivePrefs } from './dto.ts';

const OFF: NotificationPrefs = Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, 'off'])) as NotificationPrefs;

/** A mail client's one-click POST carries `List-Unsubscribe=One-Click` as a form; nothing in it is read. */
const IGNORED_BODY_LIMIT = 1024;

/**
 * One-click unsubscribe (RFC 8058): POST /api/email/unsubscribe?t={token} turns every notification email off. It reads
 * no session: the token, signed with the server's key, is the credential. A bad token, another key's token and a token
 * for a deleted person all get the same 404 with nothing in it. A GET is not routed, so a link scanner that opens the
 * URL changes nothing.
 */
export function registerUnsubscribeRoutes(app: FastifyInstance, deps: { db: Db; key: Buffer; now: () => Date }): void {
  const audit = createAuditLog();
  // A plugin of its own, so the form parser below exists for this route only.
  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: IGNORED_BODY_LIMIT }, (_req, _body, next) =>
      next(null, undefined),
    );
    scope.post(
      '/api/email/unsubscribe',
      {
        bodyLimit: IGNORED_BODY_LIMIT,
        config: {
          auth: { level: 'public' },
          // Per address. The global allow list exempts every route but sign-in ones; this route is limited on its own terms.
          rateLimit: { max: 30, timeWindow: '1 minute', allowList: [] },
        },
      },
      async (req, reply) => {
        const token = (req.query as { t?: unknown }).t;
        const ids = typeof token === 'string' ? verifyUnsubscribe(deps.key, token) : null;
        if (!ids) return reply.status(404).send();
        const found = await scoped(deps.db, ids.tenantId).withTransaction(async (s) => {
          const user = await s.collection('users').findOne({ _id: ids.userId });
          if (!user) return false;
          const before = effectivePrefs(user);
          // Already off: nothing changes, so nothing is recorded.
          if (NOTIFICATION_TYPES.every((type) => before[type] === 'off')) return true;
          await s.collection('users').updateOne({ _id: user._id }, { $set: { notificationPrefs: OFF } });
          await audit.record(s, {
            action: 'user.unsubscribed',
            actor: { type: 'user', userId: user._id },
            target: { type: 'user', id: user._id },
            before: { prefs: before },
            after: { prefs: OFF },
            ip: req.ip,
          });
          return true;
        });
        return found ? reply.status(200).send() : reply.status(404).send();
      },
    );
    done();
  });
}

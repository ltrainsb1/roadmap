import type { FastifyReply, FastifyRequest } from 'fastify';
import { createAuditLog } from '../audit/audit.ts';
import { recordSuccess } from './lockout.ts';
import { setSessionCookie, type SessionStore } from './sessions.ts';

const audit = createAuditLog();

/**
 * The whole sign-in is done (second factor passed): clear the failure counter, rotate the pending session
 * to a full one, audit. Returns the new CSRF token. Needs `req.actor`, so the route must resolve a session.
 */
export async function completeSignIn(
  sessions: SessionStore,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const actor = req.actor!;
  await recordSuccess(actor.db, actor.userId);
  const { token, csrfToken } = await sessions.upgrade(actor.db, actor.sessionId, 'full');
  setSessionCookie(reply, token);
  await audit.record(actor.db, {
    action: 'auth.login.success',
    actor: { type: 'user', userId: actor.userId },
    target: { type: 'user', id: actor.userId },
    ip: req.ip,
  });
  return csrfToken;
}

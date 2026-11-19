import type { FastifyReply } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { SessionDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { hashToken, newToken } from './tokens.ts';

const MIN = 60_000;
const FULL_LIFETIME_MS = 12 * 60 * MIN;
const PENDING_LIFETIME_MS = 10 * MIN;
const IDLE_TIMEOUT_MS = 30 * MIN;
const TOUCH_INTERVAL_MS = 60_000;

export const SESSION_COOKIE = '__Host-sid';

const lifetimeFor = (state: SessionDoc['state']): number =>
  state === 'full' ? FULL_LIFETIME_MS : PENDING_LIFETIME_MS;

export function createSessionStore(db: Db, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const lookup = unscoped(db);

  return {
    async create(
      s: ScopedDb,
      userId: string,
      state: SessionDoc['state'],
      meta: { ip: string; userAgent: string },
    ): Promise<{ token: string; session: SessionDoc }> {
      const { token, hash } = newToken();
      const t = now();
      const session = await s.collection('sessions').insertOne({
        _id: uuidv7(),
        userId,
        tokenHash: hash,
        state,
        csrfToken: newToken().token,
        createdAt: t,
        lastSeenAt: t,
        expiresAt: new Date(t.getTime() + lifetimeFor(state)),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { token, session };
    },

    /** Null when missing, past its absolute expiry, or idle too long. Touches lastSeenAt at most once a minute. */
    async resolve(token: string): Promise<SessionDoc | null> {
      if (!token) return null;
      const session = await lookup.findSessionByTokenHash(hashToken(token));
      if (!session) return null;
      const t = now();
      if (t >= session.expiresAt) return null;
      if (t.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) return null;
      if (t.getTime() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return session;
      await scoped(db, session.tenantId)
        .collection('sessions')
        .updateOne({ _id: session._id }, { $set: { lastSeenAt: t } });
      return { ...session, lastSeenAt: t };
    },

    /** Rotates the token so a token seen before the privilege change is worthless (session fixation). */
    async upgrade(
      s: ScopedDb,
      sessionId: string,
      state: 'full' | 'pending_enroll',
    ): Promise<{ token: string }> {
      const { token, hash } = newToken();
      const t = now();
      const { matched } = await s.collection('sessions').updateOne(
        { _id: sessionId },
        {
          $set: {
            tokenHash: hash,
            state,
            lastSeenAt: t,
            expiresAt: new Date(t.getTime() + lifetimeFor(state)),
          },
        },
      );
      if (matched === 0) throw new Error('session_not_found');
      return { token };
    },

    async revoke(s: ScopedDb, sessionId: string): Promise<void> {
      await s.collection('sessions').deleteOne({ _id: sessionId });
    },

    async revokeAllForUser(s: ScopedDb, userId: string): Promise<number> {
      return (await s.collection('sessions').deleteMany({ userId })).deleted;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export function setSessionCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(SESSION_COOKIE, token, cookieOptions);
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, cookieOptions);
}

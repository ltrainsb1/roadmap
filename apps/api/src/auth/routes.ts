import {
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  type MeResponse,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createAuditLog } from '../audit/audit.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { scoped } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import type { AuthConfig } from '../policy/hook.ts';
import { HttpError } from '../errors.ts';
import { isLocked, recordFailure, recordSuccess } from './lockout.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { clearSessionCookie, setSessionCookie } from './sessions.ts';

export interface AuthRouteDeps {
  db: Db;
  config: Config;
  now: () => Date;
  fetch?: typeof fetch;
}

// Verified against when the email is unknown, so "no such user" costs the same as "wrong password".
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing'));

/** Second factors the user has set up. The TOTP and passkey tasks only fill these in. */
function factorsOf(user: UserDoc): { hasTotp: boolean; passkeys: MeResponse['user']['passkeys'] } {
  return {
    hasTotp: Boolean(user.totp),
    passkeys: (user.passkeys ?? []).map((p) => ({
      id: p.credentialId,
      name: p.name,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

const requestMeta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();
  const lookup = unscoped(deps.db);
  const anySession: AuthConfig = { level: 'pending', states: ['pending_mfa', 'pending_enroll', 'full'] };

  r.post(
    '/api/auth/login',
    {
      config: { auth: { level: 'public' } },
      schema: { body: loginRequestSchema, response: { 200: loginResponseSchema } },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const now = deps.now();
      const user = await lookup.findUserByEmail(email);
      const locked = user !== null && isLocked(user, now);
      // Always run one argon2 verification; a locked account is not verified at all but still pays for the dummy.
      const hashToCheck = user?.passwordHash && !locked ? user.passwordHash : await getDummyHash();
      const ok = await verifyPassword(hashToCheck, password);

      if (!user || !ok || locked) {
        if (user) {
          const s = scoped(deps.db, user.tenantId);
          if (!locked) await recordFailure(s, user._id, now);
          await audit.record(s, {
            action: 'auth.login.failure',
            actor: { type: 'system' },
            target: { type: 'user', id: user._id },
            ip: req.ip,
          });
        }
        throw new HttpError(401, 'invalid_credentials');
      }

      const s = scoped(deps.db, user.tenantId);
      await recordSuccess(s, user._id);
      const f = factorsOf(user);
      const hasSecondFactor = f.hasTotp || f.passkeys.length > 0;
      const { token, session } = await app.sessions.create(
        s,
        user._id,
        hasSecondFactor ? 'pending_mfa' : 'pending_enroll',
        requestMeta(req),
      );
      setSessionCookie(reply, token);
      return { next: hasSecondFactor ? ('mfa' as const) : ('enroll' as const), csrfToken: session.csrfToken };
    },
  );

  r.post('/api/auth/logout', { config: { auth: anySession } }, async (req, reply) => {
    const actor = req.actor!;
    await audit.record(actor.db, {
      action: 'auth.logout',
      actor: { type: 'user', userId: actor.userId },
      target: { type: 'user', id: actor.userId },
      ip: req.ip,
    });
    await app.sessions.revoke(actor.db, actor.sessionId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  r.post('/api/auth/logout-all', { config: { auth: { level: 'full' } } }, async (req, reply) => {
    const actor = req.actor!;
    await audit.record(actor.db, {
      action: 'auth.logout_all',
      actor: { type: 'user', userId: actor.userId },
      target: { type: 'user', id: actor.userId },
      ip: req.ip,
    });
    await app.sessions.revokeAllForUser(actor.db, actor.userId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  r.get(
    '/api/me',
    { config: { auth: { level: 'full' } }, schema: { response: { 200: meResponseSchema } } },
    async (req) => {
      const actor = req.actor!;
      const user = await actor.db.collection('users').findOne({ _id: actor.userId });
      if (!user) throw new HttpError(401, 'unauthenticated');
      const memberships = await actor.db.collection('memberships').find({ userId: actor.userId });
      const roadmaps = await actor.db
        .collection('roadmaps')
        .find({ _id: { $in: memberships.map((m) => m.roadmapId) } });
      const live = new Map(roadmaps.filter((rm) => !rm.archivedAt).map((rm) => [rm._id, rm.name]));
      return {
        user: { id: user._id, email: user.email, name: user.name, timezone: user.timezone, ...factorsOf(user) },
        csrfToken: actor.csrfToken,
        memberships: memberships
          .filter((m) => live.has(m.roadmapId))
          .map((m) => ({ roadmapId: m.roadmapId, roadmapName: live.get(m.roadmapId)!, role: m.role }))
          .sort((a, b) => a.roadmapName.localeCompare(b.roadmapName)),
      };
    },
  );
}

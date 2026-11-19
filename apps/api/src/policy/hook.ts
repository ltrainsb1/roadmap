import { timingSafeEqual } from 'node:crypto';
import type { Action, Role } from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createSessionStore, SESSION_COOKIE, type SessionStore } from '../auth/sessions.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { SessionDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { can, type PolicyContext } from './policy.ts';

export type AuthConfig =
  | { level: 'public' }
  | { level: 'pending'; states: Array<SessionDoc['state']> }
  | {
      level: 'full';
      action?: Action;
      /** Route param holding the roadmap id; defaults to `roadmapId`. */
      roadmapParam?: string;
      ctx?: (req: FastifyRequest) => Promise<PolicyContext>;
    };

export interface Actor {
  userId: string;
  tenantId: string;
  sessionId: string;
  csrfToken: string;
  role: Role | null;
  db: ScopedDb;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
  interface FastifyContextConfig {
    auth?: AuthConfig;
  }
  interface FastifyInstance {
    sessions: SessionStore;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function csrfMatches(sent: unknown, expected: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deny by default: every route must declare `config.auth`, or startup fails. The hook then
 * enforces the declared level (session, MFA state, CSRF, roadmap membership, policy).
 */
export const authPlugin = fp(
  (app: FastifyInstance, opts: { db: Db; now?: () => Date }) => {
    const sessions = createSessionStore(opts.db, opts.now ? { now: opts.now } : {});
    app.decorate('sessions', sessions);
    app.decorateRequest('actor', null);

    const undeclared: string[] = [];
    app.addHook('onRoute', (route) => {
      if (route.config?.auth) return;
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) undeclared.push(`${m} ${route.url}`);
    });
    app.addHook('onReady', () => {
      const first = undeclared[0];
      if (first !== undefined) throw new Error(`route_without_auth_config: ${first}`);
    });

    app.addHook('onRequest', async (req) => {
      const auth = req.routeOptions.config.auth;
      if (!auth) return; // only the not-found handler gets here; startup refuses real routes

      const token = req.cookies[SESSION_COOKIE];
      const session = token ? await sessions.resolve(token) : null;
      if (session) {
        req.actor = {
          userId: session.userId,
          tenantId: session.tenantId,
          sessionId: session._id,
          csrfToken: session.csrfToken,
          role: null,
          db: scoped(opts.db, session.tenantId),
        };
      }
      if (auth.level === 'public') return;

      if (!session || !req.actor) throw new HttpError(401, 'unauthenticated');
      const allowed = auth.level === 'full' ? ['full'] : auth.states;
      if (!allowed.includes(session.state)) throw new HttpError(403, 'mfa_required');
      if (!SAFE_METHODS.has(req.method) && !csrfMatches(req.headers['x-csrf-token'], session.csrfToken)) {
        throw new HttpError(403, 'csrf');
      }
      if (auth.level !== 'full' || !auth.action) return;

      // 404 for both "no such roadmap" and "not yours", so existence is not revealed.
      const params = req.params as Record<string, unknown>;
      const roadmapId = params[auth.roadmapParam ?? 'roadmapId'];
      if (typeof roadmapId !== 'string') throw new HttpError(404, 'not_found');
      const membership = await req.actor.db
        .collection('memberships')
        .findOne({ roadmapId, userId: req.actor.userId });
      if (!membership) throw new HttpError(404, 'not_found');
      req.actor.role = membership.role;
      const ctx = auth.ctx ? await auth.ctx(req) : undefined;
      if (!can({ role: membership.role, action: auth.action, ...(ctx ? { ctx } : {}) })) {
        throw new HttpError(403, 'forbidden');
      }
    });
  },
  { name: 'auth' },
);

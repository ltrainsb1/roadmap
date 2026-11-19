import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { registerErrorHandling } from './errors.ts';
import { registerPasskeyRoutes } from './auth/passkey-routes.ts';
import type { PasskeyVerifiers } from './auth/passkeys.ts';
import { registerResetRoutes } from './auth/reset-routes.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerInviteRoutes } from './invites/routes.ts';
import { registerRoadmapRoutes } from './roadmaps/routes.ts';
import { createMailer, type Mailer } from './mail/mailer.ts';
import { authPlugin } from './policy/hook.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Clock for session lifetimes; tests replace it. */
  now?: () => Date;
  /** Replaces global fetch; used only by the breached-password check. */
  fetch?: typeof fetch;
  /** Replaces the WebAuthn verifiers; tests stub them because real ceremonies need a browser. */
  webauthn?: PasskeyVerifiers;
  /** Outgoing email; defaults to the mailer named in the config. */
  mailer?: Mailer;
}

const AUTH_PREFIX = '/api/auth/';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const production = deps.config.nodeEnv === 'production';
  // In production Caddy is the only client, so the real IP (for rate limiting) is in X-Forwarded-For.
  const app = Fastify({ logger: production, trustProxy: production });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });
  // Default in-memory store: one per app instance. Only sign-in style endpoints are limited.
  await app.register(rateLimit, {
    global: true,
    max: 10,
    timeWindow: '1 minute',
    // Match on the routed pattern: the raw URL can be percent-encoded (/api/%61uth/...).
    allowList: (req) => !(req.routeOptions.url ?? '').startsWith(AUTH_PREFIX),
  });
  await app.register(cookie);
  await app.register(authPlugin, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) });

  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/health',
    {
      config: { auth: { level: 'public' } },
      schema: { response: { 200: z.object({ status: z.literal('ok') }) } },
    },
    () => ({ status: 'ok' as const }),
  );

  registerAuthRoutes(app, {
    db: deps.db,
    config: deps.config,
    now: deps.now ?? (() => new Date()),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  registerPasskeyRoutes(app, {
    db: deps.db,
    config: deps.config,
    now: deps.now ?? (() => new Date()),
    ...(deps.webauthn ? { webauthn: deps.webauthn } : {}),
  });

  const mailer = deps.mailer ?? createMailer(deps.config);
  const now = deps.now ?? (() => new Date());

  registerResetRoutes(app, {
    db: deps.db,
    config: deps.config,
    mailer,
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  registerRoadmapRoutes(app);

  registerInviteRoutes(app, {
    db: deps.db,
    config: deps.config,
    mailer,
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  return app;
}

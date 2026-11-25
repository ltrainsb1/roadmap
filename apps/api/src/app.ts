import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LIMITS, NOTE_LIMITS } from '@roadmap/shared';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { registerErrorHandling } from './errors.ts';
import { serializeRequest } from './logging.ts';
import { registerPasskeyRoutes } from './auth/passkey-routes.ts';
import type { PasskeyVerifiers } from './auth/passkeys.ts';
import { registerResetRoutes } from './auth/reset-routes.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerInviteRoutes } from './invites/routes.ts';
import { registerAttachmentRoutes } from './attachments/routes.ts';
import { registerAuditRoutes } from './audit/routes.ts';
import { registerCalendarFeedRoutes } from './calendar/feed-routes.ts';
import { registerCalendarItemRoutes } from './calendar/item-routes.ts';
import { registerCalendarPublicRoutes } from './calendar/public-routes.ts';
import { registerMemberRoutes } from './members/routes.ts';
import { registerNoteRoutes } from './notes/routes.ts';
import { registerNotificationRoutes } from './notifications/routes.ts';
import { registerUnsubscribeRoutes } from './notifications/unsubscribe-routes.ts';
import { registerAssignRoutes } from './projects/assign-routes.ts';
import { registerPriorityRoutes } from './projects/priority-routes.ts';
import { registerLifecycleRoutes } from './projects/lifecycle-routes.ts';
import { registerProjectRoutes } from './projects/routes.ts';
import { registerRoadmapRoutes } from './roadmaps/routes.ts';
import { createPdfRenderer, type PdfRenderer } from './snapshots/pdf-renderer.ts';
import { registerSnapshotPublicRoutes } from './snapshots/public-routes.ts';
import { registerSnapshotRoutes } from './snapshots/routes.ts';
import { registerLocalFileRoutes } from './files/local-routes.ts';
import { createObjectStore, LocalObjectStore, MemoryObjectStore, type ObjectStore } from './files/object-store.ts';
import { createScanner, type Scanner } from './files/scanner.ts';
import { createMailer, type Mailer } from './mail/mailer.ts';
import { authPlugin } from './policy/hook.ts';
import { addressMatcher } from './trusted-proxy.ts';

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
  /** Most items one roadmap may hold; defaults to the shared limit. Tests lower it. */
  maxProjectItems?: number;
  /** Most notes one item may hold; defaults to the shared limit. Tests lower it. */
  maxNotesPerItem?: number;
  /** Most files one item may hold; defaults to the shared limit. Tests lower it. */
  maxFilesPerItem?: number;
  /** Uploads read at once; defaults to MAX_CONCURRENT_UPLOADS. Tests change it. */
  maxConcurrentUploads?: number;
  /** How long an upload's body may take to arrive; defaults to UPLOAD_READ_TIMEOUT_MS. Tests shorten it. */
  uploadReadTimeoutMs?: number;
  /** Most snapshots one roadmap may hold; defaults to the shared limit. Tests lower it. */
  maxSnapshots?: number;
  /** Most notes one snapshot may hold; defaults to the shared limit. Tests lower it. */
  maxSnapshotNotes?: number;
  /** Where attachments are kept; defaults to the store named in the config. */
  objectStore?: ObjectStore;
  /** Virus scanner for uploads; defaults to the scanner named in the config. */
  scanner?: Scanner;
  /** Prints snapshot PDFs; defaults to the renderer named in the config. */
  pdfRenderer?: PdfRenderer;
  /** PDFs made at once by this process; defaults to MAX_PDF_RENDERS. Tests change it. */
  maxPdfRenders?: number;
}

const AUTH_PREFIX = '/api/auth/';
/** Other routes that check a password before anyone is signed in, limited at the sign-in rate. */
const RATE_LIMITED_ROUTES = new Set(['/api/snapshots/:linkId/unlock']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const production = deps.config.nodeEnv === 'production';
  // In production Caddy is the single proxy in front of the API and appends the client address to
  // X-Forwarded-For. Trust that one hop only (entries the client supplied sit further left and must not count), and
  // only when the connected peer is inside TRUSTED_PROXY_CIDR, the network Caddy alone shares with the API. Any other
  // peer (the PDF service, which also reaches the API directly) is taken at its own address, whatever it sends.
  // (A numeric trustProxy is not used: this Fastify version treats a bare hop count as "trust nobody". The CIDR form
  // is not used either: it would trust every hop inside the range, not just the first.)
  const isTrustedProxy = addressMatcher(deps.config.trustedProxyCidrs);
  const trustCaddyOneHop = (address: string, hop: number) => hop < 1 && isTrustedProxy(address);
  const app = Fastify({
    logger: production ? { serializers: { req: serializeRequest } } : false,
    trustProxy: production ? trustCaddyOneHop : false,
  });
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
    max: deps.config.authRateLimitPerMin,
    timeWindow: '1 minute',
    // Match on the routed pattern: the raw URL can be percent-encoded (/api/%61uth/...).
    allowList: (req) => {
      const url = req.routeOptions.url ?? '';
      return !url.startsWith(AUTH_PREFIX) && !RATE_LIMITED_ROUTES.has(url);
    },
  });
  await app.register(swagger, {
    openapi: { info: { title: 'Roadmap API', version: '1.0.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(cookie);
  // Only the upload route reads multipart bodies: one part named `file`, no other fields.
  await app.register(multipart, { limits: { fileSize: NOTE_LIMITS.fileBytes, files: 1, fields: 0 } });
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
  const objectStore = deps.objectStore ?? createObjectStore(deps.config);
  const scanner = deps.scanner ?? createScanner(deps.config);

  registerResetRoutes(app, {
    db: deps.db,
    config: deps.config,
    mailer,
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  registerRoadmapRoutes(app, { now });
  registerNotificationRoutes(app, { now });
  registerUnsubscribeRoutes(app, { db: deps.db, key: deps.config.unsubscribeKey, now });
  registerCalendarFeedRoutes(app, { now, origin: deps.config.appOrigin });
  registerCalendarItemRoutes(app, { origin: deps.config.appOrigin });
  registerCalendarPublicRoutes(app, { db: deps.db, now, origin: deps.config.appOrigin });

  registerInviteRoutes(app, {
    db: deps.db,
    config: deps.config,
    mailer,
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  registerMemberRoutes(app, { now, objectStore });
  registerAuditRoutes(app);
  registerProjectRoutes(app, { now, maxItems: deps.maxProjectItems ?? LIMITS.itemsPerRoadmap });

  registerAssignRoutes(app, { now });
  registerPriorityRoutes(app, { now });
  registerLifecycleRoutes(app, { objectStore });
  registerNoteRoutes(app, { now, ...(deps.maxNotesPerItem !== undefined && { maxNotesPerItem: deps.maxNotesPerItem }) });
  registerAttachmentRoutes(app, {
    now,
    objectStore,
    scanner,
    ...(deps.maxFilesPerItem !== undefined && { maxFilesPerItem: deps.maxFilesPerItem }),
    ...(deps.maxConcurrentUploads !== undefined && { maxConcurrentUploads: deps.maxConcurrentUploads }),
    ...(deps.uploadReadTimeoutMs !== undefined && { uploadReadTimeoutMs: deps.uploadReadTimeoutMs }),
  });

  registerSnapshotRoutes(app, {
    now,
    objectStore,
    ...(deps.maxSnapshots !== undefined && { maxSnapshots: deps.maxSnapshots }),
    ...(deps.maxSnapshotNotes !== undefined && { maxNotes: deps.maxSnapshotNotes }),
  });

  registerSnapshotPublicRoutes(app, {
    db: deps.db,
    now,
    objectStore,
    pdfRenderer: deps.pdfRenderer ?? createPdfRenderer(deps.config),
    ...(deps.maxPdfRenders !== undefined && { maxPdfRenders: deps.maxPdfRenders }),
  });

  // Only stores that keep files on this server need the API to serve them; S3 links go straight to S3.
  if (objectStore instanceof LocalObjectStore || objectStore instanceof MemoryObjectStore) {
    registerLocalFileRoutes(app, objectStore);
  }

  app.get('/api/openapi.json', { config: { auth: { level: 'public' } } }, () => app.swagger());

  return app;
}

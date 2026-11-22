import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BusyError, createLimiter } from './limiter.ts';

/** Prints `url` (already checked to be a snapshot print page on the render origin) and resolves with the PDF. */
export interface Render {
  (input: { url: string; token: string; timeoutMs: number }): Promise<Buffer>;
}

/** The render did not finish in time: the page never became ready, or Chromium was too slow. */
export class RenderTimeoutError extends Error {
  constructor() {
    super('the render timed out');
    this.name = 'RenderTimeoutError';
  }
}

/** The only pages this service prints. Anchored at both ends, with no room for a query, a fragment or `//`. */
export const RENDER_PATH = /^\/s\/[A-Za-z0-9_-]{20,64}\/print\/(list|timeline)$/;

/** A token is sent as a header value: visible ASCII only, so it cannot break or add a header. */
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** True for `http(s)://host[:port]` exactly: no path, no trailing slash, no user info. */
export function isBareOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** A snapshot link id is half of what opens it: logs keep its first 6 characters, as the API's logs do. */
const redactLinks = (text: string) => text.replace(/(\/s\/[A-Za-z0-9_-]{0,6})[A-Za-z0-9_-]*/g, '$1…');

export interface PdfConfig {
  port: number;
  renderOrigin: string;
  maxRenders: number;
  timeoutMs: number;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  RENDER_ORIGIN: z
    .string()
    .transform((v) => v.replace(/\/$/, ''))
    .refine(isBareOrigin, 'must be an http: or https: origin, with no path'),
  MAX_RENDERS: z.coerce.number().int().min(1).default(2),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(1).default(45_000),
});

export function loadPdfConfig(env: Record<string, string | undefined>): PdfConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const { PORT, RENDER_ORIGIN, MAX_RENDERS, RENDER_TIMEOUT_MS } = parsed.data;
  return { port: PORT, renderOrigin: RENDER_ORIGIN, maxRenders: MAX_RENDERS, timeoutMs: RENDER_TIMEOUT_MS };
}

export function buildPdfApp(deps: {
  render: Render;
  renderOrigin: string;
  maxRenders: number;
  timeoutMs: number;
  logger?: boolean;
}): FastifyInstance {
  if (!isBareOrigin(deps.renderOrigin)) throw new Error('renderOrigin must be a bare http: or https: origin');
  const limiter = createLimiter(deps.maxRenders);
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode;
    if (status !== undefined && status >= 400 && status < 500) return reply.status(status).send({ error: 'bad_request' });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });

  app.get('/health', () => ({ status: 'ok' }));

  app.post('/render', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown; token?: unknown };
    const { path, token } = body;
    if (typeof path !== 'string' || !RENDER_PATH.test(path)) return reply.status(400).send({ error: 'bad_path' });
    if (typeof token !== 'string' || !TOKEN.test(token)) return reply.status(400).send({ error: 'bad_token' });
    const url = new URL(path, deps.renderOrigin);
    // RENDER_PATH already rules this out; checked again so a later change to it cannot point Chromium elsewhere.
    if (url.origin !== deps.renderOrigin) return reply.status(400).send({ error: 'bad_path' });

    // The slot stays taken until Chromium is really done, even when the reply has already gone out at the deadline.
    const job = limiter.run(() => deps.render({ url: url.href, token, timeoutMs: deps.timeoutMs }));
    job.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RenderTimeoutError()), deps.timeoutMs);
    });
    try {
      const pdf = await Promise.race([job, deadline]);
      return reply.status(200).type('application/pdf').header('cache-control', 'no-store').send(pdf);
    } catch (err) {
      if (err instanceof BusyError) return reply.status(503).send({ error: 'busy' });
      if (err instanceof RenderTimeoutError) return reply.status(504).send({ error: 'timeout' });
      const e = err as Error;
      req.log.error({ err: { name: e.name, message: redactLinks(String(e.message)) } }, 'render failed');
      return reply.status(502).send({ error: 'render_failed' });
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}

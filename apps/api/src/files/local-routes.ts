import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../errors.ts';
import { contentDisposition, type LocalObjectStore, type MemoryObjectStore } from './object-store.ts';

/** Longer than any link this app signs (a 200-character name is well under it); longer ones are not looked at. */
const MAX_TOKEN = 4096;

/**
 * Downloads for the stores that keep files on this server (local and E2E runs, API tests). In production files
 * are in S3 and this route does not exist. The signed token is the only credential: no session is needed, as
 * with an S3 pre-signed link.
 */
export function registerLocalFileRoutes(app: FastifyInstance, store: LocalObjectStore | MemoryObjectStore): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/files/local',
    {
      config: { auth: { level: 'public' } },
      schema: { querystring: z.object({ token: z.string().optional() }) },
    },
    async (req, reply) => {
      const token = req.query.token;
      const found = token && token.length <= MAX_TOKEN ? await store.read(token) : null;
      if (!found) throw new HttpError(404, 'not_found');
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', contentDisposition(found.fileName))
        .header('x-content-type-options', 'nosniff')
        .send(found.body);
    },
  );
}

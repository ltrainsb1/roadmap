import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Every error leaves as JSON `{ error: '<snake_case_code>' }`; internals never reach the client. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found' }));

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code });
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: 'validation', issues: err.validation });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', issues: err.issues });
    }
    const status = (err as FastifyError).statusCode;
    if (status === 429) return reply.status(429).send({ error: 'rate_limited' });
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'bad_request' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal' });
  });
}

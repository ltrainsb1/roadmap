import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

// Later tasks add fields (database handle, config, clock, ...).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type AppDeps = {};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  void deps;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/health',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    () => ({ status: 'ok' as const }),
  );

  return app;
}

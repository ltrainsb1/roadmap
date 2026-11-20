import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { redactUrl, serializeRequest } from '../src/logging.ts';

test('redactUrl replaces an invite token in the path and leaves other URLs alone', () => {
  expect(redactUrl('/api/invites/s3cret-Tok_en')).toBe('/api/invites/[redacted]');
  expect(redactUrl('/api/invites/s3cret-Tok_en/accept')).toBe('/api/invites/[redacted]/accept');
  expect(redactUrl('/api/invites/s3cret-Tok_en?x=1')).toBe('/api/invites/[redacted]?x=1');
  expect(redactUrl('/API/Invites/s3cret')).toBe('/API/Invites/[redacted]');
  expect(redactUrl('/api/roadmaps/r1/invites/i1')).toBe('/api/roadmaps/r1/invites/i1');
  expect(redactUrl('/api/health')).toBe('/api/health');
});

test('the request log Fastify writes carries no invite token', async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const app = Fastify({ logger: { stream, serializers: { req: serializeRequest } } });
  app.get('/api/invites/:token', () => ({ ok: true }));
  app.post('/api/invites/:token/accept', () => ({ ok: true }));
  await app.inject({ url: '/api/invites/s3cret-Tok_en' });
  await app.inject({ method: 'POST', url: '/api/invites/s3cret-Tok_en/accept' });
  await app.close();

  const logged = lines.join('');
  expect(logged).toContain('/api/invites/[redacted]');
  expect(logged).toContain('/api/invites/[redacted]/accept');
  expect(logged).not.toContain('s3cret-Tok_en');
});

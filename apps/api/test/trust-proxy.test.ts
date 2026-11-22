import { afterAll, beforeAll, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({
    // Production config needs the production drivers named; the test app still gets the memory store and fake scanner.
    env: { NODE_ENV: 'production', FILES: 's3', S3_BUCKET: 'unused', SCANNER: 'clamd', CLAMD_HOST: 'unused' },
    routes: (app) => {
      app.get('/api/t/ip', { config: { auth: { level: 'public' } } }, (req) => ({ ip: req.ip }));
    },
  });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

test('production trusts exactly one proxy hop, so a client-supplied X-Forwarded-For entry is ignored', async () => {
  const res = await t.app.inject({
    method: 'GET',
    url: '/api/t/ip',
    headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    remoteAddress: '10.0.0.5',
  });
  expect(res.json()).toEqual({ ip: '2.2.2.2' });
});

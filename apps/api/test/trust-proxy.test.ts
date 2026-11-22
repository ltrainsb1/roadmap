import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

/** Production drivers named for the config; the test app still gets the memory store, fake scanner and fake renderer. */
const PRODUCTION = {
  NODE_ENV: 'production',
  FILES: 's3',
  S3_BUCKET: 'unused',
  SCANNER: 'clamd',
  CLAMD_HOST: 'unused',
  PDF: 'service',
  PDF_URL: 'http://unused',
  // Caddy's network; the PDF service and anything else that reaches the API sit outside it.
  TRUSTED_PROXY_CIDR: '10.0.0.0/24',
  AUTH_RATE_LIMIT_PER_MIN: '3',
};

const ipRoutes = (app: TestApp['app']) => {
  app.get('/api/t/ip', { config: { auth: { level: 'public' } } }, (req) => ({ ip: req.ip }));
  // Under /api/auth/, so it is in the sign-in rate limit.
  app.get('/api/auth/t-ip', { config: { auth: { level: 'public' } } }, (req) => ({ ip: req.ip }));
};

describe('in production', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: PRODUCTION, routes: ipRoutes });
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  const ipOf = async (remoteAddress: string, xff: string, url = '/api/t/ip') => {
    const res = await t.app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': xff }, remoteAddress });
    return res;
  };

  test('production trusts exactly one proxy hop, so a client-supplied X-Forwarded-For entry is ignored', async () => {
    expect((await ipOf('10.0.0.5', '1.1.1.1, 2.2.2.2')).json()).toEqual({ ip: '2.2.2.2' });
  });

  test('FR-3.6: a peer inside TRUSTED_PROXY_CIDR sets the client address from X-Forwarded-For, also as an IPv4-mapped address', async () => {
    expect((await ipOf('10.0.0.200', '203.0.113.9')).json()).toEqual({ ip: '203.0.113.9' });
    expect((await ipOf('::ffff:10.0.0.7', '203.0.113.9')).json()).toEqual({ ip: '203.0.113.9' });
  });

  test('FR-3.6: a peer outside TRUSTED_PROXY_CIDR cannot choose its address: X-Forwarded-For is ignored', async () => {
    expect((await ipOf('10.0.1.5', '203.0.113.9')).json()).toEqual({ ip: '10.0.1.5' });
    expect((await ipOf('172.30.0.3', '10.0.0.5, 203.0.113.9')).json()).toEqual({ ip: '172.30.0.3' });
  });

  test('FR-3.6: a peer outside TRUSTED_PROXY_CIDR gets one rate-limit bucket, whatever X-Forwarded-For it sends', async () => {
    const codes: number[] = [];
    for (let i = 1; i <= 4; i++) codes.push((await ipOf('10.0.2.9', `203.0.113.${i}`, '/api/auth/t-ip')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  test('FR-3.6: through the trusted proxy, each client address gets its own rate-limit bucket', async () => {
    const codes: number[] = [];
    for (let i = 1; i <= 4; i++) codes.push((await ipOf('10.0.0.5', `198.51.100.${i}`, '/api/auth/t-ip')).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
  });
});

describe('outside production', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ env: { TRUSTED_PROXY_CIDR: '10.0.0.0/24' }, routes: ipRoutes });
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  test('FR-3.6: outside production no peer is trusted, even one inside TRUSTED_PROXY_CIDR', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/t/ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      remoteAddress: '10.0.0.5',
    });
    expect(res.json()).toEqual({ ip: '10.0.0.5' });
  });
});

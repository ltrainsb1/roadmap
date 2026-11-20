import { afterAll, beforeAll, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

test('GET /api/health returns ok', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});

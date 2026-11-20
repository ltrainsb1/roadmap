import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

/** Paths from the router's own tree listing: each node is a path fragment nested under its parent's. */
function routerPaths(tree: string): Set<string> {
  const paths = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^((?:[│ ]{4})*)[├└]── (\S+) \(/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const full = stack.join('');
    if (full.startsWith('/api')) paths.add(full.replace(/:(\w+)/g, '{$1}'));
  }
  return paths;
}

describe('OpenAPI document', () => {
  test('is public and lists every /api route', async () => {
    const res = await t.app.inject({ url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{ openapi: string; paths: Record<string, Record<string, unknown>> }>();
    expect(doc.openapi).toMatch(/^3\./);
    const routes = routerPaths(t.app.printRoutes({ commonPrefix: false }));
    expect(routes).toContain('/api/health');
    expect(routes).toContain('/api/roadmaps/{roadmapId}/audit');
    expect([...routes].filter((p) => !(p in doc.paths))).toEqual([]);
    expect(Object.keys(doc.paths).filter((p) => !routes.has(p))).toEqual([]);
    expect(Object.keys(doc.paths['/api/roadmaps/{roadmapId}/members']!)).toContain('get');
    expect(doc.paths['/api/roadmaps/{roadmapId}/transfer']!.post).toHaveProperty('requestBody');
  });

  test('needs no session', async () => {
    const res = await t.app.inject({ url: '/api/openapi.json', headers: { cookie: '__Host-sid=garbage' } });
    expect(res.statusCode).toBe(200);
  });
});

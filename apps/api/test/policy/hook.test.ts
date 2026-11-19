import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { afterEach, describe, expect, test } from 'vitest';
import { clearSessionCookie, setSessionCookie } from '../../src/auth/sessions.ts';
import { scoped } from '../../src/db/scoped.ts';
import { ACTIONS, ROLES } from '@roadmap/shared';
import { canEver, can } from '../../src/policy/policy.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';

const open: TestApp[] = [];
async function setup(routes?: (app: FastifyInstance) => void): Promise<TestApp> {
  const t = await makeTestApp(routes ? { routes } : {});
  open.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

const ok = () => ({ ok: true });

function routes(app: FastifyInstance): void {
  app.get('/api/t/public', { config: { auth: { level: 'public' } } }, (req) => ({
    actor: req.actor?.userId ?? null,
  }));
  app.get('/api/t/full', { config: { auth: { level: 'full' } } }, (req) => ({
    userId: req.actor?.userId,
    role: req.actor?.role,
  }));
  app.post('/api/t/full', { config: { auth: { level: 'full' } } }, ok);
  app.post('/api/t/public', { config: { auth: { level: 'public' } } }, ok);
  app.get(
    '/api/t/pending',
    { config: { auth: { level: 'pending', states: ['pending_mfa'] } } },
    ok,
  );
  app.get(
    '/api/t/r/:roadmapId/view',
    { config: { auth: { level: 'full', action: 'roadmap.view' } } },
    (req) => ({ role: req.actor?.role }),
  );
  app.get(
    '/api/t/r/:roadmapId/audit',
    { config: { auth: { level: 'full', action: 'audit.view' } } },
    ok,
  );
  app.get(
    '/api/t/x/:rid/edit',
    {
      config: {
        auth: {
          level: 'full',
          action: 'project.edit',
          roadmapParam: 'rid',
          ctx: (req) => Promise.resolve({ isAssigned: req.headers['x-assigned'] === '1' }),
        },
      },
    },
    ok,
  );
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/t/r/:roadmapId/members',
    {
      config: {
        auth: {
          level: 'full',
          action: 'member.invite',
          ctx: (req) => Promise.resolve({ newRole: (req.body as { role: 'admin' }).role }),
        },
      },
      schema: { body: z.object({ role: z.enum(['admin', 'contributor']) }) },
    },
    ok,
  );
  app.post('/api/auth/ping', { config: { auth: { level: 'public' } } }, ok);
  app.get('/api/t/cookie-set', { config: { auth: { level: 'public' } } }, (_req, reply) => {
    setSessionCookie(reply, 'tok');
    return ok();
  });
  app.get('/api/t/cookie-clear', { config: { auth: { level: 'public' } } }, (_req, reply) => {
    clearSessionCookie(reply);
    return ok();
  });
  app.get('/api/t/boom', { config: { auth: { level: 'public' } } }, () => {
    throw new Error('secret internals');
  });
}

describe('deny-by-default', () => {
  test('a route without config.auth makes ready() throw', async () => {
    const t = await setup((app) => app.get('/api/t/forgot', () => ({ ok: true })));
    await expect(t.app.ready()).rejects.toThrow('route_without_auth_config: GET /api/t/forgot');
  });

  test('the shipped routes and test routes all declare auth, so ready() succeeds', async () => {
    const t = await setup(routes);
    await expect(t.app.ready()).resolves.toBeDefined();
  });

  test('a full route with no cookie returns 401', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/full' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
  });

  test('a garbage cookie returns 401', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/full', headers: { cookie: '__Host-sid=garbage' } });
    expect(res.statusCode).toBe(401);
  });

  test('a valid full session passes and sets req.actor', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const { cookie } = await signInAs(t.app, t.db, u._id);
    const res = await t.app.inject({ url: '/api/t/full', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: u._id, role: null });
  });

  test('public routes work without a session, with actor null', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/public' });
    expect(res.json()).toEqual({ actor: null });
  });

  test('public routes still resolve a valid session', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const { cookie } = await signInAs(t.app, t.db, u._id);
    const res = await t.app.inject({ url: '/api/t/public', headers: { cookie } });
    expect(res.json()).toEqual({ actor: u._id });
  });

  test('unknown paths return a JSON 404', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('session state', () => {
  test('a pending_mfa session on a full route returns 403 mfa_required', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const { token } = await t.app.sessions.create(scoped(t.db, tenant._id), u._id, 'pending_mfa', {
      ip: '1.1.1.1',
      userAgent: 'x',
    });
    const res = await t.app.inject({ url: '/api/t/full', headers: { cookie: `__Host-sid=${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'mfa_required' });
  });

  test('a pending route accepts its listed state and refuses others', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const s = scoped(t.db, tenant._id);
    const m = { ip: '1.1.1.1', userAgent: 'x' };
    const pend = await t.app.sessions.create(s, u._id, 'pending_mfa', m);
    const enroll = await t.app.sessions.create(s, u._id, 'pending_enroll', m);
    const full = await signInAs(t.app, t.db, u._id);
    const get = (cookie: string) => t.app.inject({ url: '/api/t/pending', headers: { cookie } });
    expect((await get(`__Host-sid=${pend.token}`)).statusCode).toBe(200);
    expect((await get(`__Host-sid=${enroll.token}`)).statusCode).toBe(403);
    expect((await get(full.cookie)).statusCode).toBe(403);
  });
});

describe('CSRF', () => {
  test('a POST without x-csrf-token returns 403 csrf', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const { cookie } = await signInAs(t.app, t.db, u._id);
    const res = await t.app.inject({ method: 'POST', url: '/api/t/full', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'csrf' });
  });

  test('a POST with a wrong token returns 403 csrf, with the right token passes', async () => {
    const t = await setup(routes);
    const tenant = await t.seed.tenant();
    const u = await t.seed.user(tenant._id);
    const { cookie, csrf } = await signInAs(t.app, t.db, u._id);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/t/full',
      headers: { cookie, 'x-csrf-token': 'x'.repeat(csrf.length) },
    });
    expect(bad.statusCode).toBe(403);
    const short = await t.app.inject({
      method: 'POST',
      url: '/api/t/full',
      headers: { cookie, 'x-csrf-token': 'x' },
    });
    expect(short.statusCode).toBe(403);
    const good = await t.app.inject({
      method: 'POST',
      url: '/api/t/full',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(good.statusCode).toBe(200);
  });

  test('a POST to a public route needs no csrf token', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ method: 'POST', url: '/api/t/public' });
    expect(res.statusCode).toBe(200);
  });

  test('an unauthenticated POST to a full route is 401, not 403', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ method: 'POST', url: '/api/t/full' });
    expect(res.statusCode).toBe(401);
  });
});

describe('roadmap authorization', () => {
  test('Tenant isolation: member of roadmap in tenant A gets 404 for tenant B roadmap id', async () => {
    const t = await setup(routes);
    const a = await t.seed.tenant('A');
    const b = await t.seed.tenant('B');
    const ua = await t.seed.user(a._id);
    const ub = await t.seed.user(b._id);
    const ra = await t.seed.roadmap(a._id, ua._id);
    const rb = await t.seed.roadmap(b._id, ub._id);
    const { cookie } = await signInAs(t.app, t.db, ua._id);
    const own = await t.app.inject({ url: `/api/t/r/${ra._id}/view`, headers: { cookie } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ role: 'owner' });
    const cross = await t.app.inject({ url: `/api/t/r/${rb._id}/view`, headers: { cookie } });
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toEqual({ error: 'not_found' });
  });

  test('a user with no membership gets 404, same as a roadmap that does not exist', async () => {
    const t = await setup(routes);
    const a = await t.seed.tenant();
    const owner = await t.seed.user(a._id);
    const stranger = await t.seed.user(a._id);
    const r = await t.seed.roadmap(a._id, owner._id);
    const { cookie } = await signInAs(t.app, t.db, stranger._id);
    const real = await t.app.inject({ url: `/api/t/r/${r._id}/view`, headers: { cookie } });
    const fake = await t.app.inject({ url: '/api/t/r/nope/view', headers: { cookie } });
    expect(real.statusCode).toBe(404);
    expect(fake.statusCode).toBe(404);
    expect(real.body).toBe(fake.body);
  });

  test('a contributor on an audit.view route returns 403, an admin passes', async () => {
    const t = await setup(routes);
    const a = await t.seed.tenant();
    const owner = await t.seed.user(a._id);
    const contrib = await t.seed.user(a._id);
    const admin = await t.seed.user(a._id);
    const r = await t.seed.roadmap(a._id, owner._id);
    await t.seed.member(a._id, r._id, contrib._id, 'contributor');
    await t.seed.member(a._id, r._id, admin._id, 'admin');
    const url = `/api/t/r/${r._id}/audit`;
    const c = await signInAs(t.app, t.db, contrib._id);
    const res = await t.app.inject({ url, headers: { cookie: c.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    const ad = await signInAs(t.app, t.db, admin._id);
    expect((await t.app.inject({ url, headers: { cookie: ad.cookie } })).statusCode).toBe(200);
    const ow = await signInAs(t.app, t.db, owner._id);
    expect((await t.app.inject({ url, headers: { cookie: ow.cookie } })).statusCode).toBe(200);
  });

  test('ctx(req) feeds the policy, and roadmapParam names the param', async () => {
    const t = await setup(routes);
    const a = await t.seed.tenant();
    const owner = await t.seed.user(a._id);
    const contrib = await t.seed.user(a._id);
    const r = await t.seed.roadmap(a._id, owner._id);
    await t.seed.member(a._id, r._id, contrib._id, 'contributor');
    const { cookie } = await signInAs(t.app, t.db, contrib._id);
    const url = `/api/t/x/${r._id}/edit`;
    expect((await t.app.inject({ url, headers: { cookie } })).statusCode).toBe(403);
    expect(
      (await t.app.inject({ url, headers: { cookie, 'x-assigned': '1' } })).statusCode,
    ).toBe(200);
  });
});

describe('forbidden roles on ctx routes', () => {
  test('a contributor gets 403 before body validation; an admin with the same bad body gets 400', async () => {
    const t = await setup(routes);
    const a = await t.seed.tenant();
    const owner = await t.seed.user(a._id);
    const contrib = await t.seed.user(a._id);
    const admin = await t.seed.user(a._id);
    const r = await t.seed.roadmap(a._id, owner._id);
    await t.seed.member(a._id, r._id, contrib._id, 'contributor');
    await t.seed.member(a._id, r._id, admin._id, 'admin');
    const post = async (userId: string, payload: unknown) => {
      const { cookie, csrf } = await signInAs(t.app, t.db, userId);
      return t.app.inject({
        method: 'POST',
        url: `/api/t/r/${r._id}/members`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: payload as object,
      });
    };
    const c = await post(contrib._id, { role: 'nonsense' });
    expect(c.statusCode).toBe(403);
    expect(c.json()).toEqual({ error: 'forbidden' });
    expect((await post(admin._id, { role: 'nonsense' })).statusCode).toBe(400);
    expect((await post(owner._id, { role: 'nonsense' })).statusCode).toBe(400);
    expect((await post(admin._id, { role: 'contributor' })).statusCode).toBe(200);
  });

  test('a ctx route reached with no role is refused with 403', async () => {
    const t = await setup((app) => {
      app.addHook('onRequest', async (req) => {
        // Runs after the auth hook (registered earlier): simulates a request whose role was never set.
        if (req.actor) req.actor.role = null;
      });
      routes(app);
    });
    const a = await t.seed.tenant();
    const owner = await t.seed.user(a._id);
    const r = await t.seed.roadmap(a._id, owner._id);
    const { cookie } = await signInAs(t.app, t.db, owner._id);
    const res = await t.app.inject({ url: `/api/t/x/${r._id}/edit`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});

describe('canEver', () => {
  test('is true exactly when some context makes can() true', () => {
    expect(canEver(null, 'roadmap.view')).toBe(false);
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        const roles = [undefined, ...ROLES];
        const any = [true, false, undefined].some((isAssigned) =>
          roles.some((targetRole) =>
            roles.some((newRole) =>
              can({
                role,
                action,
                ctx: {
                  ...(isAssigned !== undefined && { isAssigned }),
                  ...(targetRole && { targetRole }),
                  ...(newRole && { newRole }),
                },
              }),
            ),
          ),
        );
        expect(canEver(role, action), `${role} ${action}`).toBe(any);
      }
    }
    expect(canEver('contributor', 'member.remove')).toBe(false);
    expect(canEver('admin', 'member.remove')).toBe(true);
    expect(canEver('admin', 'roadmap.delete')).toBe(false);
    expect(canEver('contributor', 'project.edit')).toBe(true);
  });
});

describe('security headers and rate limit', () => {
  test('responses carry CSP, HSTS and clickjacking protection', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('the 11th request to /api/auth/* from the same IP within a minute returns 429', async () => {
    const t = await setup(routes);
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/ping' });
      expect(r.statusCode).toBe(200);
    }
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/ping' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'rate_limited' });
  });

  test('a percent-encoded /api/%61uth/ path is still rate limited on the 11th request', async () => {
    const t = await setup(routes);
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/%61uth/ping' });
      expect(r.statusCode).toBe(200);
    }
    const res = await t.app.inject({ method: 'POST', url: '/api/%61uth/ping' });
    expect(res.statusCode).toBe(429);
  });

  test('routes outside /api/auth are not rate limited, and counts are per app', async () => {
    const t = await setup(routes);
    for (let i = 0; i < 15; i++) {
      expect((await t.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    }
    const fresh = await setup(routes);
    expect((await fresh.app.inject({ method: 'POST', url: '/api/auth/ping' })).statusCode).toBe(200);
  });
});

describe('session cookie', () => {
  test('setSessionCookie sets __Host-sid HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/cookie-set' });
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/^__Host-sid=tok;/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(c).toContain(attr);
    expect(c).not.toContain('Domain');
  });

  test('clearSessionCookie expires __Host-sid', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/cookie-clear' });
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/^__Host-sid=;/);
    expect(c).toContain('Expires=Thu, 01 Jan 1970');
    expect(c).toContain('Secure');
  });
});

describe('error handling', () => {
  test('unknown errors become 500 internal with no stack or message', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({ url: '/api/t/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal' });
    expect(res.body).not.toContain('secret internals');
  });

  test('zod validation failures become 400 validation with issues', async () => {
    const { z } = await import('zod');
    const t = await setup((app) => {
      app.withTypeProvider<ZodTypeProvider>().post(
        '/api/t/body',
        {
          config: { auth: { level: 'public' } },
          schema: { body: z.object({ n: z.number() }) },
        },
        ok,
      );
    });
    const res = await t.app.inject({ method: 'POST', url: '/api/t/body', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; issues: unknown[] }>();
    expect(body.error).toBe('validation');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('malformed JSON becomes 400 bad_request', async () => {
    const t = await setup(routes);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/t/public',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request' });
  });
});

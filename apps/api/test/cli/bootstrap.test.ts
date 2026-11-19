import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootstrap } from '../../src/cli/bootstrap.ts';
import { run } from '../../src/cli/bootstrap.ts';
import { hashToken } from '../../src/auth/tokens.ts';
import { connectDb } from '../../src/db/client.ts';
import { scoped } from '../../src/db/scoped.ts';
import { makeTestApp, startMongo, TEST_ENV, type TestApp } from '../helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const PASSWORD = 'first password of mine';

let clock = new Date('2026-03-01T12:00:00Z');
let t: TestApp;
let n = 0;
const ip = () => `10.7.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const input = (o: Partial<{ tenantName: string; email: string; name: string }> = {}) => ({
  tenantName: `Acme ${randomUUID()}`,
  email: `owner-${randomUUID()}@example.com`,
  name: 'Olive Owner',
  ...o,
});
const deps = () => ({ db: t.db, config: t.config, now: () => clock });
const confirm = (setupUrl: string, password: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/password-reset/confirm',
    remoteAddress: ip(),
    payload: { token: setupUrl.split('/reset/')[1], password },
  });

describe('tenant bootstrap (FR-1)', () => {
  test('creates the tenant and a passwordless user and returns a setup URL', async () => {
    const i = input({ email: 'Owner.One@Example.COM ' });
    const r = await bootstrap(i, deps());
    expect(r.setupUrl.startsWith('http://localhost:5173/reset/')).toBe(true);
    expect(await t.db.collection('tenants').findOne({ _id: r.tenantId as never })).toMatchObject({ name: i.tenantName });
    const user = await scoped(t.db, r.tenantId).collection('users').findOne({ _id: r.userId });
    expect(user).toMatchObject({
      email: 'owner.one@example.com',
      name: 'Olive Owner',
      passwordHash: null,
      totp: null,
      failedLogins: 0,
      lockedUntil: null,
    });
  });

  test('the setup token lives 24 hours and only its hash is stored', async () => {
    const r = await bootstrap(input(), deps());
    const token = r.setupUrl.split('/reset/')[1]!;
    const doc = await scoped(t.db, r.tenantId).collection('resetTokens').findOne({ userId: r.userId });
    expect(doc).toMatchObject({ tokenHash: hashToken(token), usedAt: null });
    expect(doc!.expiresAt).toEqual(new Date(clock.getTime() + 24 * HOUR));
  });

  test('the setup URL sets the first password through password-reset/confirm, and sign-in then leads to TOTP enrollment', async () => {
    const i = input();
    const r = await bootstrap(i, deps());
    const before = await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip(), payload: { email: i.email, password: PASSWORD } });
    expect(before.statusCode).toBe(401);
    expect((await confirm(r.setupUrl, PASSWORD)).statusCode).toBe(204);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip(), payload: { email: i.email, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ next: 'enroll' });
  });

  test('the setup link still works after 23 hours and not after 25', async () => {
    const a = await bootstrap(input(), deps());
    const b = await bootstrap(input(), deps());
    const start = clock;
    clock = new Date(start.getTime() + 25 * HOUR);
    expect((await confirm(b.setupUrl, PASSWORD)).statusCode).toBe(410);
    clock = new Date(start.getTime() + 23 * HOUR);
    expect((await confirm(a.setupUrl, PASSWORD)).statusCode).toBe(204);
    clock = start;
  });

  test('running it twice with the same email throws email_exists and creates nothing more', async () => {
    const i = input();
    await bootstrap(i, deps());
    const tenantsBefore = await t.db.collection('tenants').countDocuments({});
    await expect(bootstrap({ ...i, tenantName: 'Other', email: i.email.toUpperCase() }, deps())).rejects.toThrow('email_exists');
    expect(await t.db.collection('tenants').countDocuments({})).toBe(tenantsBefore);
  });

  test('two runs at once with one email: one wins, the other throws email_exists', async () => {
    const i = input();
    const results = await Promise.allSettled([bootstrap(i, deps()), bootstrap({ ...i, tenantName: 'Other' }, deps())]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as Error).message).toBe('email_exists');
  });

  test('an email that is not an email, or an empty name, is refused before anything is written', async () => {
    const tenantsBefore = await t.db.collection('tenants').countDocuments({});
    await expect(bootstrap(input({ email: 'nope' }), deps())).rejects.toThrow('invalid_input');
    await expect(bootstrap(input({ name: '  ' }), deps())).rejects.toThrow('invalid_input');
    await expect(bootstrap(input({ tenantName: '' }), deps())).rejects.toThrow('invalid_input');
    expect(await t.db.collection('tenants').countDocuments({})).toBe(tenantsBefore);
  });
});

describe('bootstrap command line', () => {
  const env = () => ({
    ...TEST_ENV,
    MONGO_URI: startMongo().uri,
    MONGO_DB: t.config.mongoDb,
  });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, streams: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) } };
  };
  const args = (i: { tenantName: string; email: string; name: string }) => [
    '--tenant', i.tenantName, '--email', i.email, '--name', i.name,
  ];

  test('prints the setup URL on stdout and exits 0', async () => {
    const i = input();
    const o = io();
    expect(await run(args(i), env(), o.streams)).toBe(0);
    expect(o.err).toEqual([]);
    expect(o.out.join('')).toMatch(/^http:\/\/localhost:5173\/reset\/[A-Za-z0-9_-]+\n$/);
    expect(await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip(), payload: { email: i.email, password: 'x'.repeat(12) } })).toMatchObject({ statusCode: 401 });
    const { client, db } = await connectDb(env().MONGO_URI, env().MONGO_DB);
    try {
      expect((await db.collection('users').indexes()).some((x) => x.unique && x.key.email === 1)).toBe(true);
    } finally {
      await client.close();
    }
  });

  test('an existing email prints email_exists on stderr and exits 1', async () => {
    const i = input();
    await bootstrap(i, deps());
    const o = io();
    expect(await run(args(i), env(), o.streams)).toBe(1);
    expect(o.out).toEqual([]);
    expect(o.err.join('')).toContain('email_exists');
  });

  test('missing arguments print usage on stderr and exit 2', async () => {
    const o = io();
    expect(await run(['--tenant', 'Acme'], env(), o.streams)).toBe(2);
    expect(o.err.join('')).toContain('Usage');
  });

  test('a bad environment prints the configuration problems and exits 2', async () => {
    const o = io();
    expect(await run(args(input()), { NODE_ENV: 'test' }, o.streams)).toBe(2);
    expect(o.err.join('')).toContain('MONGO_URI');
  });
});

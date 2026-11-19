import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { hashToken, newToken } from '../../src/auth/tokens.ts';
import { scoped, type ScopedDb } from '../../src/db/scoped.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const meta = { ip: '10.0.0.1', userAgent: 'vitest' };

let clock = new Date('2026-01-01T00:00:00Z');
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

let t: TestApp;
let s: ScopedDb;
let userId: string;
const store = () => t.app.sessions;

beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
  const tenant = await t.seed.tenant();
  s = scoped(t.db, tenant._id);
  userId = (await t.seed.user(tenant._id))._id;
}, 120_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  clock = new Date('2026-01-01T00:00:00Z');
});

describe('tokens', () => {
  test('newToken returns 32 random bytes as base64url with a sha-256 hex hash', () => {
    const a = newToken();
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a.token)).toBe(a.hash);
    expect(newToken().token).not.toBe(a.token);
  });
});

describe('session lifetimes (FR-1)', () => {
  test('a full session stores only the token hash and expires 12 h out', async () => {
    const { token, session } = await store().create(s, userId, 'full', meta);
    expect(session.tokenHash).toBe(hashToken(token));
    expect(session.tokenHash).not.toBe(token);
    expect(session.expiresAt.getTime() - clock.getTime()).toBe(12 * HOUR);
    expect(session.csrfToken).toHaveLength(43);
    expect(session).toMatchObject({ ip: meta.ip, userAgent: meta.userAgent, state: 'full' });
  });

  test('an unknown token resolves to null', async () => {
    expect(await store().resolve('nope')).toBeNull();
    expect(await store().resolve('')).toBeNull();
  });

  test('idle for 31 min resolves to null', async () => {
    const { token } = await store().create(s, userId, 'full', meta);
    advance(31 * MIN);
    expect(await store().resolve(token)).toBeNull();
  });

  test('idle for 29 min still resolves', async () => {
    const { token } = await store().create(s, userId, 'full', meta);
    advance(29 * MIN);
    expect(await store().resolve(token)).not.toBeNull();
  });

  test('active use every 20 min still dies at 12 h', async () => {
    const { token } = await store().create(s, userId, 'full', meta);
    for (let i = 0; i < 35; i++) {
      advance(20 * MIN); // reaches 11 h 40 min
      expect(await store().resolve(token)).not.toBeNull();
    }
    advance(20 * MIN); // 12 h exactly
    expect(await store().resolve(token)).toBeNull();
  });

  test('a pending session dies at 10 min', async () => {
    const { token, session } = await store().create(s, userId, 'pending_mfa', meta);
    expect(session.expiresAt.getTime() - clock.getTime()).toBe(10 * MIN);
    advance(9 * MIN);
    expect(await store().resolve(token)).not.toBeNull();
    advance(1 * MIN);
    expect(await store().resolve(token)).toBeNull();
  });

  test('lastSeenAt is updated at most once per 60 s', async () => {
    const { token, session } = await store().create(s, userId, 'full', meta);
    advance(30_000);
    expect((await store().resolve(token))?.lastSeenAt).toEqual(session.createdAt);
    advance(31_000);
    const later = await store().resolve(token);
    expect(later?.lastSeenAt).toEqual(clock);
    expect((await s.collection('sessions').findOne({ _id: session._id }))?.lastSeenAt).toEqual(clock);
  });
});

describe('upgrade, revoke (FR-1)', () => {
  test('upgrade gives a new token, the old token resolves to null, expiry resets', async () => {
    const { token, session } = await store().create(s, userId, 'pending_mfa', meta);
    advance(5 * MIN);
    const up = await store().upgrade(s, session._id, 'full');
    expect(up.token).not.toBe(token);
    expect(await store().resolve(token)).toBeNull();
    const after = await store().resolve(up.token);
    expect(after?.state).toBe('full');
    expect(after?.expiresAt.getTime()).toBe(clock.getTime() + 12 * HOUR);
    expect(after?.csrfToken).toBe(session.csrfToken);
  });

  test('upgrade to pending_enroll gets a pending lifetime', async () => {
    const { session } = await store().create(s, userId, 'pending_mfa', meta);
    const up = await store().upgrade(s, session._id, 'pending_enroll');
    const after = await store().resolve(up.token);
    expect(after?.expiresAt.getTime()).toBe(clock.getTime() + 10 * MIN);
  });

  test('upgrade of a missing session throws', async () => {
    await expect(store().upgrade(s, 'missing', 'full')).rejects.toThrow('session_not_found');
  });

  test('revoke kills one session', async () => {
    const a = await store().create(s, userId, 'full', meta);
    const b = await store().create(s, userId, 'full', meta);
    await store().revoke(s, a.session._id);
    expect(await store().resolve(a.token)).toBeNull();
    expect(await store().resolve(b.token)).not.toBeNull();
  });

  test('Review focus 5: revokeAllForUser kills every session of that user only', async () => {
    const tenant = await t.seed.tenant('Other');
    const other = scoped(t.db, tenant._id);
    const v = await t.seed.user(tenant._id);
    const U = await t.seed.user(s.tenantId);
    const u = await Promise.all([1, 2, 3].map(() => store().create(s, U._id, 'full', meta)));
    const vs = await store().create(other, v._id, 'full', meta);
    expect(await store().revokeAllForUser(s, U._id)).toBe(3);
    for (const x of u) expect(await store().resolve(x.token)).toBeNull();
    expect(await store().resolve(vs.token)).not.toBeNull();
  });

  test('revokeAllForUser inside tenant A cannot touch a same-id user in tenant B', async () => {
    const tenant = await t.seed.tenant('B');
    const other = scoped(t.db, tenant._id);
    const b = await store().create(other, userId, 'full', meta);
    await store().revokeAllForUser(s, userId);
    expect(await store().resolve(b.token)).not.toBeNull();
  });
});

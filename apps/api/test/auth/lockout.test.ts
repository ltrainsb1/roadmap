import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertNotLocked, isLocked, recordFailure, recordSuccess } from '../../src/auth/lockout.ts';
import { scoped, type ScopedDb } from '../../src/db/scoped.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

let t: TestApp;
let s: ScopedDb;
const now = new Date('2026-01-01T00:00:00Z');
const state = async (id: string) => (await s.collection('users').findOne({ _id: id }))!;

beforeAll(async () => {
  t = await makeTestApp();
  s = scoped(t.db, (await t.seed.tenant())._id);
}, 120_000);
afterAll(async () => {
  await t?.close();
});

describe('lockout (FR-1)', () => {
  test('isLocked is true only while lockedUntil is in the future', () => {
    expect(isLocked({ lockedUntil: null }, now)).toBe(false);
    expect(isLocked({ lockedUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(isLocked({ lockedUntil: now }, now)).toBe(false);
  });

  test('assertNotLocked re-reads the stored document, so a lock set after an earlier read is seen', async () => {
    const u = await t.seed.user(s.tenantId);
    expect(await assertNotLocked(s, u._id, now)).toBe(true);
    for (let i = 0; i < 5; i++) await recordFailure(s, u._id, now);
    expect(await assertNotLocked(s, u._id, now)).toBe(false);
    expect(await assertNotLocked(s, u._id, new Date(now.getTime() + 15 * 60_000))).toBe(true);
  });

  test('assertNotLocked is false for a missing user', async () => {
    expect(await assertNotLocked(s, 'missing', now)).toBe(false);
  });

  test('the fifth failure sets the lock and resets the counter in one write', async () => {
    const u = await t.seed.user(s.tenantId);
    for (let i = 0; i < 4; i++) await recordFailure(s, u._id, now);
    expect(await state(u._id)).toMatchObject({ failedLogins: 4, lockedUntil: null });
    await recordFailure(s, u._id, now);
    expect(await state(u._id)).toMatchObject({ failedLogins: 0, lockedUntil: new Date(now.getTime() + 15 * 60_000) });
  });

  test('a parallel burst of 12 failures never leaves a count of 5 or more, and ends locked', async () => {
    const u = await t.seed.user(s.tenantId);
    await Promise.all(Array.from({ length: 12 }, () => recordFailure(s, u._id, now)));
    const after = await state(u._id);
    expect(after.failedLogins).toBe(2);
    expect(after.lockedUntil).not.toBeNull();
  });

  test('recordFailure for a missing user does nothing and terminates', async () => {
    await expect(recordFailure(s, 'missing', now)).resolves.toBeUndefined();
  });

  test('recordSuccess clears the counter and any lock', async () => {
    const u = await t.seed.user(s.tenantId);
    for (let i = 0; i < 5; i++) await recordFailure(s, u._id, now);
    await recordSuccess(s, u._id);
    expect(await state(u._id)).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });
});

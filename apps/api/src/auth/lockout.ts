import type { ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export function isLocked(user: Pick<UserDoc, 'lockedUntil'>, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}

/** Counts one failure; the 5th locks the account for 15 min and starts the next run from zero. */
export async function recordFailure(s: ScopedDb, userId: string, now: Date = new Date()): Promise<void> {
  const users = s.collection('users');
  const after = await users.findOneAndUpdate({ _id: userId }, { $inc: { failedLogins: 1 } });
  if (after && after.failedLogins >= MAX_FAILURES) {
    await users.updateOne(
      { _id: userId, failedLogins: { $gte: MAX_FAILURES } },
      { $set: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    );
  }
}

/**
 * Re-checks the lock against the stored document, not a copy read earlier in the request, so failures
 * recorded by concurrent attempts are seen. False means locked (or no such user).
 */
export async function assertNotLocked(s: ScopedDb, userId: string, now: Date): Promise<boolean> {
  const user = await s
    .collection('users')
    .findOne({ _id: userId, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] });
  return user !== null;
}

/**
 * Clears the counter and any lock. Call it only when the whole sign-in has succeeded (second factor
 * passed, or first-time enrollment confirmed). A correct password alone must not reset it, or an attacker
 * who knows the password could alternate it with second-factor guesses.
 */
export async function recordSuccess(s: ScopedDb, userId: string): Promise<void> {
  await s.collection('users').updateOne({ _id: userId }, { $set: { failedLogins: 0, lockedUntil: null } });
}

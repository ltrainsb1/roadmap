import type { ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export function isLocked(user: Pick<UserDoc, 'lockedUntil'>, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil > now;
}

/**
 * Counts one failure; the 5th locks the account for 15 min and starts the next run from zero.
 * Every step is one conditional update, so the count is never 5 without the lock being set: the update
 * that takes the count from 4 to 5 sets `lockedUntil` and resets the counter in the same write.
 */
export async function recordFailure(s: ScopedDb, userId: string, now: Date = new Date()): Promise<void> {
  const users = s.collection('users');
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  // A concurrent failure can move the count between the two updates, so retry; three rounds always settle.
  for (let attempt = 0; attempt < 3; attempt++) {
    const locked = await users.updateOne(
      { _id: userId, failedLogins: { $gte: MAX_FAILURES - 1 } },
      { $set: { failedLogins: 0, lockedUntil: lockUntil } },
    );
    if (locked.matched > 0) return;
    const counted = await users.findOneAndUpdate(
      { _id: userId, failedLogins: { $lt: MAX_FAILURES - 1 } },
      { $inc: { failedLogins: 1 } },
    );
    if (counted) return;
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

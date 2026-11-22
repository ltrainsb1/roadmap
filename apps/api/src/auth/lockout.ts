import type { ScopedCollection, ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export function isLocked(doc: Pick<UserDoc, 'lockedUntil'>, now: Date): boolean {
  return doc.lockedUntil !== null && doc.lockedUntil > now;
}

type CountField = 'failedLogins' | 'failedUnlocks';

/** What the algorithm needs of a document: its id, its lock, and a counter under the field the caller names. */
type Lockable = { _id: string; tenantId: string; lockedUntil: Date | null } & Partial<Record<CountField, number>>;

/**
 * One lockout algorithm for every place that checks a secret: sign-in (users, `failedLogins`) and opening a
 * snapshot (snapshots, `failedUnlocks`).
 */
export function createLockout<N extends 'users' | 'snapshots'>(
  collection: N,
  countField: N extends 'users' ? 'failedLogins' : 'failedUnlocks',
) {
  const field: CountField = countField;
  const docs = (s: ScopedDb) => s.collection(collection) as unknown as ScopedCollection<Lockable>;
  const notLocked = (now: Date) => ({ $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] });

  return {
    /**
     * Counts one failure; the 5th locks for 15 min and starts the next run from zero. Every step is one conditional
     * update, so the count is never 5 without the lock being set: the update that takes the count from 4 to 5 sets
     * `lockedUntil` and resets the counter in the same write. `lockedNow` is true for the failure that set the lock.
     */
    async recordFailure(s: ScopedDb, id: string, now: Date = new Date()): Promise<{ lockedNow: boolean }> {
      const col = docs(s);
      const lockUntil = new Date(now.getTime() + LOCK_MS);
      // A concurrent failure can move the count between the two updates, so retry; three rounds always settle.
      for (let attempt = 0; attempt < 3; attempt++) {
        const locked = await col.updateOne(
          { _id: id, [field]: { $gte: MAX_FAILURES - 1 } },
          { $set: { [field]: 0, lockedUntil: lockUntil } },
        );
        if (locked.matched > 0) return { lockedNow: true };
        const counted = await col.findOneAndUpdate(
          { _id: id, [field]: { $lt: MAX_FAILURES - 1 } },
          { $inc: { [field]: 1 } },
        );
        if (counted) return { lockedNow: false };
      }
      return { lockedNow: false };
    },

    /**
     * Re-checks the lock against the stored document, not a copy read earlier in the request, so failures
     * recorded by concurrent attempts are seen. False means locked (or no such document).
     */
    async assertNotLocked(s: ScopedDb, id: string, now: Date): Promise<boolean> {
      return (await docs(s).findOne({ _id: id, ...notLocked(now) })) !== null;
    },

    /** Clears the counter and any lock. */
    async recordSuccess(s: ScopedDb, id: string): Promise<void> {
      await docs(s).updateOne({ _id: id }, { $set: { [field]: 0, lockedUntil: null } });
    },
  };
}

const users = createLockout('users', 'failedLogins');

/** Counts one failed sign-in; the 5th locks the account for 15 min. */
export async function recordFailure(s: ScopedDb, userId: string, now: Date = new Date()): Promise<void> {
  await users.recordFailure(s, userId, now);
}

/** False when the account is locked, or there is no such user. */
export function assertNotLocked(s: ScopedDb, userId: string, now: Date): Promise<boolean> {
  return users.assertNotLocked(s, userId, now);
}

/**
 * Clears the counter and any lock. Call it only when the whole sign-in has succeeded (second factor
 * passed, or first-time enrollment confirmed). A correct password alone must not reset it, or an attacker
 * who knows the password could alternate it with second-factor guesses.
 */
export function recordSuccess(s: ScopedDb, userId: string): Promise<void> {
  return users.recordSuccess(s, userId);
}

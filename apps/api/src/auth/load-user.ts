import type { ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';

/** The session's user, or 401 when the account is gone. */
export async function loadUser(db: ScopedDb, userId: string): Promise<UserDoc> {
  const user = await db.collection('users').findOne({ _id: userId });
  if (!user) throw new HttpError(401, 'unauthenticated');
  return user;
}

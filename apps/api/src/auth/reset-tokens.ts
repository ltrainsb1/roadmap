import { v7 as uuidv7 } from 'uuid';
import type { ScopedDb } from '../db/scoped.ts';
import { newToken } from './tokens.ts';

/**
 * Stores a reset token (hash only) for the user and returns the link to send them.
 * Kept apart from the routes so the bootstrap command can use it without loading the web app.
 */
export async function issueResetToken(
  s: ScopedDb,
  userId: string,
  ttlMs: number,
  ctx: { appOrigin: string; now: () => Date },
): Promise<string> {
  const { token, hash } = newToken();
  await s.collection('resetTokens').insertOne({
    _id: uuidv7(),
    userId,
    tokenHash: hash,
    expiresAt: new Date(ctx.now().getTime() + ttlMs),
    usedAt: null,
  });
  return `${ctx.appOrigin}/reset/${token}`;
}

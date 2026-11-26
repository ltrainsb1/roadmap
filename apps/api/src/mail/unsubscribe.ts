import { createHmac, timingSafeEqual } from 'node:crypto';

// The token in a notification email's unsubscribe links: `${tenantId}.${userId}.${sig}`. It never expires and can only
// turn emails off, so a token that leaks costs its owner a few emails and nothing else.

const sign = (key: Buffer, tenantId: string, userId: string): Buffer =>
  createHmac('sha256', key).update(`unsubscribe:${tenantId}:${userId}`).digest();

export function signUnsubscribe(key: Buffer, tenantId: string, userId: string): string {
  return `${tenantId}.${userId}.${sign(key, tenantId, userId).toString('base64url')}`;
}

/** The ids in a token this key signed, or null for anything else. */
export function verifyUnsubscribe(key: Buffer, token: string): { tenantId: string; userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, userId, sig] = parts as [string, string, string];
  if (tenantId === '' || userId === '') return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = sign(key, tenantId, userId);
  // A decoded signature of the wrong length is refused before the constant-time compare, which needs equal lengths.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  // Buffer.from is lenient about stray characters; only the exact encoding is accepted.
  if (given.toString('base64url') !== sig) return null;
  return { tenantId, userId };
}

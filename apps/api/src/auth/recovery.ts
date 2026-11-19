import { createHash, randomBytes } from 'node:crypto';
import type { ScopedDb } from '../db/scoped.ts';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const CODE_COUNT = 10;
const HALF = 5;

export const normalizeRecoveryCode = (code: string): string => code.replaceAll('-', '').toUpperCase();
export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

function randomCode(): string {
  // 256 is a multiple of 32, so masking a byte to 5 bits is unbiased.
  const chars = Array.from(randomBytes(HALF * 2), (b) => ALPHABET[b & 31]!).join('');
  return `${chars.slice(0, HALF)}-${chars.slice(HALF)}`;
}

export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = new Set<string>();
  while (codes.size < CODE_COUNT) codes.add(randomCode());
  const list = [...codes];
  return { codes: list, hashes: list.map(hashRecoveryCode) };
}

/** Marks one unused code as used in a single atomic update; false if it is unknown or already used. */
export async function consumeRecoveryCode(
  s: ScopedDb,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const updated = await s
    .collection('users')
    .findOneAndUpdate(
      { _id: userId, recoveryCodes: { $elemMatch: { hash, usedAt: null } } },
      { $set: { 'recoveryCodes.$.usedAt': now } },
    );
  return updated !== null;
}

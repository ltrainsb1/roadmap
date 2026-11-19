import { authenticator } from 'otplib';
import type { ScopedDb } from '../db/scoped.ts';

const STEP_SECONDS = 30;

export type TotpResult = { ok: true; step: number } | { ok: false };

/** A new base32 secret (160 bits). */
export const generateTotpSecret = (): string => authenticator.generateSecret(20);

export const otpauthUrl = (account: string, issuer: string, secret: string): string =>
  authenticator.keyuri(account, issuer, secret);

/**
 * Accepts the current step and one either side. `lastStep` is the newest step already accepted for this
 * secret: a step at or below it is a replay and is rejected.
 */
export function verifyTotp(secret: string, code: string, lastStep: number, now: Date): TotpResult {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const auth = authenticator.clone({ step: STEP_SECONDS, window: 1, digits: 6, epoch: now.getTime() });
  let delta: number | null;
  try {
    delta = auth.checkDelta(code, secret);
  } catch {
    return { ok: false };
  }
  if (delta === null) return { ok: false };
  const step = Math.floor(now.getTime() / (STEP_SECONDS * 1000)) + delta;
  return step > lastStep ? { ok: true, step } : { ok: false };
}

/**
 * Records `step` as used. The condition is evaluated by the database, so of two simultaneous requests
 * carrying the same code only one gets true.
 */
export async function claimTotpStep(s: ScopedDb, userId: string, step: number): Promise<boolean> {
  const { matched } = await s
    .collection('users')
    .updateOne({ _id: userId, 'totp.lastStep': { $lt: step } }, { $set: { 'totp.lastStep': step } });
  return matched > 0;
}

import { z } from 'zod';
import type { ScopedDb } from '../db/scoped.ts';
import type { UserDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';
import { decryptSecret } from './crypto.ts';
import { consumeRecoveryCode } from './recovery.ts';
import { claimTotpStep, verifyTotp } from './totp.ts';

// Anything unparseable counts as no code, so a missing or odd body gets the same 422 as a wrong code.
const stepUpBody = z.object({ code: z.string().max(32) });

/** The `code` a step-up request carries, or undefined. */
export const stepUpCodeOf = (body: unknown): string | undefined => stepUpBody.safeParse(body).data?.code;

const TOTP_SHAPE = /^\d{6}$/;

/**
 * For a full session changing a second factor: proves the user still holds one. Six digits is a TOTP code,
 * which must be valid and not used before; anything else is tried as a recovery code, which is spent.
 * Any failure is 422 invalid_code and counts nothing toward lockout: the session already passed sign-in.
 */
export async function requireStepUp(
  db: ScopedDb,
  user: UserDoc,
  code: string | undefined,
  opts: { totpEncKey: Buffer; now: Date },
): Promise<void> {
  const invalid = () => new HttpError(422, 'invalid_code');
  if (!code) throw invalid();
  if (TOTP_SHAPE.test(code)) {
    if (!user.totp) throw invalid();
    const checked = verifyTotp(decryptSecret(user.totp.secretEnc, opts.totpEncKey), code, user.totp.lastStep, opts.now);
    if (!checked.ok || !(await claimTotpStep(db, user._id, checked.step))) throw invalid();
    return;
  }
  if (!(await consumeRecoveryCode(db, user._id, code, opts.now))) throw invalid();
}

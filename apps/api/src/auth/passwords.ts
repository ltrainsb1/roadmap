import { createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from '../config.ts';
import { HttpError } from '../errors.ts';

export const MIN_PASSWORD_LENGTH = 12;

// Argon2id at the OWASP minimum. Algorithm 2 is argon2id (the library's const enum is not importable under strip-types).
const ARGON2ID = 2;
const PARAMS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const HIBP_TIMEOUT_MS = 3000;

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, PARAMS);
}

/** False for a wrong password and for a hash that cannot be parsed. */
export async function verifyPassword(passwordHash: string, pw: string): Promise<boolean> {
  try {
    return await verify(passwordHash, pw);
  } catch {
    return false;
  }
}

export interface WarnLog {
  warn(obj: unknown, msg?: string): void;
}

/** HIBP k-anonymity range lookup: only the first 5 hex chars of the SHA-1 leave the server. Fails open. */
export async function isBreached(
  pw: string,
  fetchFn: typeof fetch = fetch,
  log?: WarnLog,
): Promise<boolean> {
  const sha1 = createHash('sha1').update(pw).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`hibp_status_${res.status}`);
    const text = await res.text();
    return text.split(/\r?\n/).some((line) => {
      const [s, count] = line.trim().split(':');
      return s === suffix && Number(count) > 0; // padding rows have count 0
    });
  } catch (err) {
    log?.warn({ err }, 'breached-password check unavailable, allowing the password');
    return false;
  }
}

export interface PasswordPolicyDeps {
  config: Pick<Config, 'hibpEnabled'>;
  fetch?: typeof fetch;
  log?: WarnLog;
}

/** Used wherever a user chooses a new password (setup, invite, reset). The 128 cap is enforced by passwordSchema. */
export async function assertNewPasswordAllowed(pw: string, deps: PasswordPolicyDeps): Promise<void> {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new HttpError(422, 'password_too_short');
  if (deps.config.hibpEnabled && (await isBreached(pw, deps.fetch, deps.log))) {
    throw new HttpError(422, 'password_breached');
  }
}

import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { describe, expect, test } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/auth/crypto.ts';
import { generateRecoveryCodes } from '../../src/auth/recovery.ts';
import { verifyTotp } from '../../src/auth/totp.ts';

const key = randomBytes(32);
const SECRET = authenticator.generateSecret(20);
const now = new Date('2026-03-01T12:00:10Z');
const STEP_MS = 30_000;
const stepOf = (d: Date) => Math.floor(d.getTime() / STEP_MS);
const codeAt = (offsetSteps: number) =>
  authenticator.clone({ epoch: now.getTime() + offsetSteps * STEP_MS }).generate(SECRET);

describe('secret encryption (FR-1)', () => {
  test('encrypt then decrypt round-trips, and the stored form hides the plain secret', () => {
    const enc = encryptSecret(SECRET, key);
    expect(enc).not.toContain(SECRET);
    expect(enc.split('.')).toHaveLength(3);
    expect(decryptSecret(enc, key)).toBe(SECRET);
  });

  test('the same secret encrypts differently each time (random IV)', () => {
    expect(encryptSecret(SECRET, key)).not.toBe(encryptSecret(SECRET, key));
  });

  test('one flipped ciphertext byte makes decrypt throw', () => {
    const [iv, tag, ct] = encryptSecret(SECRET, key).split('.') as [string, string, string];
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decryptSecret([iv, tag, bytes.toString('base64url')].join('.'), key)).toThrow();
  });

  test('a different key, or a malformed value, makes decrypt throw', () => {
    const enc = encryptSecret(SECRET, key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    expect(() => decryptSecret('not-encrypted', key)).toThrow();
  });
});

describe('verifyTotp (FR-1)', () => {
  test('a current code is ok and reports its step', () => {
    expect(verifyTotp(SECRET, codeAt(0), 0, now)).toEqual({ ok: true, step: stepOf(now) });
  });

  test('Review focus 4: a code one step old is accepted, the same code twice is rejected', () => {
    const code = codeAt(-1);
    const first = verifyTotp(SECRET, code, 0, now);
    expect(first).toEqual({ ok: true, step: stepOf(now) - 1 });
    const n = (first as { step: number }).step;
    expect(verifyTotp(SECRET, code, n, now)).toEqual({ ok: false });
  });

  test('a code one step ahead is accepted too (clock skew)', () => {
    expect(verifyTotp(SECRET, codeAt(1), 0, now)).toEqual({ ok: true, step: stepOf(now) + 1 });
  });

  test('a code 2 steps old, or 2 steps ahead, is rejected', () => {
    expect(verifyTotp(SECRET, codeAt(-2), 0, now)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, codeAt(2), 0, now)).toEqual({ ok: false });
  });

  test('an older step than the last accepted one is rejected', () => {
    expect(verifyTotp(SECRET, codeAt(-1), stepOf(now), now)).toEqual({ ok: false });
  });

  test('a wrong or malformed code is rejected without throwing', () => {
    const wrong = codeAt(0) === '000000' ? '000001' : '000000';
    expect(verifyTotp(SECRET, wrong, 0, now)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, 'abc', 0, now)).toEqual({ ok: false });
    expect(verifyTotp(SECRET, '', 0, now)).toEqual({ ok: false });
  });
});

describe('generateRecoveryCodes (FR-1)', () => {
  test('makes 10 unique codes in XXXXX-XXXXX Crockford base32, with one hash each', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(hashes).toHaveLength(10);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes.join()).not.toContain(codes[0]!.replace('-', ''));
  });
});

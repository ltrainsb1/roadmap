import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { assertNewPasswordAllowed, hashPassword, isBreached, verifyPassword } from '../../src/auth/passwords.ts';
import { HttpError } from '../../src/errors.ts';

const sha1Parts = (pw: string) => {
  const h = createHash('sha1').update(pw).digest('hex').toUpperCase();
  return { prefix: h.slice(0, 5), suffix: h.slice(5) };
};
const body = (text: string) => vi.fn<typeof fetch>(() => Promise.resolve(new Response(text, { status: 200 })));

describe('hashPassword and verifyPassword (FR-1)', () => {
  test('hash is argon2id with the OWASP minimum parameters, and verify checks the password', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(h).toContain('m=19456,t=2,p=1');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong horse battery!')).toBe(false);
  });

  test('verify returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever password')).toBe(false);
  });
});

describe('isBreached (FR-1 breached-password check)', () => {
  test('sends the 5-char SHA-1 prefix with Add-Padding and matches the suffix with a positive count', async () => {
    const { prefix, suffix } = sha1Parts('password1234');
    const f = body(`0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${suffix}:3\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2`);
    expect(await isBreached('password1234', f)).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url as string).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(new Headers(init?.headers).get('add-padding')).toBe('true');
  });

  test('a padding row (count 0) for the suffix is not a match', async () => {
    const { suffix } = sha1Parts('password1234');
    expect(await isBreached('password1234', body(`${suffix}:0\r\n`))).toBe(false);
  });

  test('a suffix that is absent is not breached', async () => {
    expect(await isBreached('password1234', body('ABCDEF:5\r\n'))).toBe(false);
  });

  test('a fetch that throws returns false and logs a warning', async () => {
    const log = { warn: vi.fn() };
    const f = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
    expect(await isBreached('password1234', f, log)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  test('a non-200 response returns false and logs a warning', async () => {
    const log = { warn: vi.fn() };
    const f = vi.fn<typeof fetch>(() => Promise.resolve(new Response('x', { status: 503 })));
    expect(await isBreached('password1234', f, log)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('assertNewPasswordAllowed (FR-1)', () => {
  const off = { config: { hibpEnabled: false } };

  test('an 11-character password gives 422 password_too_short', async () => {
    await expect(assertNewPasswordAllowed('a'.repeat(11), off)).rejects.toMatchObject({
      status: 422,
      code: 'password_too_short',
    });
  });

  test('a 12-character password passes when the breach check is off, and never calls fetch', async () => {
    const f = body('');
    await expect(assertNewPasswordAllowed('a'.repeat(12), { ...off, fetch: f })).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  test('a breached password gives 422 password_breached when the check is on', async () => {
    const { suffix } = sha1Parts('password1234');
    const err = await assertNewPasswordAllowed('password1234', {
      config: { hibpEnabled: true },
      fetch: body(`${suffix}:9`),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, code: 'password_breached' });
  });

  test('an unreachable breach service fails open', async () => {
    const f = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
    await expect(
      assertNewPasswordAllowed('password1234', { config: { hibpEnabled: true }, fetch: f }),
    ).resolves.toBeUndefined();
  });
});

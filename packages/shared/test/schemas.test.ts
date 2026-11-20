import { describe, expect, test } from 'vitest';
import { acceptInviteRequestSchema, emailSchema, loginRequestSchema, meResponseSchema, passwordSchema } from '../src/index.ts';

describe('shared auth schemas', () => {
  test('email is trimmed and lower-cased before validation', () => {
    expect(emailSchema.parse('  Lance@Example.COM ')).toBe('lance@example.com');
  });

  test('email rejects non-addresses and anything over 254 characters', () => {
    expect(emailSchema.safeParse('nope').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
  });

  test('password is 12 to 128 characters', () => {
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  test('login request normalises the email and keeps the password as typed', () => {
    expect(loginRequestSchema.parse({ email: ' A@B.io ', password: ' x ' })).toEqual({
      email: 'a@b.io',
      password: ' x ',
    });
    expect(loginRequestSchema.safeParse({ email: 'a@b.io', password: '' }).success).toBe(false);
  });

  test('me response accepts the documented shape', () => {
    const me = {
      user: { id: 'u', email: 'a@b.io', name: 'A', timezone: 'UTC', hasTotp: false, passkeys: [] },
      csrfToken: 'c',
      memberships: [{ roadmapId: 'r', roadmapName: 'R', role: 'owner' }],
    };
    expect(meResponseSchema.parse(me)).toEqual(me);
  });
});

describe('acceptInviteRequestSchema time zone', () => {
  const base = { name: 'Nina', password: 'correct horse battery staple' };

  test('accepts a known IANA time zone and a missing one', () => {
    expect(acceptInviteRequestSchema.safeParse({ ...base, timezone: 'Europe/Berlin' }).success).toBe(true);
    expect(acceptInviteRequestSchema.safeParse(base).success).toBe(true);
  });

  test('rejects an unknown time zone', () => {
    const result = acceptInviteRequestSchema.safeParse({ ...base, timezone: 'Mars/Olympus' });
    expect(result.success).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import { signUnsubscribe, verifyUnsubscribe } from '../../src/mail/unsubscribe.ts';

const key = Buffer.alloc(32, 3);
const tenantId = '0192a000-0000-7000-8000-000000000001';
const userId = '0192a000-0000-7000-8000-000000000002';

describe('unsubscribe tokens (FR-5)', () => {
  test('FR-5: a signed token verifies to its tenant and user', () => {
    const token = signUnsubscribe(key, tenantId, userId);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyUnsubscribe(key, token)).toEqual({ tenantId, userId });
  });

  test('FR-5: a token with one character changed, a wrong signature, two parts or nothing is refused', () => {
    const token = signUnsubscribe(key, tenantId, userId);
    const last = token.slice(-1);
    expect(verifyUnsubscribe(key, `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`)).toBeNull();
    expect(verifyUnsubscribe(key, `${tenantId}.${userId}.${'A'.repeat(43)}`)).toBeNull();
    expect(verifyUnsubscribe(key, `${tenantId}.${userId}.short`)).toBeNull();
    expect(verifyUnsubscribe(key, `${tenantId}.${userId}`)).toBeNull();
    expect(verifyUnsubscribe(key, `${token}.extra`)).toBeNull();
    expect(verifyUnsubscribe(key, '')).toBeNull();
    // The ids of one token with the signature of another.
    const other = signUnsubscribe(key, tenantId, '0192a000-0000-7000-8000-000000000003');
    expect(verifyUnsubscribe(key, `${tenantId}.${userId}.${other.split('.')[2]}`)).toBeNull();
  });

  test('FR-5: a token signed with another key is refused', () => {
    const token = signUnsubscribe(Buffer.alloc(32, 4), tenantId, userId);
    expect(verifyUnsubscribe(key, token)).toBeNull();
  });
});

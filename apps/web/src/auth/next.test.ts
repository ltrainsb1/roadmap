import { describe, expect, test } from 'vitest';
import { safeNext } from './next.ts';

describe('safeNext', () => {
  test.each([
    ['/r/abc/members', '/r/abc/members'],
    ['/invite/tok?x=1', '/invite/tok?x=1'],
  ])('keeps the site path %s', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  test.each([
    null,
    '',
    'https://evil.com',
    'evil.com',
    '//evil.com',
    '/\\evil.com',
    '/a\\b',
  ])('falls back to / for %j', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });
});

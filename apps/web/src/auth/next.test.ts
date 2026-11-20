import { describe, expect, test } from 'vitest';
import { safeNext } from './next.ts';

describe('safeNext', () => {
  test.each([
    ['/r/abc/members', '/r/abc/members'],
    ['/invite/tok?x=1', '/invite/tok?x=1'],
    ['/r/abc/projects?q=two words&status=done', '/r/abc/projects?q=two words&status=done'],
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
    // Browsers strip tabs and line breaks, which turns these into //evil.com.
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    '/\t\n/evil.com',
    '/a\u0000b',
  ])('falls back to / for %j', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });
});

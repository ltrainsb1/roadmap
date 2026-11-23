import { expect, test } from 'vitest';
import { addressMatcher } from '../src/trusted-proxy.ts';

test('FR-3.6: addressMatcher matches IPv4, IPv4-mapped and IPv6 peers against their ranges, and nothing else', () => {
  const inRange = addressMatcher(['172.30.255.0/24', 'fd00:1::/64']);
  expect(inRange('172.30.255.3')).toBe(true);
  expect(inRange('::ffff:172.30.255.3')).toBe(true);
  expect(inRange('fd00:1::5')).toBe(true);
  expect(inRange('172.30.254.3')).toBe(false);
  expect(inRange('fd00:2::5')).toBe(false);
  expect(inRange('')).toBe(false);
  expect(inRange('caddy')).toBe(false);
  expect(addressMatcher([])('172.30.255.3')).toBe(false);
});

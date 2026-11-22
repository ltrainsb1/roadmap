import { afterEach, expect, test } from 'vitest';
import { endOfLocalDay, snapshotUrl } from './useSnapshots.ts';

const startTz = process.env.TZ;
afterEach(() => {
  if (startTz === undefined) delete process.env.TZ;
  else process.env.TZ = startTz;
});

test('FR-3.2: endOfLocalDay gives the last millisecond of that day in the local zone', () => {
  process.env.TZ = 'America/New_York';
  expect(endOfLocalDay('2027-01-15')).toBe('2027-01-16T04:59:59.999Z');
  // Summer time: four hours behind UTC, not five.
  expect(endOfLocalDay('2027-07-15')).toBe('2027-07-16T03:59:59.999Z');
  process.env.TZ = 'Asia/Kolkata';
  expect(endOfLocalDay('2027-01-15')).toBe('2027-01-15T18:29:59.999Z');
  process.env.TZ = 'UTC';
  expect(endOfLocalDay('2027-01-15')).toBe('2027-01-15T23:59:59.999Z');
});

test('FR-3.2: snapshotUrl is the app origin, then /s/ and the link id', () => {
  expect(snapshotUrl('abc_DEF-123')).toBe(`${window.location.origin}/s/abc_DEF-123`);
});

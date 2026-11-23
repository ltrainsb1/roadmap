import { expect, test } from 'vitest';
import { formatNotificationTime } from './when.ts';

test('FR-5.3: a notification time reads "{day} at {HH:MM}" in the person\'s zone, with fixed month names and a 24-hour clock', () => {
  expect(formatNotificationTime('2026-09-03T14:05:00.000Z', 'UTC')).toBe('3 Sep 2026 at 14:05');
  // Paris is UTC+1 in winter; the local day and hour are the ones shown.
  expect(formatNotificationTime('2027-01-12T09:30:00.000Z', 'Europe/Paris')).toBe('12 Jan 2027 at 10:30');
  // Past midnight locally: the next day, at 00:15, not 24:15.
  expect(formatNotificationTime('2027-07-01T22:15:00.000Z', 'Europe/Paris')).toBe('2 Jul 2027 at 00:15');
  // Behind UTC, the day before.
  expect(formatNotificationTime('2027-03-01T03:00:00.000Z', 'America/Los_Angeles')).toBe('28 Feb 2027 at 19:00');
});

test('FR-5.3: a zone this browser does not know reads as UTC', () => {
  expect(formatNotificationTime('2026-09-03T14:05:00.000Z', 'Not/AZone')).toBe('3 Sep 2026 at 14:05');
});

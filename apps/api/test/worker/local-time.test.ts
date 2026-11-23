import { describe, expect, test } from 'vitest';
import { addDays, localDate, localHour } from '../../src/worker/local-time.ts';

describe('worker: local time', () => {
  test('FR-5.2: the local date and hour follow the zone, daylight saving included', () => {
    const at = new Date('2026-11-22T12:30:00Z');
    expect([localDate(at, 'UTC'), localHour(at, 'UTC')]).toEqual(['2026-11-22', 12]);
    expect([localDate(at, 'Pacific/Kiritimati'), localHour(at, 'Pacific/Kiritimati')]).toEqual(['2026-11-23', 2]);
    expect([localDate(at, 'Pacific/Pago_Pago'), localHour(at, 'Pacific/Pago_Pago')]).toEqual(['2026-11-22', 1]);
    // New York leaves daylight saving at 06:00 UTC on 1 Nov 2026.
    expect(localHour(new Date('2026-11-01T05:59:00Z'), 'America/New_York')).toBe(1);
    expect(localHour(new Date('2026-11-01T06:00:00Z'), 'America/New_York')).toBe(1);
    expect(localHour(new Date('2026-11-01T13:00:00Z'), 'America/New_York')).toBe(8);
    // Midnight is hour 0, not 24.
    expect(localHour(new Date('2026-11-22T00:00:00Z'), 'UTC')).toBe(0);
  });

  test('FR-5.2: an unknown zone falls back to UTC and never throws', () => {
    const at = new Date('2026-11-22T23:30:00Z');
    expect(localDate(at, 'Mars/Olympus_Mons')).toBe('2026-11-22');
    expect(localHour(at, '')).toBe(23);
  });

  test('FR-5.1: addDays crosses months, years and leap days', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

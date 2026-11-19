import { describe, expect, test } from 'vitest';
import { dayRange, formatWhen } from './dates.ts';

describe('dayRange', () => {
  test('is the whole UTC day for UTC', () => {
    expect(dayRange('2026-11-18', 'UTC')).toEqual({ from: '2026-11-18T00:00:00.000Z', to: '2026-11-18T23:59:59.999Z' });
  });

  test('starts at local midnight east and west of UTC', () => {
    expect(dayRange('2026-11-18', 'Asia/Tokyo').from).toBe('2026-11-17T15:00:00.000Z');
    expect(dayRange('2026-11-18', 'America/New_York').from).toBe('2026-11-18T05:00:00.000Z');
    expect(dayRange('2026-11-18', 'America/New_York').to).toBe('2026-11-19T04:59:59.999Z');
  });

  test('a day with a clock change is 23 hours long', () => {
    const { from, to } = dayRange('2026-03-08', 'America/New_York');
    expect(new Date(to).getTime() + 1 - new Date(from).getTime()).toBe(23 * 3_600_000);
  });
});

describe('formatWhen', () => {
  test('shows the time in the given zone', () => {
    const tokyo = formatWhen('2026-11-18T15:30:00.000Z', 'Asia/Tokyo');
    const utc = formatWhen('2026-11-18T15:30:00.000Z', 'UTC');
    // 15:30 UTC is already the next morning in Tokyo.
    expect(utc).toContain('18');
    expect(tokyo).toContain('19');
  });
});

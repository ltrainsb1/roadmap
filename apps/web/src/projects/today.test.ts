import { describe, expect, test } from 'vitest';
import { todayIn } from './today.ts';

describe('FR-1.7 today', () => {
  test("todayIn gives the date in the person's zone", () => {
    expect(todayIn('Pacific/Auckland', new Date('2027-03-15T12:00:00Z'))).toBe('2027-03-16');
    expect(todayIn('America/Los_Angeles', new Date('2027-03-15T05:00:00Z'))).toBe('2027-03-14');
  });
});

import { describe, expect, test } from 'vitest';
import type { IcsEvent } from '../../src/calendar/ics.ts';
import { nearestEvents } from '../../src/calendar/public-routes.ts';

const ev = (end: string): IcsEvent => ({ uid: end, summary: end, start: end, end, sequence: 0, stamp: new Date(0), url: '' });
const ends = (events: IcsEvent[]) => events.map((e) => e.end);
const sorted = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01'].map(ev);

describe('nearestEvents (FR-4.1 feed limit)', () => {
  test('a feed within the limit is unchanged', () => {
    expect(nearestEvents(sorted, '2026-03-01', 5)).toBe(sorted);
  });

  test('past dates go first, oldest first; a date ending on the cut-off day counts as upcoming', () => {
    expect(ends(nearestEvents(sorted, '2026-03-01', 4))).toEqual(['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']);
    expect(ends(nearestEvents(sorted, '2026-03-01', 3))).toEqual(['2026-03-01', '2026-04-01', '2026-05-01']);
  });

  test('with more upcoming dates than room, the soonest are kept', () => {
    expect(ends(nearestEvents(sorted, '2026-02-01', 2))).toEqual(['2026-02-01', '2026-03-01']);
  });

  test('with only past dates, the most recent are kept', () => {
    expect(ends(nearestEvents(sorted, '2027-01-01', 2))).toEqual(['2026-04-01', '2026-05-01']);
  });
});

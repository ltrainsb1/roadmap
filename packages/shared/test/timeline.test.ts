import { describe, expect, test } from 'vitest';
import { barFor, dayNumber, timelineRange, timelineTicks, xOf, type Project } from '../src/index.ts';

const make = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  parentId: null,
  depth: 1,
  path: [],
  title: id,
  description: '',
  status: 'not_started',
  startDate: '2027-03-03',
  endDate: '2027-04-28',
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  assigneeIds: [],
  rank: 0,
  priorityLabel: null,
  archived: false,
  version: 1,
  updatedAt: '2027-01-01T00:00:00.000Z',
  ...over,
});
const item = make('a');
const TODAY = '2027-03-15';
const months = timelineRange([item], TODAY, 'months');
const huge = timelineRange([make('old', { startDate: '1900-01-01', endDate: '1900-01-01' }), make('new', { startDate: '2200-12-31', endDate: '2200-12-31' })], TODAY, 'weeks');

describe('timeline maths', () => {
  test('dayNumber counts whole days', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('2027-03-03') - dayNumber('2027-02-01')).toBe(30);
  });

  test('the range runs from the month before the earliest date to the month after the latest', () => {
    expect(months).toEqual({ start: '2027-02-01', end: '2027-05-31', days: 120, dayWidth: 6, width: 720 });
  });

  test('today widens the range', () => {
    expect(timelineRange([item], '2027-09-10', 'months').end).toBe('2027-10-31');
  });

  test("a milestone outside the item's dates widens the range", () => {
    const withMilestone = make('a', { milestones: [{ id: 'm', name: 'Kickoff', date: '2026-12-20' }] });
    expect(timelineRange([withMilestone], TODAY, 'months').start).toBe('2026-11-01');
  });

  test('with no dates anywhere the range is the three months around today', () => {
    const range = timelineRange([], TODAY, 'months');
    expect(range.start).toBe('2027-02-01');
    expect(range.end).toBe('2027-04-30');
  });

  test('Review focus 1: dates centuries apart keep the axis at 24,000 px', () => {
    expect(huge.width).toBeLessThanOrEqual(24000);
    expect(huge.dayWidth).toBeLessThan(24);
    expect(barFor({ startDate: '1950-06-01', endDate: '1950-06-01' }, huge)?.width).toBe(8);
  });

  test('xOf is pixels from the axis start', () => {
    expect(xOf('2027-02-01', months)).toBe(0);
    expect(xOf('2027-03-03', months)).toBe(180);
  });

  test('barFor places a range', () => {
    expect(barFor(item, months)).toEqual({ left: 180, width: 342, kind: 'range' });
  });

  test('Review focus 2: start only and end only are one-day markers, no dates is null', () => {
    expect(barFor({ startDate: '2027-03-03', endDate: null }, months)).toEqual({ left: 180, width: 8, kind: 'start' });
    expect(barFor({ startDate: null, endDate: '2027-04-28' }, months)).toEqual({ left: 516, width: 8, kind: 'end' });
    expect(barFor({ startDate: null, endDate: null }, months)).toBeNull();
  });

  test('ticks at months: years over months', () => {
    const { major, minor } = timelineTicks(months, 'months');
    expect(major).toEqual([{ date: '2027-02-01', label: '2027', left: 0, width: 720 }]);
    expect(minor.map((t) => t.label)).toEqual(['Feb', 'Mar', 'Apr', 'May']);
    expect(minor[0]).toMatchObject({ left: 0, width: 168 });
  });

  test('ticks at weeks: months over Mondays', () => {
    const range = timelineRange([item], TODAY, 'weeks');
    const { major, minor } = timelineTicks(range, 'weeks');
    expect(major[0]!.label).toBe('February 2027');
    expect(minor[0]).toEqual({ date: '2027-02-01', label: '1', left: 0, width: 168 });
    expect(minor[1]).toMatchObject({ date: '2027-02-08', label: '8' });
  });

  test('ticks at quarters', () => {
    const range = timelineRange([item], TODAY, 'quarters');
    const { minor } = timelineTicks(range, 'quarters');
    expect(minor.map((t) => t.label)).toEqual(['Q1', 'Q2']);
    expect(minor[0]).toMatchObject({ left: 0, width: 59 * range.dayWidth });
  });

  test('tick widths sum to the range width', () => {
    const range = timelineRange([make('x', { startDate: '2027-03-03', endDate: '2027-04-28' })], '2027-03-02', 'weeks');
    const { major, minor } = timelineTicks(range, 'weeks');
    expect(major.reduce((sum, t) => sum + t.width, 0)).toBeCloseTo(range.width);
    expect(minor.reduce((sum, t) => sum + t.width, 0)).toBeCloseTo(range.width);
  });

  test('minor ticks are dropped when too narrow', () => {
    expect(timelineTicks(huge, 'weeks').minor).toEqual([]);
  });
});

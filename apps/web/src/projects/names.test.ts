import type { Project } from '@roadmap/shared';
import { describe, expect, test } from 'vitest';
import { addChildLabel, formatDates, levelName, statusName, warningText } from './names.ts';

describe('FR-1.7 project names', () => {
  test.each([
    ['not_started', 'Not started'],
    ['in_progress', 'In progress'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ] as const)('status %s reads "%s"', (status, text) => {
    expect(statusName(status)).toBe(text);
  });

  test.each([
    [1, 'Project', 'Add sub-project'],
    [2, 'Sub-project', 'Add task'],
    [3, 'Task', 'Add sub-task'],
    [4, 'Sub-task', null],
  ] as const)('level %i is a %s and its add item is %s', (depth, name, add) => {
    expect(levelName(depth)).toBe(name);
    expect(addChildLabel(depth)).toBe(add);
  });

  test('a level outside 1 to 4 is an item', () => {
    expect(levelName(9)).toBe('Item');
  });
});

describe('FR-1.7 date phrases', () => {
  test('both dates in one year drop the year from the first', () => {
    expect(formatDates('2027-03-03', '2027-04-28')).toBe('3 Mar to 28 Apr 2027');
  });
  test('both dates in different years keep both years', () => {
    expect(formatDates('2026-12-01', '2027-01-15')).toBe('1 Dec 2026 to 15 Jan 2027');
  });
  test('a start alone', () => {
    expect(formatDates('2027-03-03', null)).toBe('From 3 Mar 2027');
  });
  test('an end alone', () => {
    expect(formatDates(null, '2027-04-28')).toBe('Until 28 Apr 2027');
  });
  test('no dates', () => {
    expect(formatDates(null, null)).toBe('No dates');
  });
  test('a date is never shifted by the reader\'s time zone', () => {
    expect(formatDates('2027-01-01', null)).toBe('From 1 Jan 2027');
  });
});

describe('FR-1.7 warning sentences', () => {
  const item = (id: string, title: string): Project => ({ id, title }) as Project;
  const byId = new Map([item('p', 'Season'), item('b', 'Build set')].map((i) => [i.id, i]));

  test('outside the parent', () => {
    expect(warningText({ kind: 'outside_parent', parentId: 'p' }, byId)).toBe("Dates fall outside Season's dates.");
  });
  test('starts before a blocker ends', () => {
    expect(warningText({ kind: 'blocked_by_later', blockerId: 'b' }, byId)).toBe('Starts before Build set ends.');
  });
  test('an item that is gone from the list still gets a sentence', () => {
    expect(warningText({ kind: 'outside_parent', parentId: 'x' }, byId)).toBe("Dates fall outside the parent's dates.");
    expect(warningText({ kind: 'blocked_by_later', blockerId: 'x' }, byId)).toBe('Starts before a blocker ends.');
  });
});

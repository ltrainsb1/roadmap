import type { Project } from '@roadmap/shared';
import { describe, expect, test } from 'vitest';
import { addChildLabel, formatDay, formatMilestone, itemCount, levelName, levelPlural, statusName, warningText } from './names.ts';

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
  test('September is "Sep" on any ICU', () => {
    expect(formatDay('2027-09-03')).toBe('3 Sep 2027');
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

describe('FR-1.7 milestone phrases', () => {
  test('a milestone reads with its name and date', () => {
    expect(formatMilestone({ name: 'Beta', date: '2027-03-03' })).toBe('Milestone: Beta, 3 Mar 2027');
  });
});

describe('FR-1.7 Board names', () => {
  test.each([
    [1, 'Projects'],
    [2, 'Sub-projects'],
    [3, 'Tasks'],
    [4, 'Sub-tasks'],
  ] as const)('level %i in the plural is %s', (depth, name) => {
    expect(levelPlural(depth)).toBe(name);
  });

  test('a card count', () => {
    expect(itemCount(0)).toBe('0 items');
    expect(itemCount(1)).toBe('1 item');
    expect(itemCount(3)).toBe('3 items');
  });
});

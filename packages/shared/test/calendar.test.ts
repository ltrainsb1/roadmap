import { describe, expect, test } from 'vitest';
import { CALENDAR_LIMITS, DEFAULT_FEED_CHOICES, feedChoicesSchema, feedStateSchema } from '../src/calendar.ts';

describe('calendar feed choices', () => {
  test('FR-4.2: the default choices are all roadmaps, item dates and milestones, not only mine', () => {
    expect(DEFAULT_FEED_CHOICES).toEqual({ roadmaps: 'all', itemDates: true, milestones: true, onlyMine: false });
    expect(feedChoicesSchema.safeParse(DEFAULT_FEED_CHOICES).success).toBe(true);
  });

  test('FR-4.2: choices need item dates or milestones, and a chosen list of at least one roadmap', () => {
    const none = feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, itemDates: false, milestones: false });
    expect(none.success).toBe(false);
    expect(none.error?.issues[0]).toMatchObject({ message: 'nothing_to_show', path: ['itemDates'] });
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, itemDates: false }).success).toBe(true);
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, milestones: false }).success).toBe(true);
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, roadmaps: [] }).success).toBe(false);
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, roadmaps: ['r1'] }).success).toBe(true);
  });

  test('FR-4.2: a list of more than 100 roadmaps is refused', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
    expect(CALENDAR_LIMITS.roadmaps).toBe(100);
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, roadmaps: ids(100) }).success).toBe(true);
    expect(feedChoicesSchema.safeParse({ ...DEFAULT_FEED_CHOICES, roadmaps: ids(101) }).success).toBe(false);
  });

  test('FR-4.2: a feed\'s kept choices may hold an empty list, left by deleted roadmaps, but never one past 100', () => {
    const feed = (roadmaps: unknown) => ({ feed: { choices: { ...DEFAULT_FEED_CHOICES, roadmaps }, createdAt: 'x', lastFetchedAt: null } });
    expect(feedStateSchema.safeParse(feed([])).success).toBe(true);
    expect(feedStateSchema.safeParse(feed('all')).success).toBe(true);
    expect(feedStateSchema.safeParse(feed(Array.from({ length: 101 }, (_, i) => `r${i}`))).success).toBe(false);
    expect(feedStateSchema.safeParse({ feed: null }).success).toBe(true);
  });
});

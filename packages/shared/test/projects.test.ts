import { describe, expect, test } from 'vitest';
import {
  AUDIT_ACTIONS,
  LIMITS,
  MAX_DEPTH,
  calendarDateSchema,
  createProjectRequestSchema,
  linkSchema,
  milestoneSchema,
  priorityLabelRequestSchema,
  projectListSchema,
  reorderRequestSchema,
  setAssigneesRequestSchema,
  tagSchema,
  updateProjectRequestSchema,
} from '../src/index.ts';

describe('shared project schemas', () => {
  test('Review focus 4: calendarDateSchema accepts 2027-02-28 and rejects 2027-02-30, 2027-13-01, 27-02-28 and a date with a time', () => {
    expect(calendarDateSchema.safeParse('2027-02-28').success).toBe(true);
    expect(calendarDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const bad of ['2027-02-30', '2027-13-01', '27-02-28', '2027-02-28T10:00:00Z', '1899-12-31', '2201-01-01', '2027-2-8', 5]) {
      expect(calendarDateSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  test('tagSchema trims and lower-cases, and rejects an empty tag and a 31-character tag', () => {
    expect(tagSchema.parse('  Q3-Launch ')).toBe('q3-launch');
    expect(tagSchema.safeParse('   ').success).toBe(false);
    expect(tagSchema.safeParse('a'.repeat(30)).success).toBe(true);
    expect(tagSchema.safeParse('a'.repeat(31)).success).toBe(false);
  });

  test('linkSchema accepts http and https and rejects javascript:, data: and a bare host', () => {
    const link = (url: string) => linkSchema.safeParse({ id: 'l1', label: 'Spec', url });
    expect(link('http://example.com/a').success).toBe(true);
    expect(link('https://example.com').success).toBe(true);
    expect(link('javascript:alert(1)').success).toBe(false);
    expect(link('data:text/html,hi').success).toBe(false);
    expect(link('example.com').success).toBe(false);
    expect(link(`https://example.com/${'a'.repeat(2000)}`).success).toBe(false);
    expect(linkSchema.safeParse({ id: 'l', label: 'x'.repeat(81), url: 'https://a.io' }).success).toBe(false);
  });

  test('milestoneSchema needs a name and a real date', () => {
    expect(milestoneSchema.safeParse({ id: 'm', name: 'Beta', date: '2027-03-01' }).success).toBe(true);
    expect(milestoneSchema.safeParse({ id: 'm', name: ' ', date: '2027-03-01' }).success).toBe(false);
    expect(milestoneSchema.safeParse({ id: 'm', name: 'Beta', date: '2027-03-32' }).success).toBe(false);
  });

  test('updateProjectRequestSchema requires version and rejects an end date before the start date with date_order', () => {
    expect(updateProjectRequestSchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1 }).success).toBe(true);

    const bad = updateProjectRequestSchema.safeParse({ version: 1, startDate: '2027-03-02', endDate: '2027-03-01' });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues).toHaveLength(1);
      expect(bad.error.issues[0]?.message).toBe('date_order');
      expect(bad.error.issues[0]?.path).toEqual(['endDate']);
    }
    for (const ok of [
      { startDate: '2027-03-01', endDate: '2027-03-01' },
      { startDate: '2027-03-02' },
      { endDate: '2027-03-01' },
      { startDate: null, endDate: '2027-03-01' },
      { startDate: '2027-03-02', endDate: null },
    ]) {
      expect(updateProjectRequestSchema.safeParse({ version: 1, ...ok }).success).toBe(true);
    }
  });

  test('updateProjectRequestSchema normalises and de-duplicates tags and blockedBy, accepts new and existing entries, and strips unknown keys', () => {
    const out = updateProjectRequestSchema.parse({
      version: 3,
      tags: [' Alpha', 'alpha ', 'Beta'],
      blockedBy: ['a', 'b', 'a'],
      links: [{ label: 'New', url: 'https://a.io' }, { id: 'l1', label: 'Old', url: 'https://b.io' }],
      milestones: [{ name: 'M', date: '2027-01-01' }, { id: 'm1', name: 'N', date: '2027-01-02' }],
      status: 'blocked',
      junk: true,
    });
    expect(out.tags).toEqual(['alpha', 'beta']);
    expect(out.blockedBy).toEqual(['a', 'b']);
    expect(out.links?.[0]).toEqual({ label: 'New', url: 'https://a.io' });
    expect(out.milestones?.[1]?.id).toBe('m1');
    expect(out).not.toHaveProperty('junk');
    expect(updateProjectRequestSchema.safeParse({ version: 1, status: 'nope' }).success).toBe(false);
  });

  test('updateProjectRequestSchema rejects 11 tags, 11 links, 21 milestones and 21 blockedBy entries', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const links = Array.from({ length: 11 }, (_, i) => ({ label: 'l', url: `https://a.io/${i}` }));
    const milestones = Array.from({ length: 21 }, (_, i) => ({ name: `m${i}`, date: '2027-01-01' }));
    const blockedBy = Array.from({ length: 21 }, (_, i) => `id${i}`);
    expect(updateProjectRequestSchema.safeParse({ version: 1, tags }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, links }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, milestones }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, blockedBy }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, tags: tags.slice(0, 10), links: links.slice(0, 10), milestones: milestones.slice(0, 20), blockedBy: blockedBy.slice(0, 20) }).success).toBe(true);
  });

  test('updateProjectRequestSchema limits title and description', () => {
    expect(updateProjectRequestSchema.safeParse({ version: 1, title: '' }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, title: 'a'.repeat(201) }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ version: 1, description: 'a'.repeat(5000) }).success).toBe(true);
    expect(updateProjectRequestSchema.safeParse({ version: 1, description: 'a'.repeat(5001) }).success).toBe(false);
  });

  test('createProjectRequestSchema trims the title and rejects an empty or 201-character title', () => {
    expect(createProjectRequestSchema.parse({ parentId: null, title: '  Launch  ' })).toEqual({ parentId: null, title: 'Launch' });
    expect(createProjectRequestSchema.safeParse({ parentId: 'p', title: '   ' }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ parentId: null, title: 'a'.repeat(201) }).success).toBe(false);
    expect(createProjectRequestSchema.safeParse({ parentId: null, title: 'a'.repeat(200) }).success).toBe(true);
  });

  test('assignee, reorder and priority label requests enforce their bounds', () => {
    expect(setAssigneesRequestSchema.safeParse({ userIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }).success).toBe(false);
    expect(setAssigneesRequestSchema.safeParse({ userIds: [] }).success).toBe(true);
    expect(reorderRequestSchema.safeParse({ parentId: null, orderedIds: [] }).success).toBe(false);
    expect(reorderRequestSchema.safeParse({ parentId: null, orderedIds: ['a'] }).success).toBe(true);
    expect(priorityLabelRequestSchema.safeParse({ label: 'P5' }).success).toBe(false);
    expect(priorityLabelRequestSchema.safeParse({ label: null }).success).toBe(true);
    expect(priorityLabelRequestSchema.safeParse({ label: 'P1' }).success).toBe(true);
  });

  test('project list parses a full item and the constants match the plan', () => {
    const item = {
      id: 'p1', parentId: null, depth: 1, path: [], title: 'T', description: '', status: 'not_started',
      startDate: null, endDate: '2027-01-01', milestones: [], tags: [], links: [], blockedBy: [], assigneeIds: [],
      rank: 0, priorityLabel: null, archived: false, version: 1, updatedAt: '2027-01-01T00:00:00.000Z',
    };
    expect(projectListSchema.parse({ items: [item] }).items[0]).toEqual(item);
    expect(MAX_DEPTH).toBe(4);
    expect(LIMITS.itemsPerRoadmap).toBe(2000);
    expect(AUDIT_ACTIONS).toEqual(expect.arrayContaining(['project.create', 'project.update', 'project.delete', 'project.archive', 'project.unarchive', 'project.assign', 'project.reorder', 'project.priority_label']));
  });
});

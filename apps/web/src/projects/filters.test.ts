import { NO_FILTERS, type ProjectFilters } from '@roadmap/shared';
import { describe, expect, test } from 'vitest';
import { filtersFromSearch, filtersToSearch, hasNarrowing } from './filters.ts';

const read = (query: string) => filtersFromSearch(new URLSearchParams(query));

describe('filters in the address', () => {
  test('FR-1.8: every field survives a round trip', () => {
    const filters: ProjectFilters = {
      text: 'Launch plan',
      statuses: ['in_progress', 'blocked'],
      assigneeIds: ['u1', 'u2'],
      tags: ['design', 'q3'],
      labels: ['P1', 'none'],
      from: '2027-03-03',
      to: '2027-04-28',
      showArchived: true,
    };
    const query = filtersToSearch(filters).toString();
    expect(read(query)).toEqual(filters);
  });

  test('FR-1.8: multi-value keys repeat', () => {
    const query = filtersToSearch({ ...NO_FILTERS, statuses: ['done', 'blocked'], tags: ['a', 'b'] });
    expect(query.getAll('status')).toEqual(['done', 'blocked']);
    expect(query.getAll('tag')).toEqual(['a', 'b']);
  });

  test('FR-1.8: assignee=me stays "me" in both directions, so a shared link means its reader', () => {
    const filters = read('assignee=me&assignee=u2');
    expect(filters.assigneeIds).toEqual(['me', 'u2']);
    expect(filtersToSearch(filters).getAll('assignee')).toEqual(['me', 'u2']);
    expect(filtersToSearch(filters).toString()).toBe('assignee=me&assignee=u2');
  });

  test('FR-1.8: unknown and malformed values are dropped', () => {
    const filters = read('status=nope&status=done&label=P9&label=P2&from=2027-02-31&to=soon&archived=yes&tag=%20&assignee=');
    expect(filters).toEqual({ ...NO_FILTERS, statuses: ['done'], labels: ['P2'] });
  });

  test('FR-1.8: tags are trimmed and lower case, and repeats are kept once', () => {
    expect(read('tag=%20Design%20&tag=design').tags).toEqual(['design']);
  });

  test('FR-1.8: no filters give an empty query string', () => {
    expect(filtersToSearch(NO_FILTERS).toString()).toBe('');
    expect(read('')).toEqual(NO_FILTERS);
  });

  test('FR-1.8: only a search or a field filter narrows the list', () => {
    expect(hasNarrowing(NO_FILTERS)).toBe(false);
    expect(hasNarrowing({ ...NO_FILTERS, showArchived: true })).toBe(false);
    expect(hasNarrowing({ ...NO_FILTERS, text: '   ' })).toBe(false);
    expect(hasNarrowing({ ...NO_FILTERS, text: 'a' })).toBe(true);
    expect(hasNarrowing({ ...NO_FILTERS, to: '2027-01-01' })).toBe(true);
  });
});

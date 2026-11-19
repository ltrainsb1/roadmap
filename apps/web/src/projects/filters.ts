import {
  activeFilterCount,
  calendarDateSchema,
  PRIORITY_LABELS,
  PROJECT_STATUSES,
  type PriorityLabel,
  type ProjectFilters,
  type ProjectStatus,
} from '@roadmap/shared';

const isStatus = (value: string): value is ProjectStatus => (PROJECT_STATUSES as readonly string[]).includes(value);
const isLabel = (value: string): value is PriorityLabel | 'none' => value === 'none' || (PRIORITY_LABELS as readonly string[]).includes(value);

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const date = (value: string | null): string | null => (value !== null && calendarDateSchema.safeParse(value).success ? value : null);

/**
 * The filters an address stands for. `assignee=me` means `meId`. Values that are not valid (an unknown status,
 * a date that does not exist) are dropped; values that are valid but name something that is gone (a tag no
 * item has, a member who left) are kept, so the person can see and remove them.
 */
export function filtersFromSearch(params: URLSearchParams, meId: string): ProjectFilters {
  const assignees = params
    .getAll('assignee')
    .map((id) => (id === 'me' ? meId : id))
    .filter((id) => id !== '');
  return {
    text: params.get('q') ?? '',
    statuses: unique(params.getAll('status').filter(isStatus)),
    assigneeIds: unique(assignees),
    tags: unique(params.getAll('tag').map((t) => t.trim().toLowerCase()).filter((t) => t !== '')),
    labels: unique(params.getAll('label').filter(isLabel)),
    from: date(params.get('from')),
    to: date(params.get('to')),
    showArchived: params.get('archived') === '1',
  };
}

/** The query string for `f`; empty when nothing is set. Multi-value fields repeat their key. */
export function filtersToSearch(f: ProjectFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (f.text !== '') params.set('q', f.text);
  for (const status of f.statuses) params.append('status', status);
  for (const id of f.assigneeIds) params.append('assignee', id);
  for (const tag of f.tags) params.append('tag', tag);
  for (const label of f.labels) params.append('label', label);
  if (f.from !== null) params.set('from', f.from);
  if (f.to !== null) params.set('to', f.to);
  if (f.showArchived) params.set('archived', '1');
  return params;
}

/** Whether a search or a field filter narrows the list. "Show archived" widens it, so it does not count. */
export const hasNarrowing = (f: ProjectFilters): boolean => f.text.trim() !== '' || activeFilterCount(f) > 0;

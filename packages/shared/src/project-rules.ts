import type { PriorityLabel, Project, ProjectStatus } from './projects.ts';

export type ProjectWarning =
  | { kind: 'outside_parent'; parentId: string }
  | { kind: 'blocked_by_later'; blockerId: string };

/** Warnings for one item, given the whole roadmap's items by id. Dates are `YYYY-MM-DD`, so strings compare in order. */
export function projectWarnings(item: Project, byId: ReadonlyMap<string, Project>): ProjectWarning[] {
  const warnings: ProjectWarning[] = [];
  const parent = item.parentId === null ? undefined : byId.get(item.parentId);
  if (parent) {
    const startsEarly = !!item.startDate && !!parent.startDate && item.startDate < parent.startDate;
    const endsLate = !!item.endDate && !!parent.endDate && item.endDate > parent.endDate;
    if (startsEarly || endsLate) warnings.push({ kind: 'outside_parent', parentId: parent.id });
  }
  if (item.startDate) {
    for (const blockerId of item.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker && !blocker.archived && blocker.endDate && item.startDate <= blocker.endDate) {
        warnings.push({ kind: 'blocked_by_later', blockerId });
      }
    }
  }
  return warnings;
}

/**
 * True if making `itemId` blocked by `blockerIds` would create a cycle, or names itself, an ancestor or a descendant.
 * `byId` is the stored state: the item's own stored `blockedBy` is never followed, only the proposed list is judged.
 * Blocker ids missing from `byId` are ignored.
 */
export function wouldCycle(itemId: string, blockerIds: readonly string[], byId: ReadonlyMap<string, Project>): boolean {
  const self = byId.get(itemId);
  const visited = new Set<string>();
  const stack: string[] = [];
  for (const blockerId of blockerIds) {
    if (blockerId === itemId) return true;
    const blocker = byId.get(blockerId);
    if (!blocker) continue;
    if (self?.path.includes(blockerId)) return true;
    if (blocker.path.includes(itemId)) return true;
    stack.push(blockerId);
  }
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of byId.get(id)?.blockedBy ?? []) {
      if (next === itemId) return true;
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

export interface TreeNode {
  item: Project;
  children: TreeNode[];
  /** 1-based place among the siblings present. */
  position: number;
}

const byRankThenId = (a: Project, b: Project): number => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Roots first, children nested, each level sorted by rank then id. Items whose parent is missing are dropped. */
export function buildTree(items: readonly Project[]): TreeNode[] {
  const childrenOf = new Map<string | null, Project[]>();
  for (const item of items) {
    const siblings = childrenOf.get(item.parentId);
    if (siblings) siblings.push(item);
    else childrenOf.set(item.parentId, [item]);
  }
  const build = (parentId: string | null): TreeNode[] =>
    (childrenOf.get(parentId) ?? [])
      .sort(byRankThenId)
      .map((item, index) => ({ item, children: build(item.id), position: index + 1 }));
  return build(null);
}

export interface ProjectFilters {
  text: string;
  statuses: ProjectStatus[];
  assigneeIds: string[];
  tags: string[];
  labels: Array<PriorityLabel | 'none'>;
  from: string | null;
  to: string | null;
  showArchived: boolean;
}

/** Treat as read-only. */
export const NO_FILTERS: ProjectFilters = {
  text: '',
  statuses: [],
  assigneeIds: [],
  tags: [],
  labels: [],
  from: null,
  to: null,
  showArchived: false,
};

/** Fields with a filter set. The date range counts once; text and showArchived do not count. */
export function activeFilterCount(f: ProjectFilters): number {
  return [f.statuses.length > 0, f.assigneeIds.length > 0, f.tags.length > 0, f.labels.length > 0, f.from !== null || f.to !== null].filter(Boolean).length;
}

/** Ids that match, and ids to show only as context (ancestors of a match that do not match themselves). */
export function filterProjects(items: readonly Project[], f: ProjectFilters): { matches: Set<string>; context: Set<string> } {
  const text = f.text.trim().toLowerCase();
  const statuses = new Set<string>(f.statuses);
  const assignees = new Set(f.assigneeIds);
  const tags = new Set(f.tags.map((t) => t.trim().toLowerCase()));
  const labels = new Set<string>(f.labels);
  const hasRange = f.from !== null || f.to !== null;

  const matchesItem = (item: Project): boolean => {
    if (item.archived && !f.showArchived) return false;
    if (statuses.size > 0 && !statuses.has(item.status)) return false;
    if (assignees.size > 0 && !item.assigneeIds.some((id) => assignees.has(id))) return false;
    if (tags.size > 0 && !item.tags.some((t) => tags.has(t.toLowerCase()))) return false;
    if (labels.size > 0 && !labels.has(item.priorityLabel ?? 'none')) return false;
    if (hasRange) {
      const start = item.startDate ?? item.endDate;
      const end = item.endDate ?? item.startDate;
      if (start === null || end === null) return false;
      if (f.to !== null && start > f.to) return false;
      if (f.from !== null && end < f.from) return false;
    }
    if (text) {
      const haystack = `${item.title}\n${item.description}\n${item.tags.join('\n')}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  };

  const matches = new Set<string>();
  for (const item of items) if (matchesItem(item)) matches.add(item.id);

  const byId = new Map(items.map((item) => [item.id, item]));
  const context = new Set<string>();
  for (const id of matches) {
    for (const ancestorId of byId.get(id)!.path) {
      if (matches.has(ancestorId) || context.has(ancestorId)) continue;
      const ancestor = byId.get(ancestorId);
      if (ancestor && (f.showArchived || !ancestor.archived)) context.add(ancestorId);
    }
  }
  return { matches, context };
}

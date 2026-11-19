import { describe, expect, test } from 'vitest';
import {
  NO_FILTERS,
  activeFilterCount,
  buildTree,
  filterProjects,
  projectWarnings,
  wouldCycle,
  type Project,
  type ProjectFilters,
} from '../src/index.ts';

let counter = 0;
const make = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  parentId: null,
  depth: 1,
  path: [],
  title: id,
  description: '',
  status: 'not_started',
  startDate: null,
  endDate: null,
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  assigneeIds: [],
  rank: counter++,
  priorityLabel: null,
  archived: false,
  version: 1,
  updatedAt: '2027-01-01T00:00:00.000Z',
  ...over,
});
const mapOf = (items: Project[]) => new Map(items.map((i) => [i.id, i]));
const child = (id: string, parent: Project, over: Partial<Project> = {}) =>
  make(id, { parentId: parent.id, depth: parent.depth + 1, path: [...parent.path, parent.id], ...over });
const f = (over: Partial<ProjectFilters>): ProjectFilters => ({ ...NO_FILTERS, ...over });

describe('projectWarnings', () => {
  test("Review focus 4: a child outside its parent's dates gets outside_parent; inside, or with dates missing, gets none", () => {
    const parent = make('p', { startDate: '2027-02-01', endDate: '2027-02-28' });
    const warn = (over: Partial<Project>) => projectWarnings(child('c', parent, over), mapOf([parent]));
    const outside = [{ kind: 'outside_parent', parentId: 'p' }];
    expect(warn({ startDate: '2027-01-31' })).toEqual(outside);
    expect(warn({ endDate: '2027-03-01' })).toEqual(outside);
    expect(warn({ startDate: '2027-01-01', endDate: '2027-04-01' })).toEqual(outside); // one warning only
    expect(warn({ startDate: '2027-02-01', endDate: '2027-02-28' })).toEqual([]);
    expect(warn({})).toEqual([]);
    expect(warn({ startDate: '2027-02-10' })).toEqual([]);
    // parent with one date: only that side is compared
    const half = make('h', { startDate: '2027-02-01' });
    expect(projectWarnings(child('c', half, { startDate: '2027-01-01' }), mapOf([half]))).toEqual([{ kind: 'outside_parent', parentId: 'h' }]);
    expect(projectWarnings(child('c', half, { endDate: '2030-01-01' }), mapOf([half]))).toEqual([]);
    // undated parent, top-level item, and missing parent
    const undated = make('u');
    expect(projectWarnings(child('c', undated, { startDate: '2020-01-01' }), mapOf([undated]))).toEqual([]);
    expect(projectWarnings(make('top', { startDate: '2020-01-01' }), mapOf([]))).toEqual([]);
    expect(projectWarnings(child('c', parent, { startDate: '2020-01-01' }), mapOf([]))).toEqual([]);
  });

  test('blocked_by_later when an item starts on or before its blocker ends', () => {
    const b1 = make('b1', { endDate: '2027-03-10' });
    const b2 = make('b2', { endDate: '2027-03-01' });
    const b3 = make('b3', { endDate: '2027-01-01' });
    const archived = make('b4', { endDate: '2027-12-01', archived: true });
    const noEnd = make('b5');
    const byId = mapOf([b1, b2, b3, archived, noEnd]);
    const item = make('i', { startDate: '2027-03-01', blockedBy: ['b1', 'b2', 'b3', 'b4', 'b5', 'gone'] });
    expect(projectWarnings(item, byId)).toEqual([
      { kind: 'blocked_by_later', blockerId: 'b1' },
      { kind: 'blocked_by_later', blockerId: 'b2' },
    ]);
    expect(projectWarnings(make('i2', { blockedBy: ['b1'] }), byId)).toEqual([]);
  });

  test('projectWarnings still computes warnings for an archived item and lists outside_parent before blocked_by_later', () => {
    const parent = make('p', { startDate: '2027-02-01', endDate: '2027-02-28' });
    const blocker = make('b', { endDate: '2027-06-01' });
    const item = child('c', parent, { startDate: '2027-01-01', blockedBy: ['b'], archived: true });
    expect(projectWarnings(item, mapOf([parent, blocker]))).toEqual([
      { kind: 'outside_parent', parentId: 'p' },
      { kind: 'blocked_by_later', blockerId: 'b' },
    ]);
  });
});

describe('wouldCycle', () => {
  test('wouldCycle: itself, an ancestor, a descendant, a direct cycle and a three-step cycle are all true; an unrelated item is false', () => {
    const root = make('root');
    const mid = child('mid', root);
    const leaf = child('leaf', mid);
    const other = make('other');
    const a = make('a', { blockedBy: ['b'] });
    const b = make('b', { blockedBy: ['c'] });
    const c = make('c');
    const byId = mapOf([root, mid, leaf, other, a, b, c]);
    expect(wouldCycle('mid', ['mid'], byId)).toBe(true);
    expect(wouldCycle('leaf', ['root'], byId)).toBe(true);
    expect(wouldCycle('root', ['leaf'], byId)).toBe(true);
    expect(wouldCycle('b', ['a'], byId)).toBe(true); // direct: a already waits on b
    expect(wouldCycle('c', ['a'], byId)).toBe(true); // three-step: a -> b -> c -> a
    expect(wouldCycle('mid', ['other'], byId)).toBe(false);
    expect(wouldCycle('other', ['c'], byId)).toBe(false);
    expect(wouldCycle('other', [], byId)).toBe(false);
    expect(wouldCycle('other', ['missing'], byId)).toBe(false);
  });

  test("wouldCycle judges the proposed list, not the item's stored blockedBy", () => {
    // a is stored as blocked by b; proposing a -> c must not see the old a -> b edge
    const a = make('a', { blockedBy: ['b'] });
    const b = make('b', { blockedBy: ['a'] }); // stored cycle is irrelevant to a new proposal
    const c = make('c');
    expect(wouldCycle('a', ['c'], mapOf([a, b, c]))).toBe(false);
    // and an item that is not yet stored can still be checked
    expect(wouldCycle('new', ['c'], mapOf([c]))).toBe(false);
  });

  test('wouldCycle terminates on a shared blocker reached by two paths', () => {
    const d = make('d');
    const b = make('b', { blockedBy: ['d'] });
    const c = make('c', { blockedBy: ['d'] });
    const x = make('x');
    expect(wouldCycle('x', ['b', 'c'], mapOf([b, c, d, x]))).toBe(false);
  });
});

describe('buildTree', () => {
  test('buildTree nests four levels, sorts by rank, numbers positions from 1 and drops orphans', () => {
    const p1 = make('p1', { rank: 1 });
    const p0 = make('p0', { rank: 0 });
    const s = child('s', p0, { rank: 0 });
    const t2 = child('t2', s, { rank: 5 });
    const t1 = child('t1', s, { rank: 2 });
    const st = child('st', t1, { rank: 0 });
    const orphan = make('orphan', { parentId: 'nope', depth: 2, path: ['nope'] });
    const orphanKid = make('orphanKid', { parentId: 'orphan', depth: 3, path: ['nope', 'orphan'] });
    const tree = buildTree([st, t2, orphanKid, p1, orphan, t1, s, p0]);
    expect(tree.map((n) => [n.item.id, n.position])).toEqual([['p0', 1], ['p1', 2]]);
    const sNode = tree[0]!.children[0]!;
    expect(sNode.item.id).toBe('s');
    expect(sNode.children.map((n) => [n.item.id, n.position])).toEqual([['t1', 1], ['t2', 2]]);
    expect(sNode.children[0]!.children[0]!.item.id).toBe('st');
    expect(sNode.children[0]!.children[0]!.position).toBe(1);
    expect(tree[1]!.children).toEqual([]);
  });

  test('buildTree breaks rank ties by id so the order is stable', () => {
    const items = [make('b', { rank: 0 }), make('a', { rank: 0 }), make('c', { rank: 0 })];
    expect(buildTree(items).map((n) => n.item.id)).toEqual(['a', 'b', 'c']);
    expect(buildTree([...items].reverse()).map((n) => n.item.id)).toEqual(['a', 'b', 'c']);
    expect(buildTree([])).toEqual([]);
  });

  test('buildTree numbers positions among the siblings present, not the stored rank', () => {
    const items = [make('x', { rank: 7 }), make('y', { rank: 9 })];
    expect(buildTree(items).map((n) => n.position)).toEqual([1, 2]);
  });
});

describe('filterProjects', () => {
  const root = make('root', { title: 'Platform', description: 'Core services', tags: ['infra'] });
  const a = child('a', root, { title: 'Billing', status: 'in_progress', assigneeIds: ['u1'], tags: ['money', 'q3'], priorityLabel: 'P1', startDate: '2027-02-01', endDate: '2027-02-28' });
  const b = child('b', root, { title: 'Search', description: 'Full TEXT index', status: 'blocked', assigneeIds: ['u2'], priorityLabel: 'P2', startDate: '2027-04-01', endDate: '2027-04-30' });
  const c = child('c', a, { title: 'Invoices', tags: ['money'], endDate: '2027-02-10' });
  const d = child('d', root, { title: 'Misc', status: 'done', archived: true, assigneeIds: ['u1'] });
  const items = [root, a, b, c, d];
  const ids = (s: Set<string>) => [...s].sort();

  test('FR-1.8 filterProjects: status, assignee, tag, label (including none), date overlap and text, alone and combined', () => {
    expect(ids(filterProjects(items, NO_FILTERS).matches)).toEqual(['a', 'b', 'c', 'root']);
    expect(ids(filterProjects(items, f({ statuses: ['in_progress', 'blocked'] })).matches)).toEqual(['a', 'b']);
    expect(ids(filterProjects(items, f({ assigneeIds: ['u2', 'u9'] })).matches)).toEqual(['b']);
    expect(ids(filterProjects(items, f({ tags: ['money'] })).matches)).toEqual(['a', 'c']);
    expect(ids(filterProjects(items, f({ tags: ['MONEY', 'infra'] })).matches)).toEqual(['a', 'c', 'root']);
    expect(ids(filterProjects(items, f({ labels: ['P1'] })).matches)).toEqual(['a']);
    expect(ids(filterProjects(items, f({ labels: ['none'] })).matches)).toEqual(['c', 'root']);
    expect(ids(filterProjects(items, f({ labels: ['none', 'P2'] })).matches)).toEqual(['b', 'c', 'root']);
    // date overlap, inclusive on both ends; undated items drop out once a range is set
    expect(ids(filterProjects(items, f({ from: '2027-02-28', to: '2027-03-15' })).matches)).toEqual(['a']);
    expect(ids(filterProjects(items, f({ from: '2027-03-01', to: '2027-03-31' })).matches)).toEqual([]);
    expect(ids(filterProjects(items, f({ from: '2027-04-15' })).matches)).toEqual(['b']);
    expect(ids(filterProjects(items, f({ to: '2027-02-05' })).matches)).toEqual(['a']);
    // text: trimmed, case-insensitive, over title, description and tags
    expect(ids(filterProjects(items, f({ text: '  billing ' })).matches)).toEqual(['a']);
    expect(ids(filterProjects(items, f({ text: 'text INDEX' })).matches)).toEqual(['b']);
    expect(ids(filterProjects(items, f({ text: 'Q3' })).matches)).toEqual(['a']);
    expect(ids(filterProjects(items, f({ text: '   ' })).matches)).toEqual(['a', 'b', 'c', 'root']);
    // combined: AND across fields
    expect(ids(filterProjects(items, f({ tags: ['money'], statuses: ['in_progress'] })).matches)).toEqual(['a']);
    expect(ids(filterProjects(items, f({ tags: ['money'], assigneeIds: ['u2'] })).matches)).toEqual([]);
  });

  test('filterProjects treats an item with one date as a single day, and archived items match only with showArchived', () => {
    const start = make('s', { startDate: '2027-05-10' });
    const end = make('e', { endDate: '2027-05-20' });
    const both = [start, end];
    expect(ids(filterProjects(both, f({ from: '2027-05-10', to: '2027-05-10' })).matches)).toEqual(['s']);
    expect(ids(filterProjects(both, f({ from: '2027-05-11', to: '2027-05-30' })).matches)).toEqual(['e']);
    expect(ids(filterProjects(items, f({ statuses: ['done'] })).matches)).toEqual([]);
    expect(ids(filterProjects(items, f({ statuses: ['done'], showArchived: true })).matches)).toEqual(['d']);
    expect(ids(filterProjects(items, f({ assigneeIds: ['u1'], showArchived: true })).matches)).toEqual(['a', 'd']);
  });

  test('filterProjects returns the ancestors of a match as context and never as matches', () => {
    const r = filterProjects(items, f({ text: 'invoices' }));
    expect(ids(r.matches)).toEqual(['c']);
    expect(ids(r.context)).toEqual(['a', 'root']);
    // an ancestor that is itself a match is not context
    const r2 = filterProjects(items, f({ tags: ['money'] }));
    expect(ids(r2.matches)).toEqual(['a', 'c']);
    expect(ids(r2.context)).toEqual(['root']);
    // no filter: nothing is context
    expect(filterProjects(items, NO_FILTERS).context.size).toBe(0);
    // archived ancestors are never context unless archived items are shown
    const arch = make('arch', { archived: true });
    const kid = child('kid', arch, { title: 'needle' });
    expect(filterProjects([arch, kid], f({ text: 'needle' })).context.size).toBe(0);
    expect(ids(filterProjects([arch, kid], f({ text: 'needle', showArchived: true })).context)).toEqual(['arch']);
    // an ancestor missing from the input is skipped
    const lost = make('lost', { title: 'needle', parentId: 'gone', depth: 2, path: ['gone'] });
    expect(filterProjects([lost], f({ text: 'needle' })).context.size).toBe(0);
  });

  test('buildTree and filterProjects handle 2,000 items spread over four levels', () => {
    const big: Project[] = [];
    let level: Project[] = [make('p0')];
    big.push(...level);
    // 1 + 99 + 900 + 1000 = 2,000
    const sizes = [99, 900, 1000];
    for (const size of sizes) {
      const next: Project[] = [];
      for (let i = 0; i < size; i++) {
        const parent = level[i % level.length]!;
        next.push(child(`n${big.length + i}`, parent, { title: `item ${big.length + i}` }));
      }
      big.push(...next);
      level = next;
    }
    expect(big).toHaveLength(2000);
    expect(Math.max(...big.map((i) => i.depth))).toBe(4);
    const r = filterProjects(big, f({ text: 'item 19' }));
    const tree = buildTree(big);
    expect(tree).toHaveLength(1);
    expect(r.matches.size).toBeGreaterThan(0);
    for (const id of r.matches) expect(big.find((i) => i.id === id)!.title).toContain('item 19');
  });
});

describe('activeFilterCount', () => {
  test('activeFilterCount counts each filtered field once and ignores text and showArchived', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount(f({ text: 'x', showArchived: true }))).toBe(0);
    expect(activeFilterCount(f({ statuses: ['done', 'blocked'] }))).toBe(1);
    expect(activeFilterCount(f({ assigneeIds: ['u'], tags: ['t'], labels: ['none'] }))).toBe(3);
    expect(activeFilterCount(f({ from: '2027-01-01' }))).toBe(1);
    expect(activeFilterCount(f({ from: '2027-01-01', to: '2027-02-01', statuses: ['done'] }))).toBe(2);
  });
});

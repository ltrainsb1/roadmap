import type { Project, ProjectStatus, ProjectWarning } from '@roadmap/shared';

const STATUS_NAMES: Record<ProjectStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const statusName = (status: ProjectStatus): string => STATUS_NAMES[status];

const LEVEL_NAMES = ['Project', 'Sub-project', 'Task', 'Sub-task'] as const;

/** The name of a level: 1 is a Project, 4 a Sub-task. */
export const levelName = (depth: number): string => LEVEL_NAMES[depth - 1] ?? 'Item';

const LEVEL_PLURALS = ['Projects', 'Sub-projects', 'Tasks', 'Sub-tasks'] as const;

/** The name of a level in the plural, as the Board's "Level" control offers it: 1 is Projects, 4 Sub-tasks. */
export const levelPlural = (depth: number): string => LEVEL_PLURALS[depth - 1] ?? 'Items';

/** How many cards a column holds: "1 item", "3 items". */
export const itemCount = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;

/** The menu item that adds an item under one at `depth`; null at the deepest level. */
export const addChildLabel = (depth: number): string | null => {
  const child = LEVEL_NAMES[depth];
  return child ? `Add ${child.toLowerCase()}` : null;
};

const dayFormat = (withYear: boolean) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' as const }), timeZone: 'UTC' });
const WITH_YEAR = dayFormat(true);
const WITHOUT_YEAR = dayFormat(false);

const parse = (date: string): Date => new Date(`${date}T00:00:00Z`);

/** One calendar date (`YYYY-MM-DD`) as "3 Mar 2027". */
export const formatDay = (date: string): string => WITH_YEAR.format(parse(date));

/** A milestone as "Milestone: Beta, 3 Mar 2027". */
export const formatMilestone = (m: { name: string; date: string }): string => `Milestone: ${m.name}, ${formatDay(m.date)}`;

/** Start and end dates (`YYYY-MM-DD` or null) as one phrase: "3 Mar to 28 Apr 2027", "From 3 Mar 2027", "Until 28 Apr 2027", "No dates". */
export function formatDates(start: string | null, end: string | null): string {
  if (start && end) {
    const first = start.slice(0, 4) === end.slice(0, 4) ? WITHOUT_YEAR : WITH_YEAR;
    return `${first.format(parse(start))} to ${WITH_YEAR.format(parse(end))}`;
  }
  if (start) return `From ${WITH_YEAR.format(parse(start))}`;
  if (end) return `Until ${WITH_YEAR.format(parse(end))}`;
  return 'No dates';
}

/** The sentence for one warning, naming the other item by its title. */
export function warningText(warning: ProjectWarning, byId: ReadonlyMap<string, Project>): string {
  if (warning.kind === 'outside_parent') return `Dates fall outside ${byId.get(warning.parentId)?.title ?? 'the parent'}'s dates.`;
  return `Starts before ${byId.get(warning.blockerId)?.title ?? 'a blocker'} ends.`;
}

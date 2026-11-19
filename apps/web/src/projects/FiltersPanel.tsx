import { PRIORITY_LABELS, PROJECT_STATUSES, type ProjectFilters } from '@roadmap/shared';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { ME } from './filters.ts';
import { statusName } from './names.ts';

export const FILTERS_PANEL_ID = 'filters-panel';

interface Option {
  value: string;
  label: string;
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="panel-group">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

function Checks({ name, options, selected, onChange }: { name: string; options: Option[]; selected: readonly string[]; onChange: (next: string[]) => void }) {
  return options.map((o) => {
    const id = `filter-${name}-${o.value}`;
    return (
      <div className="check" key={o.value}>
        <input
          id={id}
          type="checkbox"
          checked={selected.includes(o.value)}
          onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
        />
        <label htmlFor={id}>{o.label}</label>
      </div>
    );
  });
}

interface Props {
  open: boolean;
  filters: ProjectFilters;
  onChange: (next: ProjectFilters) => void;
  onClear: () => void;
  onDone: () => void;
  /** Tags on the roadmap's items that are not archived. */
  tagsInUse: readonly string[];
  members: ReadonlyArray<{ userId: string; name: string }>;
  /** Whether `members` is the real list: until it is, an id with no member is not yet known to be a former one. */
  membersLoaded: boolean;
  myId: string;
}

/** The ids in `chosen` that are not among `known`: still in the address, so they stay in the list to be unticked. */
const leftovers = (chosen: readonly string[], known: readonly string[]) => chosen.filter((v) => !known.includes(v));

/** A disclosure under the toolbar, not a dialog: the list stays in view and in reach while a filter is changed. */
export function FiltersPanel({ open, filters, onChange, onClear, onDone, tagsInUse, members, membersLoaded, myId }: Props) {
  const set = (change: Partial<ProjectFilters>) => onChange({ ...filters, ...change });

  const tagValues = [...new Set([...tagsInUse, ...filters.tags])].sort();
  // Ticking someone writes their id; "Assigned to me" writes "me". A link that names the reader by id still shows them by name.
  const others = members.filter((m) => m.userId !== myId || filters.assigneeIds.includes(myId));
  const gone = membersLoaded ? leftovers(filters.assigneeIds, [ME, ...members.map((m) => m.userId)]) : [];
  const assigneeOptions: Option[] = [
    { value: ME, label: 'Assigned to me' },
    ...others.map((m) => ({ value: m.userId, label: m.name })),
    ...gone.map((id) => ({ value: id, label: 'Former member' })),
  ];

  return (
    <section id={FILTERS_PANEL_ID} className="filters-panel" aria-labelledby="filters-heading" hidden={!open}>
      <h2 id="filters-heading">Filters</h2>
      <div className="filters-groups">
        <Group legend="Status">
          <Checks
            name="status"
            options={PROJECT_STATUSES.map((s) => ({ value: s, label: statusName(s) }))}
            selected={filters.statuses}
            onChange={(next) => set({ statuses: PROJECT_STATUSES.filter((s) => next.includes(s)) })}
          />
        </Group>
        <Group legend="Assignee">
          <Checks name="assignee" options={assigneeOptions} selected={filters.assigneeIds} onChange={(assigneeIds) => set({ assigneeIds })} />
        </Group>
        <Group legend="Tag">
          {tagValues.length === 0 && <p className="hint">No tags yet.</p>}
          <Checks name="tag" options={tagValues.map((t) => ({ value: t, label: t }))} selected={filters.tags} onChange={(tags) => set({ tags })} />
        </Group>
        <Group legend="Priority label">
          <Checks
            name="label"
            options={[...PRIORITY_LABELS.map((l) => ({ value: l, label: l })), { value: 'none', label: 'None' }]}
            selected={filters.labels}
            onChange={(next) => set({ labels: [...PRIORITY_LABELS, 'none' as const].filter((l) => next.includes(l)) })}
          />
        </Group>
      </div>
      <div className="filters-dates">
        <Field id="filter-from" label="From" type="date" value={filters.from ?? ''} max={filters.to ?? undefined} onChange={(e) => set({ from: e.target.value || null })} />
        <Field id="filter-to" label="To" type="date" value={filters.to ?? ''} min={filters.from ?? undefined} onChange={(e) => set({ to: e.target.value || null })} />
      </div>
      <div className="check">
        <input id="filter-archived" type="checkbox" checked={filters.showArchived} onChange={(e) => set({ showArchived: e.target.checked })} />
        <label htmlFor="filter-archived">Show archived</label>
      </div>
      <div className="filters-actions">
        <Button onClick={onClear}>Clear filters</Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </section>
  );
}

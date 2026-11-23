import { buildTree, formatDates, type SnapshotContent, type SnapshotItem, type TreeNode } from '@roadmap/shared';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Chevron } from '../projects/itemParts.tsx';
import { levelName, statusName } from '../projects/names.ts';
import { hasDetails, SnapshotItemDetails } from './SnapshotItemDetails.tsx';

/** Adds `id` to the set if it is not there, takes it out if it is. */
export const toggled = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

export const detailsId = (itemId: string): string => `details-${itemId}`;

/** An item's priority as the app's List writes it: its place among its siblings, then its label. */
export const priorityText = (position: number, label: string | null): string => (label ? `${position} · ${label}` : String(position));

export const NO_ITEMS = 'This snapshot has no items.';

/** The branches collapsed in a snapshot, shared by its List and Timeline so a switch between them keeps them. */
export interface Branches {
  collapsed: ReadonlySet<string>;
  toggle: (itemId: string) => void;
}

/**
 * A snapshot as a table, nested and collapsible as the app's List. An item's title opens its details in a row under
 * it. Nothing can be changed.
 */
export function SnapshotList({ linkId, content, branches }: { linkId: string; content: SnapshotContent; branches: Branches }) {
  const { collapsed } = branches;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const byId = useMemo(() => new Map(content.items.map((i) => [i.id, i])), [content.items]);
  const tree = useMemo(() => buildTree(content.items), [content.items]);
  if (content.items.length === 0) return <p>{NO_ITEMS}</p>;

  const withNames = content.include.assignees;
  const columns = withNames ? 5 : 4;

  const renderNode = ({ item, children, position }: TreeNode<SnapshotItem>): ReactNode => {
    const showChildren = !collapsed.has(item.id);
    const showDetails = open.has(item.id);
    const names = item.assignees ?? [];
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}${showDetails ? ' details-open' : ''}`}>
          <th scope="row" className="name-cell">
            <div className="name">
              {children.length > 0 ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${showChildren ? 'Collapse' : 'Expand'} ${item.title}`}
                  onClick={() => branches.toggle(item.id)}
                >
                  <Chevron open={showChildren} />
                </button>
              ) : (
                <span className="chevron-space" aria-hidden="true" />
              )}
              <span className="sr-only">{levelName(item.depth)}: </span>
              {hasDetails(item, content.include, byId) ? (
                <button
                  type="button"
                  className="item-title snapshot-title"
                  aria-label={`Details for ${item.title}`}
                  aria-expanded={showDetails}
                  aria-controls={showDetails ? detailsId(item.id) : undefined}
                  onClick={() => setOpen((o) => toggled(o, item.id))}
                >
                  {item.title}
                </button>
              ) : (
                <span className="item-title">{item.title}</span>
              )}
            </div>
          </th>
          <td data-label="Status">{statusName(item.status)}</td>
          <td data-label="Dates">{formatDates(item.startDate, item.endDate)}</td>
          <td data-label="Priority">{priorityText(position, item.priorityLabel)}</td>
          {withNames && <td data-label="Assigned to">{names.length > 0 ? names.join(', ') : 'Unassigned'}</td>}
        </tr>
        {showDetails && (
          <tr className={`details-row depth-${item.depth}`}>
            <td id={detailsId(item.id)} colSpan={columns}>
              <SnapshotItemDetails linkId={linkId} item={item} include={content.include} byId={byId} />
            </td>
          </tr>
        )}
        {showChildren && children.map(renderNode)}
      </Fragment>
    );
  };

  return (
    <table className="tree snapshot-list" aria-label="List">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Dates</th>
          <th scope="col">Priority</th>
          {withNames && <th scope="col">Assigned to</th>}
        </tr>
      </thead>
      <tbody>{tree.map(renderNode)}</tbody>
    </table>
  );
}

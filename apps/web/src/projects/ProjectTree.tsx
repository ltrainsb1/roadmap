import { buildTree, can, projectWarnings, type Project, type Role, type TreeNode } from '@roadmap/shared';
import { Fragment, useCallback, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, type MenuItem } from '../ui/Menu.tsx';
import { AddItemRow } from './AddItemRow.tsx';
import { addChildLabel, formatDates, levelName, statusName, warningText } from './names.ts';

/** Where the add row is open: under `parentId`, or at the top level when null. */
export interface AddTarget {
  parentId: string | null;
}

export const NEW_PROJECT_BUTTON_ID = 'new-project-button';
export const actionsButtonId = (itemId: string) => `actions-${itemId}`;

const collapsedKey = (roadmapId: string) => `roadmap:${roadmapId}:collapsed`;

const readCollapsed = (roadmapId: string): Set<string> => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(collapsedKey(roadmapId)) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

/** The ids of collapsed items for one roadmap, kept in `sessionStorage` so a reload keeps them. */
export function useCollapsed(roadmapId: string) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(roadmapId));
  const update = useCallback(
    (change: (ids: Set<string>) => void) =>
      setCollapsed((current) => {
        const next = new Set(current);
        change(next);
        try {
          sessionStorage.setItem(collapsedKey(roadmapId), JSON.stringify([...next]));
        } catch {
          // Storage is a convenience; the tree still works without it.
        }
        return next;
      }),
    [roadmapId],
  );
  const toggle = useCallback((id: string) => update((ids) => void (ids.delete(id) || ids.add(id))), [update]);
  const expand = useCallback((id: string) => update((ids) => void ids.delete(id)), [update]);
  return { collapsed, toggle, expand };
}

function WarningIcon({ texts }: { texts: string[] }) {
  return (
    <span className="warning" title={texts.join(' ')}>
      <svg viewBox="0 0 16 16" width="18" height="18" role="img" aria-label="Has warnings">
        <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.5v3.5M8 11.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" className={open ? 'chevron open' : 'chevron'}>
      <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface TreeProps {
  roadmapId: string;
  role: Role;
  /** The signed-in person, to decide where a Contributor may add. */
  myId: string | undefined;
  /** The items to show: the page decides which (for now, the ones that are not archived). */
  items: readonly Project[];
  byId: ReadonlyMap<string, Project>;
  /** Member names by user id. */
  memberNames: ReadonlyMap<string, string>;
  selectedId: string | undefined;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  adding: AddTarget | null;
  onStartAdd: (parentId: string) => void;
  onAdd: (parentId: string | null, title: string) => Promise<unknown>;
  onCancelAdd: () => void;
}

export function ProjectTree(props: TreeProps) {
  const { roadmapId, role, myId, items, byId, memberNames, selectedId, collapsed, onToggle, adding, onStartAdd, onAdd, onCancelAdd } = props;
  const navigate = useNavigate();
  const tree = buildTree(items);

  const isAssigned = (item: Project): boolean =>
    myId !== undefined && [item, ...item.path.map((id) => byId.get(id))].some((i) => i?.assigneeIds.includes(myId));

  const menuItems = (item: Project): MenuItem[] => {
    const entries: MenuItem[] = [{ label: 'Open', onSelect: () => void navigate(`/r/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(item.id)}`) }];
    const add = addChildLabel(item.depth);
    if (add && can({ role, action: 'project.create', ctx: { isAssigned: isAssigned(item) } })) {
      entries.push({ label: add, onSelect: () => onStartAdd(item.id) });
    }
    return entries;
  };

  const addRow = (parentId: string | null, depth: number): ReactNode =>
    adding?.parentId === parentId && (
      <AddItemRow key={`add-${parentId ?? 'top'}`} depth={depth} onAdd={(title) => onAdd(parentId, title)} onCancel={onCancelAdd} />
    );

  const renderNode = ({ item, children, position }: TreeNode): ReactNode => {
    const hasChildren = children.length > 0;
    const open = !collapsed.has(item.id);
    const warnings = projectWarnings(item, byId).map((w) => warningText(w, byId));
    const names = item.assigneeIds.map((id) => memberNames.get(id)).filter((n): n is string => n !== undefined);
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}${item.id === selectedId ? ' selected' : ''}`}>
          <th scope="row" className="name-cell">
            <div className="name">
              {hasChildren ? (
                <button type="button" className="icon-btn" aria-label={`${open ? 'Collapse' : 'Expand'} ${item.title}`} onClick={() => onToggle(item.id)}>
                  <Chevron open={open} />
                </button>
              ) : (
                <span className="chevron-space" aria-hidden="true" />
              )}
              <span className="sr-only">{levelName(item.depth)}: </span>
              <Link to={`/r/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(item.id)}`} className="item-title">
                {item.title}
              </Link>
              {warnings.length > 0 && <WarningIcon texts={warnings} />}
            </div>
          </th>
          <td className="status-cell">
            <span className="pill">{statusName(item.status)}</span>
          </td>
          <td className="wide-cell">{names.length > 0 ? names.join(', ') : 'Unassigned'}</td>
          <td className="wide-cell">{formatDates(item.startDate, item.endDate)}</td>
          <td className="wide-cell">{item.priorityLabel ? `${position} · ${item.priorityLabel}` : position}</td>
          <td className="actions-cell">
            <Menu label={`Actions for ${item.title}`} buttonId={actionsButtonId(item.id)} items={menuItems(item)} />
          </td>
        </tr>
        {open && children.map(renderNode)}
        {addRow(item.id, item.depth + 1)}
      </Fragment>
    );
  };

  return (
    <table className="tree" aria-label="Projects">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col" className="wide-cell">
            Assignees
          </th>
          <th scope="col" className="wide-cell">
            Dates
          </th>
          <th scope="col" className="wide-cell">
            Priority
          </th>
          <th scope="col" className="actions-cell">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tree.map(renderNode)}
        {addRow(null, 1)}
      </tbody>
    </table>
  );
}

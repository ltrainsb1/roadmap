import { buildTree, can, projectWarnings, type Project, type ProjectStatus, type Role, type TreeNode } from '@roadmap/shared';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Menu, type MenuItem } from '../ui/Menu.tsx';
import { AddItemRow } from './AddItemRow.tsx';
import { StatusMenu } from './StatusMenu.tsx';
import { isAssigned } from './useProjects.ts';
import { addChildLabel, formatDates, levelName, warningText } from './names.ts';

/** Where the add row is open: under `parentId`, or at the top level when null. */
export interface AddTarget {
  parentId: string | null;
}

export const NEW_PROJECT_BUTTON_ID = 'new-project-button';
export const actionsButtonId = (itemId: string) => `actions-${itemId}`;
export const titleLinkId = (itemId: string) => `title-${itemId}`;

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

const TOP_GROUP = 'top';

/** The siblings an item is sorted among: a drop is only ever valid inside its own group. */
const groupOf = (entry: { data: { current?: { sortable?: { containerId?: unknown } } } } | null | undefined) =>
  entry?.data.current?.sortable?.containerId;

const sameGroupOnly: CollisionDetection = (args) => {
  const group = groupOf(args.active);
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => groupOf(c) === group) });
};

/**
 * Keyboard moves look only at rows of the group the picked-up row belongs to. This relies on the shape of dnd-kit's
 * `droppableContainers` (`get` and `getEnabled`, each entry carrying `data.current.sortable.containerId`), which is
 * not public API: re-check it whenever @dnd-kit/core or @dnd-kit/sortable is upgraded.
 */
const sameGroupKeyboard: KeyboardCoordinateGetter = (event, args) => {
  const { context } = args;
  const group = groupOf(context.active);
  const containers = context.droppableContainers;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: {
      ...context,
      droppableContainers: {
        get: (id: string | number) => containers.get(id),
        getEnabled: () => containers.getEnabled().filter((c) => groupOf(c) === group),
      } as typeof containers,
    },
  });
};

const dragHandleIcon = (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <circle cx="5.5" cy="4" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="4" r="1.25" fill="currentColor" />
    <circle cx="5.5" cy="8" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="8" r="1.25" fill="currentColor" />
    <circle cx="5.5" cy="12" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="12" r="1.25" fill="currentColor" />
  </svg>
);

interface SortableRowProps {
  id: string;
  title: string;
  className: string;
  /** Whether this row can be dragged: the person may set priority. */
  draggable: boolean;
  /** Gets the drag handle, or null when the row cannot be dragged, to put in the row's last cell. */
  children: (handle: ReactNode) => ReactNode;
}

/** A table row that can be picked up by its handle. The handle is the only part that starts a drag. */
function SortableRow({ id, title, className, draggable, children }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !draggable });
  const handle = draggable ? (
    <button ref={setActivatorNodeRef} type="button" className="icon-btn drag-handle" aria-label={`Reorder ${title}`} {...attributes} {...listeners}>
      {dragHandleIcon}
    </button>
  ) : null;
  return (
    <tr
      ref={setNodeRef}
      className={isDragging ? `${className} dragging` : className}
      // Set through the DOM's style API by React, which the page's style policy allows.
      style={{ transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined, transition }}
    >
      {children(handle)}
    </tr>
  );
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
  /** The items to show: the page decides which (the matches and their ancestors while filtering). */
  items: readonly Project[];
  /** Items shown only because something under them matches: greyed, and not a place to add under. */
  contextIds?: ReadonlySet<string>;
  /** Every shown item is open, whatever was collapsed: a filter must not hide a match. The collapsed state is left as it was. */
  expandAll?: boolean;
  /** False while filtering or showing archived items: a reorder sends a whole sibling group, and the list holds part of it. */
  reorderable?: boolean;
  /** The query string to keep when opening an item, with its leading "?" or empty. */
  search?: string;
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
  /** Saves a new status for the item; the page shows any error. */
  onChangeStatus: (item: Project, status: ProjectStatus) => unknown;
  /** Opens an item's panel; the page may ask about unsaved edits first. */
  onOpen: (itemId: string) => void;
  /**
   * Saves the order of the non-archived items under `parentId` (null for the top level); the page shows any error.
   * `announce` is said once the order is saved (a drag announces through dnd-kit instead).
   */
  onReorder: (parentId: string | null, orderedIds: string[], announce?: string) => void;
  /** The page asks about unsaved edits, then archives, unarchives or asks to delete. */
  onArchive: (item: Project) => void;
  onUnarchive: (item: Project) => void;
  onDelete: (item: Project) => void;
}

export function ProjectTree(props: TreeProps) {
  const { roadmapId, role, myId, items, contextIds, expandAll = false, reorderable = true, search = '', byId, memberNames, selectedId, collapsed, onToggle, adding, onStartAdd, onAdd, onCancelAdd, onChangeStatus, onOpen, onReorder, onArchive, onUnarchive, onDelete } = props;
  const tree = buildTree(items);
  const canReorder = reorderable && can({ role, action: 'project.setPriority' });
  // The row being dragged shows without its children, so it moves as one line.
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sameGroupKeyboard }),
  );

  const titleOf = (id: string | number) => byId.get(String(id))?.title ?? 'item';
  const placeOf = (entry: { data: { current?: { sortable?: { index: number; items: unknown[] } } } } | null) => {
    const sortable = entry?.data.current?.sortable;
    return sortable ? { n: sortable.index + 1, total: sortable.items.length } : null;
  };
  // The first "over" comes with the pick-up and is the row's own place; it would replace "Picked up".
  const moved = useRef(false);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      moved.current = false;
      return `Picked up ${titleOf(active.id)}.`;
    },
    onDragOver: ({ active, over }) => {
      if (over && over.id !== active.id) moved.current = true;
      if (!moved.current) return undefined;
      const place = placeOf(over);
      return place ? `Moved ${titleOf(active.id)} to position ${place.n} of ${place.total}.` : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const place = placeOf(over);
      return place ? `Dropped ${titleOf(active.id)} at position ${place.n} of ${place.total}.` : undefined;
    },
    onDragCancel: () => 'Reordering cancelled.',
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const from = active.data.current?.sortable as { containerId: string; index: number; items: string[] } | undefined;
    const to = over?.data.current?.sortable as { containerId: string; index: number } | undefined;
    if (!from || !to || from.containerId !== to.containerId || from.index === to.index) return;
    onReorder(from.containerId === TOP_GROUP ? null : from.containerId, arrayMove(from.items, from.index, to.index));
  };

  const menuItems = (item: Project, group: TreeNode[]): MenuItem[] => {
    const entries: MenuItem[] = [{ label: 'Open', onSelect: () => onOpen(item.id) }];
    const add = addChildLabel(item.depth);
    if (!item.archived && !contextIds?.has(item.id) && add && can({ role, action: 'project.create', ctx: { isAssigned: isAssigned(item, myId, byId) } })) {
      entries.push({ label: add, onSelect: () => onStartAdd(item.id) });
    }
    if (!item.archived && canReorder) {
      const ids = group.filter((n) => !n.item.archived).map((n) => n.item.id);
      const at = ids.indexOf(item.id);
      const move = (by: number) => () =>
        onReorder(item.parentId, arrayMove(ids, at, at + by), `Moved ${item.title} to position ${at + by + 1} of ${ids.length}.`);
      entries.push({ label: 'Move up', onSelect: move(-1), disabled: at <= 0 }, { label: 'Move down', onSelect: move(1), disabled: at >= ids.length - 1 });
    }
    if (can({ role, action: 'project.delete', ctx: { isAssigned: isAssigned(item, myId, byId) } })) {
      entries.push(
        item.archived ? { label: 'Unarchive', onSelect: () => onUnarchive(item) } : { label: 'Archive', onSelect: () => onArchive(item) },
        { label: 'Delete', onSelect: () => onDelete(item) },
      );
    }
    return entries;
  };

  const addRow = (parentId: string | null, depth: number): ReactNode =>
    adding?.parentId === parentId && (
      <AddItemRow key={`add-${parentId ?? 'top'}`} depth={depth} onAdd={(title) => onAdd(parentId, title)} onCancel={onCancelAdd} />
    );

  /** One sibling group: rows can be reordered among themselves and nowhere else. */
  const renderGroup = (parentId: string | null, nodes: TreeNode[]): ReactNode => (
    <SortableContext id={parentId ?? TOP_GROUP} items={nodes.filter((n) => !n.item.archived).map((n) => n.item.id)} strategy={verticalListSortingStrategy}>
      {nodes.map((node) => renderNode(node, nodes))}
    </SortableContext>
  );

  const renderNode = ({ item, children, position }: TreeNode, group: TreeNode[]): ReactNode => {
    const hasChildren = children.length > 0;
    const open = expandAll || (!collapsed.has(item.id) && dragging !== item.id);
    const context = contextIds?.has(item.id) === true;
    const warnings = projectWarnings(item, byId).map((w) => warningText(w, byId));
    const names = item.assigneeIds.map((id) => memberNames.get(id)).filter((n): n is string => n !== undefined);
    return (
      <Fragment key={item.id}>
        <SortableRow
          id={item.id}
          title={item.title}
          draggable={canReorder && !item.archived}
          className={`depth-${item.depth}${item.id === selectedId ? ' selected' : ''}${context ? ' context' : ''}`}
        >
          {(handle) => (
            <>
          <th scope="row" className="name-cell">
            <div className="name">
              {hasChildren && !expandAll ? (
                <button type="button" className="icon-btn" aria-label={`${open ? 'Collapse' : 'Expand'} ${item.title}`} onClick={() => onToggle(item.id)}>
                  <Chevron open={open} />
                </button>
              ) : (
                <span className="chevron-space" aria-hidden="true" />
              )}
              <span className="sr-only">{levelName(item.depth)}: </span>
              <Link id={titleLinkId(item.id)} to={`/r/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(item.id)}${search}`} className="item-title"
                aria-current={item.id === selectedId ? 'true' : undefined}
                onClick={(e) => {
                  // Plain clicks go through the page; a new-tab click keeps its default.
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  onOpen(item.id);
                }}
              >
                {item.title}
              </Link>
              {item.archived && <span className="badge">Archived</span>}
              {context && <span className="sr-only">Shown for context</span>}
              {warnings.length > 0 && <WarningIcon texts={warnings} />}
            </div>
          </th>
          <td className="status-cell">
            <StatusMenu
              item={item}
              editable={!item.archived && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } })}
              onChange={(status) => onChangeStatus(item, status)}
            />
          </td>
          <td className="wide-cell">{names.length > 0 ? names.join(', ') : 'Unassigned'}</td>
          <td className="wide-cell">{formatDates(item.startDate, item.endDate)}</td>
          <td className="wide-cell">{item.priorityLabel ? `${position} · ${item.priorityLabel}` : position}</td>
          <td className="actions-cell">
            <div className="row-actions">
              {handle}
              <Menu label={`Actions for ${item.title}`} buttonId={actionsButtonId(item.id)} items={menuItems(item, group)} />
            </div>
          </td>
            </>
          )}
        </SortableRow>
        {open && children.length > 0 && renderGroup(item.id, children)}
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
      <DndContext
        sensors={sensors}
        collisionDetection={sameGroupOnly}
        accessibility={{
          // Outside the table: dnd-kit's instructions and live region are divs, which a <table> may not hold.
          container: document.body,
          announcements,
          screenReaderInstructions: {
            draggable: 'To reorder, press Space. Move with the arrow keys, then press Space to drop. Press Escape to cancel.',
          },
        }}
        onDragStart={({ active }: DragStartEvent) => setDragging(String(active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <tbody>
          {renderGroup(null, tree)}
          {addRow(null, 1)}
        </tbody>
      </DndContext>
    </table>
  );
}

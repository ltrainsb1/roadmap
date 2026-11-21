import { can, filterProjects, PROJECT_STATUSES, treeOrder, type Project, type ProjectFilters, type ProjectStatus, type Role } from '@roadmap/shared';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/Button.tsx';
import { BoardCard } from './BoardCard.tsx';
import { hasNarrowing, type ViewOptions } from './filters.ts';
import { dragHandleIcon, titleLinkId } from './itemParts.tsx';
import { itemCount, levelPlural, statusName } from './names.ts';
import { statusButtonId } from './StatusMenu.tsx';
import type { ItemActions } from './useItemActions.tsx';
import { isAssigned } from './useProjects.ts';
import { viewPath } from './ViewSwitcher.tsx';

/**
 * dnd-kit's pointer sensor, for a mouse or a pen only. A finger is left to the TouchSensor, so a touch drag starts
 * with its long press; otherwise this sensor would take the touch's pointer events first and start after 5 px.
 */
class MouseAndPenSensor extends PointerSensor {
  static override activators = PointerSensor.activators.map((activator) => ({
    ...activator,
    handler: (...args: Parameters<typeof activator.handler>) =>
      args[0].nativeEvent.pointerType !== 'touch' && activator.handler(...args),
  }));
}

/**
 * Holding a card near the board's left or right edge scrolls the board sideways. Only the board scrolls this way, not
 * the page: a card is dropped anywhere over a column and the columns are as tall as the board, which never scrolls
 * up or down itself, so there is nothing to reach by scrolling vertically. (dnd-kit 6 has no switch for one axis;
 * `canScroll` picks the elements.) The edge zone is a tenth of the board's width, not the default fifth: at 375 px
 * the next column shows only about 50 px at the edge, and the default zone covered all of it, scrolling the board
 * past that column before the card could be dropped there.
 */
const AUTO_SCROLL = {
  threshold: { x: 0.1, y: 0.2 },
  canScroll: (element: Element) => element.classList.contains('board'),
};

const isStatus = (id: UniqueIdentifier | undefined): id is ProjectStatus => (PROJECT_STATUSES as readonly unknown[]).includes(id);

/**
 * Moves cards between columns. A moved card shows in its new column at once, while its save runs, and follows its
 * item again once the save settles: by then the item has the saved status, or, when the save was refused, the
 * refetched one. `beforeChange` is told just before the card is shown in its new column and again just before it
 * follows its item, which puts it back when the save was refused.
 */
export function useBoardMoves(
  actions: Pick<ItemActions, 'changeStatus'>,
  beforeChange: (item: Project) => void = () => undefined,
): {
  statusOf(item: Project): ProjectStatus;
  move(item: Project, status: ProjectStatus): void;
} {
  // The status each card is shown with while its move is being saved.
  const [pending, setPending] = useState<ReadonlyMap<string, ProjectStatus>>(new Map());
  const moves = useRef(0);
  // The latest move of each card, so an earlier move settling does not undo a later one.
  const latest = useRef(new Map<string, number>());
  const statusOf = (item: Project) => pending.get(item.id) ?? item.status;
  const move = (item: Project, status: ProjectStatus) => {
    if (status === statusOf(item)) return;
    const n = (moves.current += 1);
    latest.current.set(item.id, n);
    beforeChange(item);
    setPending((p) => new Map(p).set(item.id, status));
    const settle = () => {
      if (latest.current.get(item.id) !== n) return;
      latest.current.delete(item.id);
      beforeChange(item);
      setPending((p) => {
        const next = new Map(p);
        next.delete(item.id);
        return next;
      });
    };
    void actions.changeStatus(item, status).then(settle, settle);
  };
  return { statusOf, move };
}

interface BoardViewProps {
  role: Role;
  myId: string | undefined;
  /** Every item of the roadmap: the Board picks the ones at its level. */
  items: readonly Project[];
  /** The filters, with "Assigned to me" already turned into the person's id. */
  filters: ProjectFilters;
  level: ViewOptions['level'];
  byId: ReadonlyMap<string, Project>;
  memberNames: ReadonlyMap<string, string>;
  selectedId: string | undefined;
  roadmapId: string;
  /** The query string to keep when opening an item, with its leading "?" or empty. */
  search: string;
  actions: ItemActions;
  /** Clears the search and filters, from the message shown when they match no card. */
  onClearFilters: () => void;
}

/** A column: the place a card is dropped to take that status. */
function Column({ status, count, children }: { status: ProjectStatus; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const name = statusName(status);
  return (
    <section ref={setNodeRef} className={isOver ? 'board-column over' : 'board-column'} aria-label={`${name}, ${itemCount(count)}`}>
      <h2 className="column-heading">
        {name}
        <span className="sr-only">, </span>
        <span className="column-count">{itemCount(count)}</span>
      </h2>
      {children}
    </section>
  );
}

type CardProps = Omit<Parameters<typeof BoardCard>[0], 'handle' | 'dragging' | 'ref'> & { movable: boolean };

/**
 * A card with its drag handle, when it may be moved. Only the handle starts a drag. The handle is left out of the tab
 * order: the Board has no keyboard drag, and the card's status menu is the keyboard path.
 */
function MovableCard({ movable, ...props }: CardProps) {
  const { item } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { status: item.status },
    disabled: !movable,
    attributes: { tabIndex: -1 },
  });
  const handle = movable ? (
    <button ref={setActivatorNodeRef} type="button" className="icon-btn drag-handle" aria-label={`Move ${item.title}`} {...attributes} {...listeners}>
      {dragHandleIcon}
    </button>
  ) : null;
  return <BoardCard {...props} ref={setNodeRef} handle={handle} dragging={isDragging} />;
}

/** The items at one level as cards, in one column per status, each column in the List's order. */
export function BoardView({ role, myId, items, filters, level, byId, memberNames, selectedId, roadmapId, search, actions, onClearFilters }: BoardViewProps) {
  // A card that changes column is a new element there, so focus inside it would fall to the page. The card that held
  // focus when it moved (the status menu hands focus back to its button before the move; a drag by the mouse leaves it
  // on the handle) gets it back on its status menu, or on its title once it may no longer be changed, after it renders.
  // Only when focus was in fact lost: a card that stayed in its column keeps focus wherever it is.
  const refocus = useRef<string | null>(null);
  const keepFocus = (item: Project) => {
    const card = document.getElementById(titleLinkId(item.id))?.closest('.card');
    if (card?.contains(document.activeElement)) refocus.current = item.id;
  };
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const target = document.getElementById(statusButtonId(id)) ?? document.getElementById(titleLinkId(id));
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (target && lost) target.focus();
  });
  const moves = useBoardMoves(actions, keepFocus);
  // The card being dragged, for the copy of it that follows the pointer.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseAndPenSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const atLevel = useMemo(
    () => items.filter((i) => i.depth === level && (filters.showArchived || !i.archived)),
    [items, level, filters.showArchived],
  );
  const cards = useMemo(() => {
    const matches = hasNarrowing(filters) ? filterProjects(items, filters).matches : null;
    const order = treeOrder(items);
    const at = (i: Project) => order.get(i.id) ?? Number.MAX_SAFE_INTEGER;
    return atLevel.filter((i) => matches === null || matches.has(i.id)).sort((a, b) => at(a) - at(b));
  }, [atLevel, items, filters]);

  // Whether the card has left its own column yet: the first "over" is that column, and saying so would replace "Picked up".
  const moved = useRef(false);
  const titleOf = (id: UniqueIdentifier) => byId.get(String(id))?.title ?? 'item';
  const fromOf = (active: { data: { current?: { status?: unknown } } }) => active.data.current?.status;
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      moved.current = false;
      return `Picked up ${titleOf(active.id)}.`;
    },
    onDragOver: ({ active, over }) => {
      if (over && over.id !== fromOf(active)) moved.current = true;
      if (!moved.current || !isStatus(over?.id)) return undefined;
      return `${titleOf(active.id)} is over ${statusName(over.id)}.`;
    },
    onDragEnd: ({ active, over }) =>
      isStatus(over?.id) && over.id !== fromOf(active) ? `Moved ${titleOf(active.id)} to ${statusName(over.id)}.` : 'Move cancelled.',
    onDragCancel: () => 'Move cancelled.',
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingId(null);
    const item = byId.get(String(active.id));
    // Dropped outside any column, or on its own: `move` leaves a card alone when its status would not change.
    if (item && isStatus(over?.id)) moves.move(item, over.id);
  };

  if (atLevel.length === 0) return <p>{`No ${levelPlural(level).toLowerCase()} yet.`}</p>;
  if (cards.length === 0) {
    return (
      <>
        <p>No projects match these filters.</p>
        <Button onClick={onClearFilters}>Clear filters</Button>
      </>
    );
  }

  const base = viewPath(roadmapId, 'board');
  const dragged = draggingId === null ? undefined : byId.get(draggingId);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      autoScroll={AUTO_SCROLL}
      accessibility={{
        container: document.body,
        announcements,
        screenReaderInstructions: { draggable: 'Drag this card to another column, or use its status menu.' },
      }}
      onDragStart={({ active }) => setDraggingId(String(active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      <div className="board" role="region" aria-label="Board" tabIndex={0}>
        {PROJECT_STATUSES.map((status) => {
          const inColumn = cards.filter((i) => moves.statusOf(i) === status);
          return (
            <Column key={status} status={status} count={inColumn.length}>
              {inColumn.length === 0 ? (
                <p className="column-empty">No items</p>
              ) : (
                <ul className="cards">
                  {inColumn.map((item) => {
                    const editable = !item.archived && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } });
                    return (
                      <MovableCard
                        key={item.id}
                        // Shown with the status it is moving to, while that is being saved.
                        item={{ ...item, status }}
                        parentTitle={item.parentId === null ? undefined : byId.get(item.parentId)?.title}
                        assigneeNames={item.assigneeIds.map((id) => memberNames.get(id)).filter((n): n is string => n !== undefined)}
                        editable={editable}
                        movable={editable}
                        selected={item.id === selectedId}
                        href={`${base}/${encodeURIComponent(item.id)}${search}`}
                        onOpen={() => actions.openItem(item.id)}
                        onChangeStatus={(next) => moves.move(item, next)}
                        menu={actions.menuFor(item)}
                      />
                    );
                  })}
                </ul>
              )}
            </Column>
          );
        })}
      </div>
      {/* The copy of the card that follows the pointer; the card itself stays in its column until it is dropped. */}
      <DragOverlay dropAnimation={null}>
        {dragged && (
          <div className="card drag-overlay" aria-hidden="true">
            <p className="card-title">
              <span className="item-title">{dragged.title}</span>
            </p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

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
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/Button.tsx';
import { BoardCard } from './BoardCard.tsx';
import { hasNarrowing, type ViewOptions } from './filters.ts';
import { itemCount, levelPlural, statusName } from './names.ts';
import { dragHandleIcon } from './ProjectTree.tsx';
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

const isStatus = (id: UniqueIdentifier | undefined): id is ProjectStatus => (PROJECT_STATUSES as readonly unknown[]).includes(id);

/**
 * Moves cards between columns. A moved card shows in its new column at once, while its save runs, and follows its
 * item again once the save settles: by then the item has the saved status, or, when the save was refused, the
 * refetched one.
 */
export function useBoardMoves(actions: Pick<ItemActions, 'changeStatus'>): {
  statusOf(item: Project): ProjectStatus;
  move(item: Project, status: ProjectStatus): void;
} {
  // The status each card is shown with while its move is being saved, and which move that was, so an earlier move
  // settling does not undo a later one.
  const [pending, setPending] = useState<ReadonlyMap<string, { status: ProjectStatus; n: number }>>(new Map());
  const moves = useRef(0);
  const statusOf = (item: Project) => pending.get(item.id)?.status ?? item.status;
  const move = (item: Project, status: ProjectStatus) => {
    if (status === statusOf(item)) return;
    const n = (moves.current += 1);
    setPending((p) => new Map(p).set(item.id, { status, n }));
    const settle = () =>
      setPending((p) => {
        if (p.get(item.id)?.n !== n) return p;
        const next = new Map(p);
        next.delete(item.id);
        return next;
      });
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

/** A card with its drag handle, when it may be moved. Only the handle starts a drag. */
function MovableCard({ movable, ...props }: CardProps) {
  const { item } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { status: item.status },
    disabled: !movable,
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
  const moves = useBoardMoves(actions);
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
      // A card is dropped anywhere over a column, so only sideways scrolling helps, and its edge zone is kept narrow:
      // at 375 px the next column shows only about 50 px at the board's edge, and the default zone would cover all of
      // it and scroll the board past that column before the card could be dropped there.
      autoScroll={{ threshold: { x: 0.1, y: 0 } }}
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

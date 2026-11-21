import { can, filterProjects, PROJECT_STATUSES, treeOrder, type Project, type ProjectFilters, type Role } from '@roadmap/shared';
import { useMemo } from 'react';
import { BoardCard } from './BoardCard.tsx';
import { hasNarrowing, type ViewOptions } from './filters.ts';
import { itemCount, levelPlural, statusName } from './names.ts';
import type { ItemActions } from './useItemActions.tsx';
import { isAssigned } from './useProjects.ts';
import { viewPath } from './ViewSwitcher.tsx';

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
}

/** The items at one level as cards, in one column per status, each column in the List's order. */
export function BoardView({ role, myId, items, filters, level, byId, memberNames, selectedId, roadmapId, search, actions }: BoardViewProps) {
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

  if (atLevel.length === 0) return <p>{`No ${levelPlural(level).toLowerCase()} yet.`}</p>;

  const base = viewPath(roadmapId, 'board');
  return (
    <div className="board" role="region" aria-label="Board" tabIndex={0}>
      {PROJECT_STATUSES.map((status) => {
        const inColumn = cards.filter((i) => i.status === status);
        const name = statusName(status);
        return (
          <section key={status} className="board-column" aria-label={`${name}, ${itemCount(inColumn.length)}`}>
            <h2 className="column-heading">
              {name}
              <span className="sr-only">, </span>
              <span className="column-count">{itemCount(inColumn.length)}</span>
            </h2>
            {inColumn.length === 0 ? (
              <p className="column-empty">No items</p>
            ) : (
              <ul className="cards">
                {inColumn.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    parentTitle={item.parentId === null ? undefined : byId.get(item.parentId)?.title}
                    assigneeNames={item.assigneeIds.map((id) => memberNames.get(id)).filter((n): n is string => n !== undefined)}
                    editable={!item.archived && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } })}
                    selected={item.id === selectedId}
                    href={`${base}/${encodeURIComponent(item.id)}${search}`}
                    onOpen={() => actions.openItem(item.id)}
                    onChangeStatus={(next) => void actions.changeStatus(item, next)}
                    menu={actions.menuFor(item)}
                    handle={null}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

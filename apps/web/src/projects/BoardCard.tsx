import type { Project, ProjectStatus } from '@roadmap/shared';
import type { ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';
import { isPlainClick } from '../ui/isPlainClick.ts';
import { Menu, type MenuItem } from '../ui/Menu.tsx';
import { formatDates, levelName } from './names.ts';
import { actionsButtonId, titleLinkId } from './ProjectTree.tsx';
import { StatusMenu } from './StatusMenu.tsx';

interface BoardCardProps {
  item: Project;
  /** The title of the item this one belongs to; undefined on the Projects level. */
  parentTitle: string | undefined;
  assigneeNames: string[];
  /** Whether the person may change this item's status here. */
  editable: boolean;
  selected: boolean;
  /** Where the title link goes: the Board with this item's panel open. */
  href: string;
  onOpen: () => void;
  onChangeStatus: (status: ProjectStatus) => void;
  menu: MenuItem[];
  /** The drag handle, or null when the card can't be dragged. */
  handle: ReactNode;
  /** Whether the card is the one being dragged: its copy follows the pointer and this one stays, outlined. */
  dragging?: boolean;
  ref?: Ref<HTMLLIElement>;
}

/**
 * One item on the Board: its title on a line of its own, then its parent, assignees, dates and badges, then a row with
 * the drag handle, the status and the Actions menu.
 */
export function BoardCard({ item, parentTitle, assigneeNames, editable, selected, href, onOpen, onChangeStatus, menu, handle, dragging = false, ref }: BoardCardProps) {
  return (
    <li ref={ref} className={`card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}>
      <p className="card-title">
        <span className="sr-only">{levelName(item.depth)}: </span>
        <Link
          id={titleLinkId(item.id)}
          to={href}
          className="item-title"
          aria-current={selected ? 'true' : undefined}
          onClick={(e) => {
            // Plain clicks go through the page; a new-tab click keeps its default.
            if (!isPlainClick(e)) return;
            e.preventDefault();
            onOpen();
          }}
        >
          {item.title}
        </Link>
      </p>
      {parentTitle !== undefined && <p className="card-parent">In {parentTitle}</p>}
      <p className="card-meta">
        <span>{assigneeNames.length > 0 ? assigneeNames.join(', ') : 'Unassigned'}</span>
        <span>{formatDates(item.startDate, item.endDate)}</span>
      </p>
      {(item.priorityLabel || item.archived) && (
        <p className="card-badges">
          {item.priorityLabel && <span className="badge">{item.priorityLabel}</span>}
          {item.archived && <span className="badge">Archived</span>}
        </p>
      )}
      <div className="card-foot">
        {handle}
        <span className="card-status">
          <StatusMenu item={item} editable={editable} onChange={onChangeStatus} />
        </span>
        <span className="card-actions">
          <Menu label={`Actions for ${item.title}`} buttonId={actionsButtonId(item.id)} items={menu} />
        </span>
      </div>
    </li>
  );
}

import {
  barFor,
  buildTree,
  can,
  projectWarnings,
  timelineRange,
  xOf,
  type Project,
  type Role,
  type TimelineRange,
  type TimelineZoom,
  type TreeNode,
} from '@roadmap/shared';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isPlainClick } from '../ui/isPlainClick.ts';
import { Menu } from '../ui/Menu.tsx';
import { formatDates, formatMilestone, levelName, warningText } from './names.ts';
import { actionsButtonId, Chevron, titleLinkId, WarningIcon } from './ProjectTree.tsx';
import { StatusMenu } from './StatusMenu.tsx';
import { TimelineAxis } from './TimelineAxis.tsx';
import type { ItemActions } from './useItemActions.tsx';
import { isAssigned } from './useProjects.ts';
import { viewPath } from './ViewSwitcher.tsx';

interface TimelineViewProps {
  roadmapId: string;
  role: Role;
  myId: string | undefined;
  /** The items to show: the page decides which (the matches and their ancestors while filtering). */
  items: readonly Project[];
  /** Items shown only because something under them matches: greyed. */
  contextIds: ReadonlySet<string>;
  /** Every shown item is open, whatever was collapsed: a filter must not hide a match. */
  expandAll: boolean;
  byId: ReadonlyMap<string, Project>;
  /** `YYYY-MM-DD` in the signed-in person's time zone. */
  today: string;
  zoom: TimelineZoom;
  selectedId: string | undefined;
  /** Shared with the List. */
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** The query string to keep when opening an item, with its leading "?" or empty. */
  search: string;
  actions: ItemActions;
}

/** One item's schedule: its bar, its dates and milestones in words, and the today line. */
function Track({ item, range, today }: { item: Project; range: TimelineRange; today: string }) {
  const bar = barFor(item, range);
  const dates = formatDates(item.startDate, item.endDate);
  return (
    <div className="track" style={{ width: range.width }}>
      {bar && <span className={`bar status-${item.status} kind-${bar.kind}`} style={{ left: bar.left, width: bar.width }} />}
      <span className={bar ? 'sr-only' : 'no-dates'}>{dates}</span>
      {item.milestones.map((m) => (
        <span key={m.id} className="milestone" style={{ left: xOf(m.date, range) }}>
          <span className="sr-only">{formatMilestone(m)}</span>
        </span>
      ))}
      <span className="today-line" aria-hidden="true" style={{ left: xOf(today, range) }} />
    </div>
  );
}

/**
 * The items as a table: names at the left, nested and collapsible as in the List, and each item's schedule at the
 * right. View only: dates are edited in the panel.
 */
export function TimelineView(props: TimelineViewProps) {
  const { roadmapId, role, myId, items, contextIds, expandAll, byId, today, zoom, selectedId, collapsed, onToggle, search, actions } = props;
  const range = timelineRange(items, today, zoom);
  const base = viewPath(roadmapId, 'timeline');

  const renderNode = ({ item, children }: TreeNode): ReactNode => {
    const hasChildren = children.length > 0;
    const open = expandAll || !collapsed.has(item.id);
    const context = contextIds.has(item.id);
    const warnings = projectWarnings(item, byId).map((w) => warningText(w, byId));
    const editable = !item.archived && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } });
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}${item.id === selectedId ? ' selected' : ''}${context ? ' context' : ''}`}>
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
              <Link
                id={titleLinkId(item.id)}
                to={`${base}/${encodeURIComponent(item.id)}${search}`}
                className="item-title"
                aria-current={item.id === selectedId ? 'true' : undefined}
                onClick={(e) => {
                  // Plain clicks go through the page; a new-tab click keeps its default.
                  if (!isPlainClick(e)) return;
                  e.preventDefault();
                  actions.openItem(item.id);
                }}
              >
                {item.title}
              </Link>
              {item.archived && <span className="badge">Archived</span>}
              {context && <span className="sr-only">Shown for context</span>}
              {warnings.length > 0 && <WarningIcon texts={warnings} />}
              <StatusMenu item={item} editable={editable} onChange={(status) => void actions.changeStatus(item, status)} />
              <Menu label={`Actions for ${item.title}`} buttonId={actionsButtonId(item.id)} items={actions.menuFor(item)} />
            </div>
          </th>
          <td className="track-cell">
            <Track item={item} range={range} today={today} />
          </td>
        </tr>
        {open && children.map(renderNode)}
      </Fragment>
    );
  };

  return (
    <div className="timeline-frame">
      <table className="timeline" aria-label="Timeline">
        <TimelineAxis range={range} zoom={zoom} today={today} />
        <tbody>{buildTree(items).map(renderNode)}</tbody>
      </table>
    </div>
  );
}

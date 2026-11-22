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
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { Menu } from '../ui/Menu.tsx';
import { actionsButtonId, NameCell } from './itemParts.tsx';
import { formatDates, formatMilestone, statusName, warningText } from './names.ts';
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
  /** Each change scrolls the schedule so today is a third of the way in; it also happens once on first render. */
  scrollToTodaySignal: number;
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
  const { roadmapId, role, myId, items, contextIds, expandAll, byId, today, zoom, selectedId, collapsed, onToggle, search, actions, scrollToTodaySignal } =
    props;
  const range = timelineRange(items, today, zoom);
  const base = viewPath(roadmapId, 'timeline');
  const frame = useRef<HTMLDivElement>(null);
  const todayX = xOf(today, range);

  // Today goes a third of the way across the part of the frame the name column leaves free.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const names = el.querySelector<HTMLElement>('.name-col')?.offsetWidth ?? 0;
    el.scrollLeft = todayX - (el.clientWidth - names) / 3;
    // On first render, when asked, and on a new zoom, where the old scroll offset means nothing. A filter change keeps
    // the person's own scroll.
  }, [scrollToTodaySignal, zoom]);

  const renderNode = ({ item, children }: TreeNode): ReactNode => {
    const hasChildren = children.length > 0;
    const open = expandAll || !collapsed.has(item.id);
    const context = contextIds.has(item.id);
    const warnings = projectWarnings(item, byId).map((w) => warningText(w, byId));
    const editable = !item.archived && can({ role, action: 'project.edit', ctx: { isAssigned: isAssigned(item, myId, byId) } });
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}${item.id === selectedId ? ' selected' : ''}${context ? ' context' : ''}`}>
          <NameCell
            item={item}
            hasChildren={hasChildren}
            expandAll={expandAll}
            open={open}
            onToggle={() => onToggle(item.id)}
            href={`${base}/${encodeURIComponent(item.id)}${search}`}
            selected={item.id === selectedId}
            onOpen={() => actions.openItem(item.id)}
            context={context}
            warnings={warnings}
          >
            {/* Below 600 px the pill is hidden, and this says the status instead; from 600 px it is not shown at all. */}
            <span className="narrow-status">{statusName(item.status)}</span>
            <StatusMenu item={item} editable={editable} onChange={(status) => void actions.changeStatus(item, status)} />
            <Menu label={`Actions for ${item.title}`} buttonId={actionsButtonId(item.id)} items={actions.menuFor(item)} />
          </NameCell>
          <td className="track-cell">
            <Track item={item} range={range} today={today} />
          </td>
        </tr>
        {open && children.map(renderNode)}
      </Fragment>
    );
  };

  return (
    // One scroll container for the header and every row, so they move together; the name column is sticky inside it.
    <div ref={frame} className="timeline-frame" role="region" aria-label="Schedule, scrolls sideways" tabIndex={0}>
      <table className="timeline" aria-label="Timeline">
        <TimelineAxis range={range} zoom={zoom} today={today} />
        <tbody>{buildTree(items).map(renderNode)}</tbody>
      </table>
    </div>
  );
}

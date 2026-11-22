import { buildTree, TIMELINE_ZOOMS, timelineRange, xOf, type SnapshotContent, type SnapshotItem, type TimelineZoom, type TreeNode } from '@roadmap/shared';
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_OPTIONS, viewOptionsFromSearch } from '../projects/filters.ts';
import { Chevron } from '../projects/itemParts.tsx';
import { levelName, statusName, ZOOM_NAMES } from '../projects/names.ts';
import { TimelineAxis } from '../projects/TimelineAxis.tsx';
import { Track } from '../projects/timelineParts.tsx';
import { SelectField } from '../ui/SelectField.tsx';
import { NO_ITEMS, type Branches } from './SnapshotList.tsx';

/**
 * A snapshot as the app's Timeline without its controls: the names, the axis, the bars and milestones, and a Zoom
 * select. The line the app draws at today sits on the "as of" date.
 */
export function SnapshotTimeline({ content, branches }: { content: SnapshotContent; branches: Branches }) {
  const [params, setParams] = useSearchParams();
  const { zoom } = viewOptionsFromSearch(params);
  const { collapsed } = branches;
  const frame = useRef<HTMLDivElement>(null);
  const { items, asOf } = content;
  const range = useMemo(() => timelineRange(items, asOf, zoom), [items, asOf, zoom]);
  const markerX = xOf(asOf, range);

  // The as-of date goes a third of the way across the part of the frame the name column leaves free, on first render
  // and on a new zoom, as the app's Timeline does with today.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const names = el.querySelector<HTMLElement>('.name-col')?.offsetWidth ?? 0;
    el.scrollLeft = markerX - (el.clientWidth - names) / 3;
    // Only a new zoom moves the schedule, where the old scroll offset means nothing.
  }, [zoom]);

  if (items.length === 0) return <p>{NO_ITEMS}</p>;

  const setZoom = (next: TimelineZoom) =>
    setParams(
      (current) => {
        const p = new URLSearchParams(current);
        if (next === DEFAULT_OPTIONS.zoom) p.delete('zoom');
        else p.set('zoom', next);
        return p;
      },
      { replace: true },
    );

  const renderNode = ({ item, children }: TreeNode<SnapshotItem>): ReactNode => {
    const open = !collapsed.has(item.id);
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}`}>
          <th scope="row" className="name-cell">
            <div className="name">
              {children.length > 0 ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${item.title}`}
                  onClick={() => branches.toggle(item.id)}
                >
                  <Chevron open={open} />
                </button>
              ) : (
                <span className="chevron-space" aria-hidden="true" />
              )}
              <span className="sr-only">{levelName(item.depth)}: </span>
              <span className="item-title">{item.title}</span>
              {/* Below 600 px the pill is hidden and this says the status; from 600 px the pill says it. */}
              <span className="narrow-status">{statusName(item.status)}</span>
              <span className="pill">{statusName(item.status)}</span>
            </div>
          </th>
          <td className="track-cell">
            <Track item={item} range={range} today={asOf} />
          </td>
        </tr>
        {open && children.map(renderNode)}
      </Fragment>
    );
  };

  return (
    <>
      <div className="toolbar-zoom snapshot-zoom">
        <SelectField id="snapshot-zoom" label="Zoom" value={zoom} onChange={(e) => setZoom(e.target.value as TimelineZoom)}>
          {TIMELINE_ZOOMS.map((z) => (
            <option key={z} value={z}>
              {ZOOM_NAMES[z]}
            </option>
          ))}
        </SelectField>
      </div>
      {/* One scroll container for the header and every row, so they move together; the name column is sticky inside it. */}
      <div ref={frame} className="timeline-frame" role="region" aria-label="Schedule, scrolls sideways" tabIndex={0}>
        <table className="timeline" aria-label="Timeline">
          <TimelineAxis range={range} zoom={zoom} today={asOf} markerLabel="As of" />
          <tbody>{buildTree(items).map(renderNode)}</tbody>
        </table>
      </div>
    </>
  );
}

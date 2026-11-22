import { buildTree, fitTimeline, type SnapshotContent, type SnapshotItem, type SnapshotNote, type SnapshotView, type TreeNode } from '@roadmap/shared';
import { Fragment, useEffect, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { formatDates, formatDay, levelName, statusName } from '../projects/names.ts';
import { TimelineAxis } from '../projects/TimelineAxis.tsx';
import { Track } from '../projects/timelineParts.tsx';
import { hasDetails, SnapshotItemDetails } from './SnapshotItemDetails.tsx';
import { NO_ITEMS, priorityText } from './SnapshotList.tsx';
import { useDocumentTitle, useSnapshotContent } from './useSnapshot.ts';

/**
 * The pages the PDF service prints (`/s/:linkId/print/list` and `/s/:linkId/print/timeline`). The service opens them
 * with a render token, which opens the content call and nothing else: so no password page, no status check and no
 * per-item notes here, just one content call. The page tells the service it can print by setting `data-print` on
 * <html> to "ready" once the content is on the page, or "error" when it could not load; it supplies the left part of
 * each page's footer in <meta name="pdf-footer">, and the service adds the page numbers.
 */

/** Pixels left for the schedule on A4 landscape (12 mm margins) beside a 240 px name column. */
export const PRINT_TIMELINE_WIDTH = 760;

/** A PDF has no viewer whose zone to use: its note times are UTC, and the list PDF with notes says so. */
export const UTC_NOTE = 'Times are in UTC.';

type PrintState = 'ready' | 'error';

/** Sets `data-print` on <html> while mounted; the PDF service waits for it. */
function usePrintState(state: PrintState | undefined) {
  useEffect(() => {
    if (state === undefined) return;
    const root = document.documentElement;
    root.dataset.print = state;
    return () => {
      delete root.dataset.print;
    };
  }, [state]);
}

/** Puts <meta name="pdf-footer" content={text}> in the head while mounted. */
function useFooter(text: string | undefined) {
  useEffect(() => {
    if (text === undefined) return;
    const meta = document.createElement('meta');
    meta.name = 'pdf-footer';
    meta.content = text;
    document.head.append(meta);
    return () => meta.remove();
  }, [text]);
}

/** The list with every branch and every item's details open, its notes written out, and nothing to press. */
function PrintList({ linkId, content }: { linkId: string; content: SnapshotContent }) {
  const byId = useMemo(() => new Map(content.items.map((i) => [i.id, i])), [content.items]);
  const tree = useMemo(() => buildTree(content.items), [content.items]);
  const notesOf = useMemo(() => {
    const map = new Map<string, SnapshotNote[]>();
    for (const n of content.notes ?? []) map.set(n.itemId, [...(map.get(n.itemId) ?? []), n]);
    return map;
  }, [content.notes]);
  if (content.items.length === 0) return <p>{NO_ITEMS}</p>;

  const withNames = content.include.assignees;
  const columns = withNames ? 5 : 4;
  // Without notes nothing is written for an item's notes, so an item with nothing else has no details row.
  const noNotes = { ...content.include, notes: false };

  const renderNode = ({ item, children, position }: TreeNode<SnapshotItem>): ReactNode => {
    const notes = content.include.notes ? (notesOf.get(item.id) ?? []) : [];
    const showDetails = hasDetails(item, noNotes, byId) || notes.length > 0;
    const names = item.assignees ?? [];
    return (
      <Fragment key={item.id}>
        <tr className={`depth-${item.depth}${showDetails ? ' details-open' : ''}`}>
          <th scope="row" className="name-cell">
            <div className="name">
              <span className="sr-only">{levelName(item.depth)}: </span>
              <span className="item-title">{item.title}</span>
            </div>
          </th>
          <td>{statusName(item.status)}</td>
          <td>{formatDates(item.startDate, item.endDate)}</td>
          <td>{priorityText(position, item.priorityLabel)}</td>
          {withNames && <td>{names.length > 0 ? names.join(', ') : 'Unassigned'}</td>}
        </tr>
        {showDetails && (
          <tr className={`details-row depth-${item.depth}`}>
            <td colSpan={columns}>
              <SnapshotItemDetails linkId={linkId} item={item} include={content.include} byId={byId} print={{ notes }} />
            </td>
          </tr>
        )}
        {children.map(renderNode)}
      </Fragment>
    );
  };

  return (
    <table className="tree print-list" aria-label="List">
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

/** The timeline with every branch open, scaled so the whole range fits the page's width. */
function PrintTimeline({ content }: { content: SnapshotContent }) {
  const { items, asOf } = content;
  const { range, zoom } = useMemo(() => fitTimeline(items, asOf, PRINT_TIMELINE_WIDTH), [items, asOf]);
  if (items.length === 0) return <p>{NO_ITEMS}</p>;

  const renderNode = ({ item, children }: TreeNode<SnapshotItem>): ReactNode => (
    <Fragment key={item.id}>
      <tr className={`depth-${item.depth}`}>
        <th scope="row" className="name-cell">
          <div className="name">
            <span className="sr-only">{levelName(item.depth)}: </span>
            <span className="item-title">{item.title}</span>
            <span className="print-status">{statusName(item.status)}</span>
          </div>
        </th>
        <td className="track-cell">
          <Track item={item} range={range} today={asOf} />
        </td>
      </tr>
      {children.map(renderNode)}
    </Fragment>
  );

  return (
    <table className="timeline print-timeline" aria-label="Timeline">
      <TimelineAxis range={range} zoom={zoom} today={asOf} markerLabel="As of" />
      <tbody>{buildTree(items).map(renderNode)}</tbody>
    </table>
  );
}

/** `/s/:linkId/print/list` and `/s/:linkId/print/timeline`: what the PDF service turns into a snapshot's PDF. */
export function PrintPage({ view }: { view: SnapshotView }) {
  const { linkId = '' } = useParams();
  // The list writes out every note, so it asks for them with the content; the timeline shows none.
  const content = useSnapshotContent(linkId, { allNotes: view === 'list' });
  const data = content.data;
  const asOf = data && `As of ${formatDay(data.asOf)}`;
  useDocumentTitle(data && `${data.roadmapName}: snapshot`);
  // The footer goes in before the page says it is ready: effects run in order, after the content is on the page.
  useFooter(data && `${data.roadmapName} · ${asOf}`);
  usePrintState(content.isSuccess ? 'ready' : content.isError ? 'error' : undefined);

  if (!data) return null;
  return (
    <div className="print-page">
      <header className="snapshot-heading">
        <h1>{data.roadmapName}</h1>
        <p className="snapshot-as-of">{asOf}</p>
        {view === 'list' && data.include.notes && <p className="print-note">{UTC_NOTE}</p>}
      </header>
      <main>{view === 'list' ? <PrintList linkId={linkId} content={data} /> : <PrintTimeline content={data} />}</main>
    </div>
  );
}

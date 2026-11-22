import { barFor, xOf, type Project, type TimelineRange } from '@roadmap/shared';
import { formatDates, formatMilestone } from './names.ts';

/** Pieces of a Timeline row that the app's Timeline and a snapshot's both draw. */

interface TrackProps {
  item: Pick<Project, 'status' | 'startDate' | 'endDate' | 'milestones'>;
  range: TimelineRange;
  /** Where the marker line goes: today in the app, the "as of" date in a snapshot. */
  today: string;
}

/** One item's schedule: its bar, its dates and milestones in words, and the marker line. */
export function Track({ item, range, today }: TrackProps) {
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

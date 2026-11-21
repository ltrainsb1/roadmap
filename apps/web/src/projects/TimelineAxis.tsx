import { timelineTicks, xOf, type TimelineRange, type TimelineTick, type TimelineZoom } from '@roadmap/shared';

function TickRow({ ticks, className }: { ticks: TimelineTick[]; className: string }) {
  return (
    <div className={className}>
      {/* A week cut by the range start has no label: nothing is drawn for it. */}
      {ticks
        .filter((tick) => tick.label !== '')
        .map((tick) => (
          <span key={tick.date} className="tick" style={{ left: tick.left, width: tick.width }}>
            {tick.label}
          </span>
        ))}
    </div>
  );
}

/**
 * The Timeline's header row: "Name", then the dates over the schedule. Only the two column headings reach assistive
 * technology; every row says its own dates in words.
 */
export function TimelineAxis({ range, zoom, today }: { range: TimelineRange; zoom: TimelineZoom; today: string }) {
  const { major, minor } = timelineTicks(range, zoom);
  return (
    <thead>
      <tr>
        <th scope="col" className="name-col">
          Name
        </th>
        <th scope="col" className="schedule-col">
          <span className="sr-only">Schedule</span>
          <div className="axis" aria-hidden="true" style={{ width: range.width }}>
            <TickRow ticks={major} className="axis-major" />
            {minor.length > 0 && <TickRow ticks={minor} className="axis-minor" />}
            <span className="today-label" style={{ left: xOf(today, range) }}>
              Today
            </span>
          </div>
        </th>
      </tr>
    </thead>
  );
}

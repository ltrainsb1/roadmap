/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a `YYYY-MM-DD` day starts in `timeZone`. */
function startOfDay(day: string, timeZone: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  // Two passes settle the offset when the day's start sits next to a clock change.
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

/** The first and last millisecond of a `YYYY-MM-DD` day in `timeZone`, as ISO strings for the audit query. */
export function dayRange(day: string, timeZone: string): { from: string; to: string } {
  const start = startOfDay(day, timeZone);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { from: new Date(start).toISOString(), to: new Date(startOfDay(next, timeZone) - 1).toISOString() };
}

/** An audit timestamp as a person reads it, in their own time zone. */
export function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

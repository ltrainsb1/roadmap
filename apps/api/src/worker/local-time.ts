// Calendar dates and hours in a person's own time zone. A zone this runtime doesn't know counts as UTC, so one bad
// `UserDoc.timezone` never stops a worker pass.

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' } as const;
    try {
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    formats.set(timeZone, f);
  }
  return f;
}

function partsAt(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = formatFor(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) % 24 };
}

/** The calendar date (`YYYY-MM-DD`) it is in `timeZone` at `at`. */
export function localDate(at: Date, timeZone: string): string {
  return partsAt(at, timeZone).date;
}

/** The hour (0–23) it is in `timeZone` at `at`. */
export function localHour(at: Date, timeZone: string): number {
  return partsAt(at, timeZone).hour;
}

/** `date` (`YYYY-MM-DD`) moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

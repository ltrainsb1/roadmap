const formatFor = (timeZone: string): Intl.DateTimeFormat => {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch (error) {
    // A zone this browser does not know: UTC is better than no Timeline.
    if (error instanceof RangeError) return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    throw error;
  }
};

/** The calendar date (`YYYY-MM-DD`) it is in `timeZone` at `now`, or in UTC if the zone is unknown. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = formatFor(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

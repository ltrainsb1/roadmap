import { formatDayUtc } from '@roadmap/shared';

// A notification's time as "3 Sep 2026 at 14:05" in the person's zone: the day spelled as everywhere else (fixed month
// names, not the browser's locale) and a 24-hour clock.

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
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

/** `iso` as "{day} at {HH:MM}" in `timeZone`; a zone this browser doesn't know counts as UTC. */
export function formatNotificationTime(iso: string, timeZone: string): string {
  const parts = formatFor(timeZone).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = String(Number(part('hour')) % 24).padStart(2, '0');
  return `${formatDayUtc(`${part('year')}-${part('month')}-${part('day')}`)} at ${hour}:${part('minute')}`;
}

import type { ProjectDoc } from "../db/types.ts";

/** Escapes untrusted text as iCalendar TEXT (RFC 5545 3.3.11): backslash, semicolon, comma, and line breaks as \n. */
export function icsEscape(text: string): string {
  return text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, "\\n");
}

const MAX_OCTETS = 75;

/**
 * Folds a content line at 75 octets (RFC 5545 3.1): each continuation line starts with one space, which counts
 * toward that line's 75. Splits only between code points, so a UTF-8 character is never cut.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    // The first line holds 75 octets; later lines hold 74 after their leading space.
    const room = parts.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    if (octets + size > room) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export interface IcsEvent {
  uid: string;
  summary: string;
  /** YYYY-MM-DD. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
  sequence: number;
  stamp: Date;
  url: string;
}

type CalendarItem = Pick<
  ProjectDoc,
  | "_id"
  | "roadmapId"
  | "title"
  | "startDate"
  | "endDate"
  | "milestones"
  | "version"
  | "updatedAt"
>;

/**
 * The events an item shows (FR-4.3): one all-day event for its dates (start to end, or the one date it has), and one
 * one-day event per milestone. UIDs depend only on ids and the app's host, so they stay the same across fetches, the
 * feed and the single-item download.
 */
export function eventsFor(
  item: CalendarItem,
  opts: { origin: string; itemDates: boolean; milestones: boolean },
): IcsEvent[] {
  const origin = opts.origin.replace(/\/+$/, "");
  const host = new URL(origin).host;
  const url = `${origin}/r/${item.roadmapId}/projects/${item._id}`;
  const common = { sequence: item.version, stamp: item.updatedAt, url };
  const events: IcsEvent[] = [];
  if (opts.itemDates) {
    const start = item.startDate ?? item.endDate;
    const end = item.endDate ?? item.startDate;
    if (start && end)
      events.push({
        uid: `item-${item._id}@${host}`,
        summary: item.title,
        start,
        end,
        ...common,
      });
  }
  if (opts.milestones) {
    for (const m of item.milestones) {
      events.push({
        uid: `milestone-${m.id}@${host}`,
        summary: `${m.name} · ${item.title}`,
        start: m.date,
        end: m.date,
        ...common,
      });
    }
  }
  return events;
}

/** YYYYMMDD from YYYY-MM-DD. */
function icsDate(day: string): string {
  return day.replaceAll("-", "");
}

/** The day after a YYYY-MM-DD date, as YYYYMMDD: DTEND of an all-day event is exclusive. */
function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return icsDate(d.toISOString().slice(0, 10));
}

/** UTC date-time as YYYYMMDDTHHMMSSZ. */
function icsStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}/, "")
    .replace(/[-:]/g, "");
}

function eventLines(e: IcsEvent): string[] {
  const stamp = icsStamp(e.stamp);
  return [
    "BEGIN:VEVENT",
    `UID:${icsEscape(e.uid)}`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTART;VALUE=DATE:${icsDate(e.start)}`,
    `DTEND;VALUE=DATE:${dayAfter(e.end)}`,
    `SUMMARY:${icsEscape(e.summary)}`,
    `URL:${e.url}`,
    `DESCRIPTION:${icsEscape(`Open in Roadmap: ${e.url}`)}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/** A whole VCALENDAR, every line folded, CRLF line ends throughout (FR-4.1). */
export function icsCalendar(opts: {
  name: string;
  events: IcsEvent[];
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Roadmap//Calendar feed//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(opts.name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...opts.events.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

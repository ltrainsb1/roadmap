import ICAL from "ical.js";
import { describe, expect, test } from "vitest";
import {
  eventsFor,
  foldLine,
  icsCalendar,
  icsEscape,
  type IcsEvent,
} from "../../src/calendar/ics.ts";

const origin = "https://roadmap.example.com";
const on = { origin, itemDates: true, milestones: true };

function item(
  over: Partial<Parameters<typeof eventsFor>[0]> = {},
): Parameters<typeof eventsFor>[0] {
  return {
    _id: "p1",
    roadmapId: "r1",
    title: "Launch site",
    startDate: "2026-03-02",
    endDate: "2026-03-06",
    milestones: [],
    version: 4,
    updatedAt: new Date("2026-02-01T09:08:07.123Z"),
    ...over,
  };
}

// ical.js doesn't know X-WR-CALNAME; calendar apps read it as TEXT, so the test does too.
(ICAL.design.defaultSet.property as Record<string, { defaultType: string }>)[
  "x-wr-calname"
] = { defaultType: "text" };

/** Parses a calendar back with ical.js and returns the calendar and its events. */
function parse(ics: string): { cal: ICAL.Component; events: ICAL.Component[] } {
  const cal = new ICAL.Component(ICAL.parse(ics) as unknown[]);
  return { cal, events: cal.getAllSubcomponents("vevent") };
}

function one(events: IcsEvent[]): ICAL.Component {
  const parsed = parse(icsCalendar({ name: "Roadmap dates", events })).events;
  expect(parsed).toHaveLength(1);
  return parsed[0]!;
}

function dateOf(ev: ICAL.Component, prop: string): string {
  const v = ev.getFirstPropertyValue(prop) as ICAL.Time;
  expect(v.isDate).toBe(true);
  return v.toString();
}

describe("icsEscape and foldLine", () => {
  test("FR-4.1: escape backslash, semicolon, comma and every kind of line break", () => {
    expect(icsEscape("a\\b;c,d\r\ne\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
  });

  test("FR-4.1: other line breaks become \\n, and every other control character but tab is dropped", () => {
    expect(icsEscape("a\vb\fc\u0085d\u2028e\u2029f")).toBe("a\\nb\\nc\\nd\\ne\\nf");
    expect(icsEscape("a\u0000b\u0007c\u001bd\u007fe\u009bf\tg")).toBe("abcdef\tg");
  });

  test("FR-4.1: a line of 75 octets or fewer is left alone; longer ones fold with CRLF and a space", () => {
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    const folded = foldLine("x".repeat(200));
    const parts = folded.split("\r\n");
    expect(parts.map((p) => Buffer.byteLength(p))).toEqual([75, 75, 52]);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(
      "x".repeat(200),
    );
  });

  test("FR-4.1: folding never splits a UTF-8 character", () => {
    const line = "SUMMARY:" + "ab" + "😀".repeat(40);
    const parts = foldLine(line).split("\r\n");
    for (const p of parts) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(75);
      expect(p).not.toMatch(/�/);
      expect(Buffer.from(p, "utf8").toString("utf8")).toBe(p);
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
  });
});

describe("eventsFor and icsCalendar", () => {
  test("FR-4.3: an item with both dates is one all-day event from start to end inclusive, with a stable UID and its version as SEQUENCE", () => {
    const events = eventsFor(item(), on);
    expect(events).toHaveLength(1);
    const ev = one(events);
    expect(ev.getFirstPropertyValue("uid")).toBe("item-p1@roadmap.example.com");
    expect(ev.getFirstPropertyValue("sequence")).toBe(4);
    expect(dateOf(ev, "dtstart")).toBe("2026-03-02");
    expect(dateOf(ev, "dtend")).toBe("2026-03-07");
    expect(ev.getFirstPropertyValue("summary")).toBe("Launch site");
    expect(ev.getFirstPropertyValue("transp")).toBe("TRANSPARENT");
    expect((ev.getFirstPropertyValue("dtstamp") as ICAL.Time).toString()).toBe(
      "2026-02-01T09:08:07Z",
    );
    expect(
      (ev.getFirstPropertyValue("last-modified") as ICAL.Time).toString(),
    ).toBe("2026-02-01T09:08:07Z");
  });

  test("FR-4.3: an item with only a start or only an end date is a one-day event on that date", () => {
    const startOnly = one(eventsFor(item({ endDate: null }), on));
    expect(dateOf(startOnly, "dtstart")).toBe("2026-03-02");
    expect(dateOf(startOnly, "dtend")).toBe("2026-03-03");
    const endOnly = one(
      eventsFor(item({ startDate: null, endDate: "2026-12-31" }), on),
    );
    expect(dateOf(endOnly, "dtstart")).toBe("2026-12-31");
    expect(dateOf(endOnly, "dtend")).toBe("2027-01-01");
    expect(eventsFor(item({ startDate: null, endDate: null }), on)).toEqual([]);
  });

  test('FR-4.3: each milestone is a one-day event titled "{milestone} · {item title}" with its own stable UID', () => {
    const it = item({
      milestones: [
        { id: "m1", name: "Beta", date: "2026-02-28" },
        { id: "m2", name: "GA", date: "2026-03-04" },
      ],
    });
    const events = eventsFor(it, on);
    expect(events.map((e) => e.uid)).toEqual([
      "item-p1@roadmap.example.com",
      "milestone-m1@roadmap.example.com",
      "milestone-m2@roadmap.example.com",
    ]);
    const parsed = parse(icsCalendar({ name: "Roadmap dates", events })).events;
    const beta = parsed[1]!;
    expect(beta.getFirstPropertyValue("summary")).toBe("Beta · Launch site");
    expect(dateOf(beta, "dtstart")).toBe("2026-02-28");
    expect(dateOf(beta, "dtend")).toBe("2026-03-01");
    expect(beta.getFirstPropertyValue("sequence")).toBe(4);

    expect(
      eventsFor(it, { origin, itemDates: false, milestones: true }).map(
        (e) => e.uid,
      ),
    ).toEqual([
      "milestone-m1@roadmap.example.com",
      "milestone-m2@roadmap.example.com",
    ]);
    expect(
      eventsFor(it, { origin, itemDates: true, milestones: false }).map(
        (e) => e.uid,
      ),
    ).toEqual(["item-p1@roadmap.example.com"]);
  });

  test("FR-4.3: changing an item's dates keeps the UID and raises SEQUENCE", () => {
    const before = eventsFor(item(), on)[0]!;
    const after = eventsFor(
      item({
        endDate: "2026-03-20",
        version: 5,
        updatedAt: new Date("2026-02-02T00:00:00Z"),
      }),
      on,
    )[0]!;
    expect(after.uid).toBe(before.uid);
    expect(after.sequence).toBeGreaterThan(before.sequence);
    const ev = one([after]);
    expect(ev.getFirstPropertyValue("sequence")).toBe(5);
    expect(dateOf(ev, "dtend")).toBe("2026-03-21");
  });

  test("FR-4.4: an event carries the title, the dates and the link back, and nothing else from the item", () => {
    const it = item({
      milestones: [{ id: "m1", name: "Beta", date: "2026-02-28" }],
    });
    const parsed = parse(
      icsCalendar({ name: "Roadmap dates", events: eventsFor(it, on) }),
    ).events;
    const url = "https://roadmap.example.com/r/r1/projects/p1";
    for (const ev of parsed) {
      expect(ev.getAllProperties().map((p) => p.name)).toEqual([
        "uid",
        "dtstamp",
        "last-modified",
        "sequence",
        "dtstart",
        "dtend",
        "summary",
        "url",
        "description",
        "transp",
      ]);
      expect(ev.getFirstPropertyValue("url")).toBe(url);
      expect(ev.getFirstPropertyValue("description")).toBe(
        `Open in Roadmap: ${url}`,
      );
    }
    // A trailing slash on the origin doesn't double up.
    expect(eventsFor(it, { ...on, origin: `${origin}/` })[0]!.url).toBe(url);
  });

  test("FR-4.1: titles with ; , \\ and line breaks, emoji across the fold, and 200 characters of CJK parse back exactly, and no line is longer than 75 octets", () => {
    const titles = [
      "Plan; then, ship \\ fast\r\nsecond line\nthird",
      "x".repeat(63) + "😀👩‍👩‍👧‍👦🎉".repeat(6),
      "路线图".repeat(66) + "路线",
      "Tab\vvertical\fform\u0000nul\u2028line",
    ];
    const events = titles.map(
      (title, i) => eventsFor(item({ _id: `p${i}`, title }), on)[0]!,
    );
    const ics = icsCalendar({ name: "Roadmap dates, mine; \\ yes", events });
    const lines = ics.split("\r\n");
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
      // No raw control character, nor a Unicode line break, gets past the CRLF line ends.
      expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
    }
    const { cal, events: parsed } = parse(ics);
    expect(parsed.map((e) => e.getFirstPropertyValue("summary"))).toEqual(
      titles.map((t) =>
        t
          .replace(/\r\n|\r|[\v\f\u2028]/g, "\n")
          .replace(/\u0000/g, ""),
      ),
    );
    expect(cal.getFirstPropertyValue("x-wr-calname")).toBe(
      "Roadmap dates, mine; \\ yes",
    );
  });

  test("FR-4.1: the calendar has its name, refresh hints and CRLF line ends", () => {
    const ics = icsCalendar({ name: "Roadmap dates", events: [] });
    expect(ics).toBe(
      [
        "BEGIN:VCALENDAR",
        "PRODID:-//Roadmap//Calendar feed//EN",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Roadmap dates",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
    const full = icsCalendar({
      name: "Roadmap dates",
      events: eventsFor(item(), on),
    });
    expect(full.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(full.endsWith("\r\n")).toBe(true);
    const { cal } = parse(full);
    expect(cal.getFirstPropertyValue("x-wr-calname")).toBe("Roadmap dates");
    expect(cal.getFirstPropertyValue("version")).toBe("2.0");
    expect(cal.getFirstPropertyValue("method")).toBe("PUBLISH");
    expect(cal.getFirstPropertyValue("x-published-ttl")).toBe("PT1H");
  });
});

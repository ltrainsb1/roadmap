import type { Project } from './projects.ts';

export const TIMELINE_ZOOMS = ['weeks', 'months', 'quarters'] as const;
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number];
export const DAY_WIDTH: Record<TimelineZoom, number> = { weeks: 24, months: 6, quarters: 2 };
export const MAX_AXIS_WIDTH = 24000;
export const MIN_BAR_WIDTH = 8;

const MS_PER_DAY = 86_400_000;

const parts = (date: string): [number, number, number] => {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
};

/** Whole days since 1970-01-01 for a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number {
  const [y, m, d] = parts(date);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

const dateOf = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
const utcDay = (year: number, month: number, day: number): number => Math.round(Date.UTC(year, month, day) / MS_PER_DAY);
const ymd = (day: number): { year: number; month: number } => {
  const d = new Date(day * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
};

export interface TimelineRange {
  /** First day shown, always the 1st of a month. */
  start: string;
  /** Last day shown, always the last day of a month. */
  end: string;
  days: number;
  /** Pixels per day: the zoom's width, or less when that would pass MAX_AXIS_WIDTH. */
  dayWidth: number;
  /** days × dayWidth. */
  width: number;
}

export function timelineRange(items: readonly Project[], today: string, zoom: TimelineZoom): TimelineRange {
  let min = dayNumber(today);
  let max = min;
  const take = (date: string | null) => {
    if (!date) return;
    const n = dayNumber(date);
    if (n < min) min = n;
    if (n > max) max = n;
  };
  for (const item of items) {
    take(item.startDate);
    take(item.endDate);
    for (const milestone of item.milestones) take(milestone.date);
  }
  const first = ymd(min);
  const last = ymd(max);
  const startDay = utcDay(first.year, first.month - 1, 1);
  const endDay = utcDay(last.year, last.month + 2, 1) - 1;
  const days = endDay - startDay + 1;
  // Rounded down so days × dayWidth never passes the cap through float error.
  const dayWidth = Math.min(DAY_WIDTH[zoom], Math.floor((MAX_AXIS_WIDTH / days) * 1e6) / 1e6);
  return { start: dateOf(startDay), end: dateOf(endDay), days, dayWidth, width: days * dayWidth };
}

/** Pixels from the axis start to the left edge of `date`. */
export function xOf(date: string, range: TimelineRange): number {
  return (dayNumber(date) - dayNumber(range.start)) * range.dayWidth;
}

export interface TimelineBar {
  left: number;
  width: number;
  /** 'range' has both dates; 'start' and 'end' are one-day markers for an item with only that date. */
  kind: 'range' | 'start' | 'end';
}

export function barFor(item: Pick<Project, 'startDate' | 'endDate'>, range: TimelineRange): TimelineBar | null {
  const { startDate, endDate } = item;
  if (startDate && endDate) {
    const days = dayNumber(endDate) - dayNumber(startDate) + 1;
    return { left: xOf(startDate, range), width: Math.max(days * range.dayWidth, MIN_BAR_WIDTH), kind: 'range' };
  }
  if (startDate) return { left: xOf(startDate, range), width: MIN_BAR_WIDTH, kind: 'start' };
  if (endDate) return { left: xOf(endDate, range), width: MIN_BAR_WIDTH, kind: 'end' };
  return null;
}

export interface TimelineTick {
  date: string;
  left: number;
  width: number;
  label: string;
}

type Unit = 'week' | 'month' | 'quarter' | 'year';

const startOfUnit = (day: number, unit: Unit): number => {
  const { year, month } = ymd(day);
  if (unit === 'week') return day - ((new Date(day * MS_PER_DAY).getUTCDay() + 6) % 7);
  if (unit === 'month') return utcDay(year, month, 1);
  if (unit === 'quarter') return utcDay(year, Math.floor(month / 3) * 3, 1);
  return utcDay(year, 0, 1);
};

const nextUnit = (day: number, unit: Unit): number => {
  const { year, month } = ymd(day);
  if (unit === 'week') return day + 7;
  if (unit === 'month') return utcDay(year, month + 1, 1);
  if (unit === 'quarter') return utcDay(year, month + 3, 1);
  return utcDay(year + 1, 0, 1);
};

const format = (day: number, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(day * MS_PER_DAY));

const labelOf = (day: number, unit: Unit): string => {
  if (unit === 'week') return String(new Date(day * MS_PER_DAY).getUTCDate());
  if (unit === 'month') return format(day, { month: 'short' });
  if (unit === 'quarter') return `Q${Math.floor(ymd(day).month / 3) + 1}`;
  return format(day, { year: 'numeric' });
};

const majorLabel = (day: number, unit: Unit): string =>
  unit === 'month' ? format(day, { month: 'long', year: 'numeric' }) : labelOf(day, unit);

function ticksOf(range: TimelineRange, unit: Unit, label: (day: number, unit: Unit) => string): TimelineTick[] {
  const rangeStart = dayNumber(range.start);
  const rangeEnd = dayNumber(range.end);
  const ticks: TimelineTick[] = [];
  for (let period = startOfUnit(rangeStart, unit); period <= rangeEnd; period = nextUnit(period, unit)) {
    const from = Math.max(period, rangeStart);
    const to = Math.min(nextUnit(period, unit) - 1, rangeEnd);
    ticks.push({
      date: dateOf(from),
      left: (from - rangeStart) * range.dayWidth,
      width: (to - from + 1) * range.dayWidth,
      label: label(period, unit),
    });
  }
  return ticks;
}

const UNITS: Record<TimelineZoom, { major: Unit; minor: Unit }> = {
  weeks: { major: 'month', minor: 'week' },
  months: { major: 'year', minor: 'month' },
  quarters: { major: 'year', minor: 'quarter' },
};

const MIN_TICK_WIDTH = 24;

/** Upper and lower header rows. `minor` is empty when its ticks would average under 24 px wide. */
export function timelineTicks(range: TimelineRange, zoom: TimelineZoom): { major: TimelineTick[]; minor: TimelineTick[] } {
  const units = UNITS[zoom];
  const minor = ticksOf(range, units.minor, labelOf);
  return {
    major: ticksOf(range, units.major, majorLabel),
    minor: range.width / minor.length < MIN_TICK_WIDTH ? [] : minor,
  };
}

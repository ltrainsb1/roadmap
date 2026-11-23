import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  formatDates,
  formatDayUtc,
  noteExcerpt,
  notificationPrefsSchema,
  notificationSentence,
  type NotificationDetail,
} from '../src/index.ts';

const sentence = (detail: NotificationDetail, actorName: string | null = 'Priya Shah', hasActor = true, forSubject = false) =>
  notificationSentence({ projectTitle: 'Launch plan', actorName, hasActor, detail }, { forSubject });

const dates = { kind: 'dates', before: { startDate: null, endDate: null }, after: { startDate: '2027-03-03', endDate: null } } as const;

describe('notifications', () => {
  it('FR-5.1: each kind of notification has its exact sentence', () => {
    expect(sentence({ kind: 'assigned' })).toBe('Priya Shah assigned you to Launch plan.');
    expect(sentence(dates)).toBe('Priya Shah changed the dates on Launch plan.');
    expect(sentence({ kind: 'milestone', change: 'moved', name: 'Beta', date: '2027-03-03' })).toBe(
      'Priya Shah moved the milestone Beta on Launch plan to 3 Mar 2027.',
    );
    expect(sentence({ kind: 'milestone', change: 'added', name: 'Beta', date: '2027-03-03' })).toBe(
      'Priya Shah added the milestone Beta on Launch plan.',
    );
    expect(sentence({ kind: 'milestone', change: 'removed', name: 'Beta', date: '2027-03-03' })).toBe(
      'Priya Shah removed the milestone Beta on Launch plan.',
    );
    expect(sentence({ kind: 'mentioned', excerpt: 'hi' })).toBe('Priya Shah mentioned you on Launch plan.');
    expect(sentence({ kind: 'due_end', date: '2027-09-03' }, null, false)).toBe('Launch plan is due 3 Sep 2027.');
    expect(sentence({ kind: 'due_milestone', name: 'Beta', date: '2027-03-03' }, null, false)).toBe(
      'The milestone Beta on Launch plan is on 3 Mar 2027.',
    );
  });

  it('FR-5.1: the subject form has no final full stop', () => {
    expect(sentence({ kind: 'assigned' }, 'Priya Shah', true, true)).toBe('Priya Shah assigned you to Launch plan');
    expect(sentence(dates, 'Priya Shah', true, true)).toBe('Priya Shah changed the dates on Launch plan');
    expect(sentence({ kind: 'milestone', change: 'moved', name: 'Beta', date: '2027-03-03' }, 'Priya Shah', true, true)).toBe(
      'Priya Shah moved the milestone Beta on Launch plan to 3 Mar 2027',
    );
    expect(sentence({ kind: 'milestone', change: 'added', name: 'Beta', date: '2027-03-03' }, 'Priya Shah', true, true)).toBe(
      'Priya Shah added the milestone Beta on Launch plan',
    );
    expect(sentence({ kind: 'milestone', change: 'removed', name: 'Beta', date: '2027-03-03' }, 'Priya Shah', true, true)).toBe(
      'Priya Shah removed the milestone Beta on Launch plan',
    );
    expect(sentence({ kind: 'mentioned', excerpt: 'hi' }, 'Priya Shah', true, true)).toBe('Priya Shah mentioned you on Launch plan');
    expect(sentence({ kind: 'due_end', date: '2027-03-03' }, null, false, true)).toBe('Launch plan is due 3 Mar 2027');
    expect(sentence({ kind: 'due_milestone', name: 'Beta', date: '2027-03-03' }, null, false, true)).toBe(
      'The milestone Beta on Launch plan is on 3 Mar 2027',
    );
  });

  it('FR-5.1: an actor whose account is gone is "A former member"', () => {
    expect(sentence({ kind: 'assigned' }, null, true)).toBe('A former member assigned you to Launch plan.');
    expect(sentence({ kind: 'mentioned', excerpt: 'x' }, null, true, true)).toBe('A former member mentioned you on Launch plan');
  });

  it('FR-5.1: a due-soon notice names no actor', () => {
    expect(sentence({ kind: 'due_end', date: '2027-03-03' }, 'Ignored', false)).toBe('Launch plan is due 3 Mar 2027.');
  });

  it('FR-5.1: formatDayUtc uses fixed English month names', () => {
    expect(formatDayUtc('2027-03-03')).toBe('3 Mar 2027');
    expect(formatDayUtc('2027-09-30')).toBe('30 Sep 2027');
    expect(formatDayUtc('2027-12-01')).toBe('1 Dec 2027');
    expect(formatDayUtc('2027-09-03', { year: false })).toBe('3 Sep');
    expect(() => formatDayUtc('2027-02-30')).toThrow(RangeError);
    expect(() => formatDayUtc('soon')).toThrow(RangeError);
  });

  it('FR-5.1: a note excerpt is plain text, one line, at most 200 characters, and never splits an emoji', () => {
    const body = '# Heading\n\n**bold** <b>html</b> [link](http://x)\r\n'.repeat(120).slice(0, 5000);
    const out = noteExcerpt(body);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe(out.trim());
    expect(out.startsWith('# Heading **bold**')).toBe(true);

    const emoji = noteExcerpt('a'.repeat(199) + '😀' + 'b'.repeat(50));
    expect(emoji.length).toBeLessThanOrEqual(200);
    expect(emoji).toBe('a'.repeat(199));
    expect(noteExcerpt('a'.repeat(198) + '😀' + 'b').endsWith('😀')).toBe(true);
    expect(noteExcerpt('😀'.repeat(200)).length).toBeLessThanOrEqual(200);
    expect(noteExcerpt('a'.repeat(200))).toBe('a'.repeat(200));
    expect(noteExcerpt('a'.repeat(201))).toBe('a'.repeat(200));
    expect(noteExcerpt(' \n\t \r\n ')).toBe('');
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(noteExcerpt('  \n short \n ')).toBe('short');
  });

  it('FR-5.2: the defaults are instant for assigned and mentions, digest for dates changed and due soon', () => {
    expect(DEFAULT_PREFS).toEqual({ assigned: 'instant', mentioned: 'instant', dates_changed: 'digest', due_soon: 'digest' });
  });

  it('FR-5.2: preferences accept only instant, digest or off for each of the four types', () => {
    expect(notificationPrefsSchema.safeParse(DEFAULT_PREFS).success).toBe(true);
    for (const key of Object.keys(DEFAULT_PREFS)) {
      expect(notificationPrefsSchema.safeParse({ ...DEFAULT_PREFS, [key]: 'off' }).success).toBe(true);
      expect(notificationPrefsSchema.safeParse({ ...DEFAULT_PREFS, [key]: 'daily' }).success).toBe(false);
    }
    expect(notificationPrefsSchema.safeParse({ assigned: 'instant' }).success).toBe(false);
  });
});

describe('date phrases', () => {
  it('FR-1.7: both dates in one year drop the year from the first', () => {
    expect(formatDates('2027-03-03', '2027-04-28')).toBe('3 Mar to 28 Apr 2027');
  });
  it('FR-1.7: both dates in different years keep both years', () => {
    expect(formatDates('2026-12-01', '2027-01-15')).toBe('1 Dec 2026 to 15 Jan 2027');
  });
  it('FR-1.7: a start alone, an end alone, and no dates', () => {
    expect(formatDates('2027-03-03', null)).toBe('From 3 Mar 2027');
    expect(formatDates(null, '2027-04-28')).toBe('Until 28 Apr 2027');
    expect(formatDates(null, null)).toBe('No dates');
  });
  it('FR-1.7: September is "Sep" on any ICU', () => {
    expect(formatDates('2027-09-01', '2027-09-30')).toBe('1 Sep to 30 Sep 2027');
    expect(formatDates('2027-09-01', null)).toBe('From 1 Sep 2027');
    expect(formatDates(null, '2027-09-30')).toBe('Until 30 Sep 2027');
  });
  it("FR-1.7: a date is never shifted by the reader's time zone", () => {
    expect(formatDates('2027-01-01', null)).toBe('From 1 Jan 2027');
  });
});

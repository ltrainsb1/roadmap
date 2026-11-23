import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
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
  });

  it('FR-5.1: a note excerpt is plain text, one line, at most 200 characters, and never splits an emoji', () => {
    const body = '# Heading\n\n**bold** <b>html</b> [link](http://x)\r\n'.repeat(120).slice(0, 5000);
    const out = noteExcerpt(body);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe(out.trim());
    expect(out.startsWith('# Heading **bold**')).toBe(true);

    const emoji = noteExcerpt('a'.repeat(199) + '😀' + 'b'.repeat(50));
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.endsWith('😀')).toBe(true);
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

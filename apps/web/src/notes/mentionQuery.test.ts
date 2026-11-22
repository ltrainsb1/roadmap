import { describe, expect, test } from 'vitest';
import { insertMention, matchMembers, mentionQueryAt } from './mentionQuery.ts';

const m = (name: string, userId = name) => ({ userId, name });

describe('mentionQueryAt', () => {
  test('FR-1.5: the query is the text after an @ that starts a word', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('hi @an', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQueryAt('hi @Ann Le', 10)).toEqual({ start: 3, query: 'Ann Le' }); // names have spaces
    expect(mentionQueryAt('mail a@b', 8)).toBeNull();
    expect(mentionQueryAt('hi @an\nnext', 11)).toBeNull(); // a new line ends it
    expect(mentionQueryAt('hi @' + 'x'.repeat(41), 45)).toBeNull(); // give up after 40 characters
  });

  test('FR-1.5: an @ after a new line or "(" starts a query; 40 characters still count; a space right after the @ does not', () => {
    expect(mentionQueryAt('one\n@b', 6)).toEqual({ start: 4, query: 'b' });
    expect(mentionQueryAt('(@b', 3)).toEqual({ start: 1, query: 'b' });
    expect(mentionQueryAt('@' + 'x'.repeat(40), 41)).toEqual({ start: 0, query: 'x'.repeat(40) });
    expect(mentionQueryAt('at @ 5pm', 8)).toBeNull();
    expect(mentionQueryAt('no at sign', 10)).toBeNull();
    // Only the text before the caret counts.
    expect(mentionQueryAt('hi @an there', 6)).toEqual({ start: 3, query: 'an' });
    expect(mentionQueryAt('hi @an', 2)).toBeNull();
  });
});

describe('insertMention', () => {
  test('FR-1.5: picking replaces the query with the name and a space', () => {
    expect(insertMention('hi @an', { start: 3, query: 'an' }, 'Ann Lee')).toEqual({ text: 'hi @Ann Lee ', caret: 12 });
    expect(insertMention('hi @an there', { start: 3, query: 'an' }, 'Ann Lee')).toEqual({ text: 'hi @Ann Lee there', caret: 12 }); // no second space
  });
});

describe('matchMembers', () => {
  test('FR-1.5: "an" matches "Ann", "Joanna" and "Dan" in name order, case ignored', () => {
    const members = [m('Joanna'), m('Bob'), m('Ann'), m('Dan')];
    expect(matchMembers(members, 'an').map((x) => x.name)).toEqual(['Ann', 'Dan', 'Joanna']);
    expect(matchMembers(members, 'AN').map((x) => x.name)).toEqual(['Ann', 'Dan', 'Joanna']);
  });

  test('FR-1.5: an empty query returns the first 8 in name order', () => {
    const members = ['Ivy', 'Hal', 'Gus', 'Fay', 'Eve', 'Dot', 'Cy', 'Bea', 'Al'].map((n) => m(n));
    expect(matchMembers(members, '').map((x) => x.name)).toEqual(['Al', 'Bea', 'Cy', 'Dot', 'Eve', 'Fay', 'Gus', 'Hal']);
  });

  test('FR-1.5: no match returns []', () => {
    expect(matchMembers([m('Ann')], 'zzz')).toEqual([]);
  });

  test('FR-1.5: two members of the same name are both listed', () => {
    expect(matchMembers([m('Ann', 'u2'), m('Ann', 'u1')], 'ann').map((x) => x.userId)).toHaveLength(2);
  });
});

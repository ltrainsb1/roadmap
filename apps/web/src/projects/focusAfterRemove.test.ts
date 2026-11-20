import { afterEach, describe, expect, test } from 'vitest';
import { focusRemaining } from './focusAfterRemove.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

const page = (count: number) => {
  document.body.innerHTML =
    Array.from({ length: count }, (_, i) => `<button data-list="tags" id="b${i}">Remove ${i}</button>`).join('') +
    '<button data-list="links" id="other">Other list</button><input id="add" />';
  return document.body;
};

describe('focusRemaining', () => {
  test('goes to the button that took the removed one\'s place', () => {
    focusRemaining(page(3), 'tags', 1, 'add');
    expect(document.activeElement?.id).toBe('b1');
  });

  test('goes to the previous button when the last one was removed', () => {
    focusRemaining(page(2), 'tags', 2, 'add');
    expect(document.activeElement?.id).toBe('b1');
  });

  test('goes to the add field when the list is empty, and ignores other lists', () => {
    focusRemaining(page(0), 'tags', 0, 'add');
    expect(document.activeElement?.id).toBe('add');
  });
});

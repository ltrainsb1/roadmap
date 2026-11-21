import { describe, expect, test } from 'vitest';
import { isPlainClick } from './isPlainClick.ts';

const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe('isPlainClick', () => {
  test('a left click with no modifier is plain', () => {
    expect(isPlainClick(click)).toBe(true);
  });

  test('another button or any modifier key is not', () => {
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainClick({ ...click, altKey: true })).toBe(false);
  });
});

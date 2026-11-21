import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Menu } from './Menu.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
});

/** A 375 px wide window, and a list that measures 176 by 140 px (jsdom lays nothing out). */
function layout() {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(140);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(176);
}

function setup(align?: 'start' | 'end') {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  render(
    <div data-testid="frame">
      <Menu
        label="Actions for Launch site"
        align={align}
        items={[
          { label: 'Open', onSelect: onOpen },
          { label: 'Delete', onSelect: onDelete },
        ]}
      />
    </div>,
  );
  const button = screen.getByRole('button', { name: 'Actions for Launch site' });
  return { button, onOpen, onDelete };
}

describe('Menu', () => {
  test('opening shows the items, fixed in place, with focus on the first', () => {
    const { button } = setup();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Actions for Launch site' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(menu.style.position).toBe('fixed');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open' }));
  });

  test('choosing an item closes the list, returns focus to the button and runs the item', () => {
    const { button, onDelete } = setup();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test('Escape closes the list and returns focus to the button', () => {
    const { button, onOpen, onDelete } = setup();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  test('a scroll anywhere that moves the button closes the list; focus goes back to the button only if the list held it', () => {
    const { button } = setup();
    let top = 100;
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => new DOMRect(200, top, 44, 44));
    fireEvent.click(button);
    fireEvent.scroll(screen.getByTestId('frame'));
    // A scroll event that left the button where it was: the list stays.
    expect(screen.getByRole('menu')).toBeTruthy();
    top = 60;
    fireEvent.scroll(screen.getByTestId('frame'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    top = 20;
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  test('the list opens under the button, its right edge lined up with the button\'s', () => {
    const { button } = setup();
    layout();
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 100, 44, 44));
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect([menu.style.top, menu.style.left]).toEqual(['148px', `${244 - 176}px`]);
  });

  test('the list opens over the button when there is no room below', () => {
    const { button } = setup();
    layout();
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, window.innerHeight - 60, 44, 44));
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.top).toBe(`${window.innerHeight - 60 - 4 - 140}px`);
  });

  test('the list stays inside the window at either edge', () => {
    const { button } = setup();
    layout();
    const rect = vi.spyOn(button, 'getBoundingClientRect');
    rect.mockReturnValue(new DOMRect(10, 100, 44, 44));
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.left).toBe('8px');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    rect.mockReturnValue(new DOMRect(340, 100, 30, 44));
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.left).toBe(`${375 - 8 - 176}px`);
  });

  test('align="start" lines the list up with the button\'s left edge, and still keeps it inside the window', () => {
    const { button } = setup('start');
    layout();
    const rect = vi.spyOn(button, 'getBoundingClientRect');
    rect.mockReturnValue(new DOMRect(40, 100, 80, 44));
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.left).toBe('40px');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    rect.mockReturnValue(new DOMRect(300, 100, 60, 44));
    fireEvent.click(button);
    expect(screen.getByRole('menu').style.left).toBe(`${375 - 8 - 176}px`);
  });

  test('resizing the window closes the list', () => {
    const { button } = setup();
    fireEvent.click(button);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

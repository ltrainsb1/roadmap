import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** When set, the entry is a radio item and this says whether it is the current choice. */
  checked?: boolean;
  /** The entry stays in the list and keeps focus but does nothing, such as "Move up" on the first item. */
  disabled?: boolean;
}

interface MenuProps {
  /** The button's accessible name, such as "Actions for Launch site". */
  label: string;
  items: MenuItem[];
  /** An id for the button, so a caller can return focus to it. */
  buttonId?: string;
  /** What the button shows in place of the three dots, such as a status pill. */
  trigger?: ReactNode;
  /** A class for the button, in place of the icon button's. */
  triggerClassName?: string;
  /** Which edge of the button the list lines up with: the end (right) by default. */
  align?: 'start' | 'end';
}

/** Space between the button and the list, and the least space kept between the list and the window's edge. */
const GAP = 4;
const EDGE = 8;

/**
 * Where the list goes, in window coordinates: under the button, or over it when there is more room above than below
 * and not enough below, and always inside the window from side to side.
 */
function placeList(button: DOMRect, width: number, height: number, align: 'start' | 'end') {
  const windowWidth = document.documentElement.clientWidth;
  const below = window.innerHeight - button.bottom - GAP;
  const above = button.top - GAP;
  const top = below >= height || below >= above ? button.bottom + GAP : Math.max(EDGE, button.top - GAP - height);
  const preferred = align === 'start' ? button.left : button.right - width;
  const left = Math.max(EDGE, Math.min(preferred, windowWidth - EDGE - width));
  return { top, left };
}

/**
 * A button that opens a list of actions. Arrow keys, Home and End move between items, Escape closes the list
 * and returns focus to the button, and choosing an item closes it and hands focus back to the button first.
 *
 * The list is fixed to the window, placed from the button's box when it opens, so a scrolling frame around the
 * button can't clip it. It closes when anything scrolls or the window is resized, since it would no longer sit by
 * its button.
 */
export function Menu({ label, items, buttonId, trigger, triggerClassName = 'icon-btn', align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  // Where the button was when the list was placed.
  const placedAt = useRef<DOMRect | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const ownButtonId = useId();
  const triggerId = buttonId ?? ownButtonId;

  const entries = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  // Measured before the browser paints, so the list never shows in the wrong place.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    placedAt.current = button.current.getBoundingClientRect();
    setPlace(placeList(placedAt.current, list.current.offsetWidth, list.current.offsetHeight, align));
  }, [open, align]);

  useEffect(() => {
    if (open) (list.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? entries()[0])?.focus({ preventScroll: true });
  }, [open]);

  // A scroll anywhere (captured, since scroll events don't bubble) or a resize leaves the list away from its button.
  // A scroll event that comes after the list was placed but did not move the button, such as the one for a scroll
  // just before the press that opened it, leaves the list where it is.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      const hadFocus = list.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (hadFocus) button.current?.focus({ preventScroll: true });
    };
    const onScroll = () => {
      const now = button.current?.getBoundingClientRect();
      const was = placedAt.current;
      if (!now || !was || now.top !== was.top || now.left !== was.left) dismiss();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  // A press outside the menu closes it, and leaves focus where the press put it.
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const closeAndFocusButton = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      e.preventDefault();
      all[(index + all.length) % all.length]?.focus({ preventScroll: true });
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAndFocusButton();
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="menu" ref={wrapper}>
      <button
        ref={button}
        id={triggerId}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? (
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <circle cx="3" cy="8" r="1.5" fill="currentColor" />
            <circle cx="8" cy="8" r="1.5" fill="currentColor" />
            <circle cx="13" cy="8" r="1.5" fill="currentColor" />
          </svg>
        )}
      </button>
      {open && (
        <div
          id={listId}
          ref={list}
          role="menu"
          aria-labelledby={triggerId}
          className="menu-list"
          style={{ position: 'fixed', top: place.top, left: place.left }}
          onKeyDown={onListKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              aria-disabled={item.disabled || undefined}
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                if (item.disabled) return;
                closeAndFocusButton();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

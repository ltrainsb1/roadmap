import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** When set, the entry is a radio item and this says whether it is the current choice. */
  checked?: boolean;
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
}

/**
 * A button that opens a list of actions. Arrow keys, Home and End move between items, Escape closes the list
 * and returns focus to the button, and choosing an item closes it and hands focus back to the button first.
 */
export function Menu({ label, items, buttonId, trigger, triggerClassName = 'icon-btn' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const ownButtonId = useId();
  const triggerId = buttonId ?? ownButtonId;

  const entries = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  useEffect(() => {
    if (open) (list.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? entries()[0])?.focus();
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
      all[(index + all.length) % all.length]?.focus();
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
        <div id={listId} ref={list} role="menu" aria-labelledby={triggerId} className="menu-list" onKeyDown={onListKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
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

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MemberName } from '../projects/PanelLists.tsx';
import { placeList } from '../ui/Menu.tsx';

interface MentionPickerProps {
  /** The listbox's id, for the text box's `aria-controls`. */
  id: string;
  /** The id of the option at `index`, for the text box's `aria-activedescendant`. */
  optionId: (index: number) => string;
  /** The text box the list belongs to: it keeps focus, and the list is placed under it. */
  anchor: RefObject<HTMLTextAreaElement | null>;
  matches: readonly MemberName[];
  active: number;
  /** Names that more than one member has: those options show the email too. */
  sharedNames: ReadonlySet<string>;
  onPick: (member: MemberName) => void;
  /** A scroll that moved the text box, or a resize, leaves the list away from it. */
  onDismiss: () => void;
}

/**
 * The @ list: a listbox of members by a note's text box (FR-1.5). Focus stays in the text box, which points at the
 * active option. Like `Menu`, the list is fixed to the window and placed from the text box's box, so a scrolling
 * panel can't clip it: under the box, or over it when there is no room below, never taller than the room there.
 */
export function MentionPicker({ id, optionId, anchor, matches, active, sharedNames, onPick, onDismiss }: MentionPickerProps) {
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight?: number }>({ top: 0, left: 0 });
  const placedAt = useRef<DOMRect | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  // Measured before the browser paints, and again when the matches change the list's height.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!anchor.current || !el) return;
    placedAt.current = anchor.current.getBoundingClientRect();
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
    setPlace(placeList(placedAt.current, el.offsetWidth, height, 'start'));
  }, [anchor, matches]);

  // Keep the active option in view inside a capped list.
  useLayoutEffect(() => {
    const el = frame.current;
    const option = el?.querySelectorAll<HTMLElement>('[role="option"]')[active];
    if (!el || !option) return;
    const bottom = option.offsetTop + option.offsetHeight;
    if (option.offsetTop < el.scrollTop) el.scrollTop = option.offsetTop;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [active, matches]);

  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const onScroll = () => {
      const now = anchor.current?.getBoundingClientRect();
      const was = placedAt.current;
      if (!now || !was || now.top !== was.top || now.left !== was.left) dismiss.current();
    };
    const onResize = () => dismiss.current();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor]);

  return (
    <div
      ref={frame}
      className="mention-picker"
      style={{ position: 'fixed', top: place.top, left: place.left, maxHeight: place.maxHeight }}
    >
      <ul id={id} role="listbox" aria-label="People" className="mention-list">
        {matches.map((m, i) => (
          <li
            key={m.userId}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            tabIndex={-1}
            className="mention-option"
            // Pressing an option must not take focus from the text box.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(m)}
          >
            {m.name}
            {sharedNames.has(m.name) && m.email && (
              <>
                {' '}
                <span className="mention-email">{m.email}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="mention-none">No one matches.</p>}
    </div>
  );
}

import type { Project } from '@roadmap/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isPlainClick } from '../ui/isPlainClick.ts';
import { levelName } from './names.ts';

/** Pieces of an item that the List, the Timeline and the Board all show. */

export const actionsButtonId = (itemId: string) => `actions-${itemId}`;
export const titleLinkId = (itemId: string) => `title-${itemId}`;

export const dragHandleIcon = (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
    <circle cx="5.5" cy="4" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="4" r="1.25" fill="currentColor" />
    <circle cx="5.5" cy="8" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="8" r="1.25" fill="currentColor" />
    <circle cx="5.5" cy="12" r="1.25" fill="currentColor" />
    <circle cx="10.5" cy="12" r="1.25" fill="currentColor" />
  </svg>
);

export function WarningIcon({ texts }: { texts: string[] }) {
  return (
    <span className="warning" title={texts.join(' ')}>
      <svg viewBox="0 0 16 16" width="18" height="18" role="img" aria-label="Has warnings">
        <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8 6.5v3.5M8 11.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" className={open ? 'chevron open' : 'chevron'}>
      <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface TitleLinkProps {
  item: Project;
  /** Where the link goes: the current view with this item's panel open. */
  href: string;
  selected: boolean;
  /** Opens the item's panel; the page may ask about unsaved edits first. */
  onOpen: () => void;
}

/** An item's title as a link to its panel. A plain click goes through the page; a new-tab click keeps its default. */
export function TitleLink({ item, href, selected, onOpen }: TitleLinkProps) {
  return (
    <Link
      id={titleLinkId(item.id)}
      to={href}
      className="item-title"
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
    >
      {item.title}
    </Link>
  );
}

interface NameCellProps extends TitleLinkProps {
  /** Whether the item has children shown under it, so it gets a chevron. */
  hasChildren: boolean;
  /** Every item is open while filtering, so no chevron is shown. */
  expandAll: boolean;
  open: boolean;
  onToggle: () => void;
  /** Shown only because something under it matches. */
  context: boolean;
  warnings: string[];
  /** More to show after the name, such as the Timeline's status and Actions menu. */
  children?: ReactNode;
}

/** The row header of the List and the Timeline: chevron, level, title, badges and the warning icon. */
export function NameCell({ item, hasChildren, expandAll, open, onToggle, context, warnings, children, ...link }: NameCellProps) {
  return (
    <th scope="row" className="name-cell">
      <div className="name">
        {hasChildren && !expandAll ? (
          <button type="button" className="icon-btn" aria-label={`${open ? 'Collapse' : 'Expand'} ${item.title}`} onClick={onToggle}>
            <Chevron open={open} />
          </button>
        ) : (
          <span className="chevron-space" aria-hidden="true" />
        )}
        <span className="sr-only">{levelName(item.depth)}: </span>
        <TitleLink item={item} {...link} />
        {item.archived && <span className="badge">Archived</span>}
        {context && <span className="sr-only">Shown for context</span>}
        {warnings.length > 0 && <WarningIcon texts={warnings} />}
        {children}
      </div>
    </th>
  );
}

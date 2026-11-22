import type { SnapshotContent, SnapshotItem } from '@roadmap/shared';
import type { ReactNode } from 'react';
import { formatDay } from '../projects/names.ts';
import { SnapshotNotes } from './SnapshotNotes.tsx';

/** Only `http:` and `https:` addresses become links; frozen text is as untrusted as live text. */
export function isWebAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const blockerTitles = (item: SnapshotItem, byId: ReadonlyMap<string, SnapshotItem>): string[] =>
  item.blockedBy.map((id) => byId.get(id)?.title).filter((t): t is string => t !== undefined);

/** Whether an item has anything to show in its details. With notes included, every item does. */
export function hasDetails(item: SnapshotItem, include: SnapshotContent['include'], byId: ReadonlyMap<string, SnapshotItem>): boolean {
  return (
    include.notes ||
    item.description.trim() !== '' ||
    item.milestones.length > 0 ||
    item.tags.length > 0 ||
    item.links.length > 0 ||
    blockerTitles(item, byId).length > 0
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="details-part">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

interface SnapshotItemDetailsProps {
  linkId: string;
  item: SnapshotItem;
  include: SnapshotContent['include'];
  byId: ReadonlyMap<string, SnapshotItem>;
}

/** An item's details: each part only when it has something in it, and its notes when the snapshot has them. */
export function SnapshotItemDetails({ linkId, item, include, byId }: SnapshotItemDetailsProps) {
  const blockers = blockerTitles(item, byId);
  return (
    <div className="snapshot-details">
      {item.description.trim() !== '' && (
        <Part title="Description">
          {/* Plain text in this app, not Markdown: shown as written, line breaks kept. */}
          <p className="plain-text">{item.description}</p>
        </Part>
      )}
      {item.milestones.length > 0 && (
        <Part title="Milestones">
          <ul>
            {item.milestones.map((m) => (
              <li key={m.id}>
                {m.name}, {formatDay(m.date)}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {item.tags.length > 0 && (
        <Part title="Tags">
          <ul className="details-tags">
            {item.tags.map((tag) => (
              <li key={tag} className="badge">
                {tag}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {item.links.length > 0 && (
        <Part title="Links">
          <ul>
            {item.links.map((l) => (
              <li key={l.id}>
                {isWebAddress(l.url) ? (
                  <a href={l.url} target="_blank" rel="noopener noreferrer">
                    {l.label || l.url}
                  </a>
                ) : (
                  l.label || l.url
                )}
              </li>
            ))}
          </ul>
        </Part>
      )}
      {blockers.length > 0 && (
        <Part title="Blocked by">
          <ul>
            {blockers.map((title, i) => (
              <li key={`${title}-${i}`}>{title}</li>
            ))}
          </ul>
        </Part>
      )}
      {include.notes && <SnapshotNotes linkId={linkId} itemId={item.id} noteCount={item.noteCount} />}
    </div>
  );
}

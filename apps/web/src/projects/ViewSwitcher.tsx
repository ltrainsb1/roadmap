import { Link } from 'react-router-dom';
import { isPlainClick } from '../ui/isPlainClick.ts';

export type ProjectView = 'list' | 'timeline' | 'board';

const SEGMENTS: Record<ProjectView, string> = { list: 'projects', timeline: 'timeline', board: 'board' };
const NAMES: Record<ProjectView, string> = { list: 'List', timeline: 'Timeline', board: 'Board' };

/** The address of one view of a roadmap's items, without an open item. */
export const viewPath = (roadmapId: string, view: ProjectView): string => `/r/${encodeURIComponent(roadmapId)}/${SEGMENTS[view]}`;

interface ViewSwitcherProps {
  roadmapId: string;
  view: ProjectView;
  /** The query string to keep, with its leading "?" or empty. */
  search: string;
  /** Goes to `path`; the page may ask about unsaved edits first. */
  onNavigate: (path: string) => void;
  views: readonly ProjectView[];
}

/** Links to the views of the same items. Each view has its own address, so these are links, not buttons. */
export function ViewSwitcher({ roadmapId, view, search, onNavigate, views }: ViewSwitcherProps) {
  return (
    <nav aria-label="View" className="view-switcher">
      {views.map((v) => {
        const path = `${viewPath(roadmapId, v)}${search}`;
        return (
          <Link
            key={v}
            to={path}
            aria-current={v === view ? 'page' : undefined}
            onClick={(e) => {
              // Plain clicks go through the page; a new-tab click keeps its default.
              if (!isPlainClick(e)) return;
              e.preventDefault();
              onNavigate(path);
            }}
          >
            {NAMES[v]}
          </Link>
        );
      })}
    </nav>
  );
}

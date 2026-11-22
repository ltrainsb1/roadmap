import type { SnapshotContent, SnapshotView } from '@roadmap/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { formatDay } from '../projects/names.ts';
import { LinkProblem, linkProblemOf, LoadFailed } from './SnapshotGate.tsx';
import { SnapshotList } from './SnapshotList.tsx';
import { SnapshotTimeline } from './SnapshotTimeline.tsx';
import { useReturnToGate, useSnapshotContent, viewPath, type ViewState } from './useSnapshot.ts';

const VIEW_NAMES: Record<SnapshotView, string> = { list: 'List', timeline: 'Timeline' };

/** Sets the page title while mounted, and puts the old one back after. */
function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title === undefined) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}

function ViewerPage({ children }: { children: ReactNode }) {
  return <div className="page page-wide snapshot-page">{children}</div>;
}

interface SnapshotHeaderProps {
  linkId: string;
  content: SnapshotContent;
  view: SnapshotView;
  /** The query string to keep when switching views (the Timeline's zoom), with its leading "?" or empty. */
  search: string;
  /** Takes focus once, when the snapshot has just been unlocked. */
  focusHeading: boolean;
}

/** The roadmap's name as the page heading, the "as of" date, and the two views. */
function SnapshotHeader({ linkId, content, view, search, focusHeading }: SnapshotHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  return (
    <header className="snapshot-header">
      <div className="snapshot-heading">
        <h1 ref={heading} tabIndex={-1}>
          {content.roadmapName}
        </h1>
        <p className="snapshot-as-of">As of {formatDay(content.asOf)}</p>
      </div>
      <nav aria-label="View" className="view-switcher">
        {(['list', 'timeline'] as const).map((v) => (
          <Link key={v} to={`${viewPath(linkId, v)}${search}`} aria-current={v === view ? 'page' : undefined}>
            {VIEW_NAMES[v]}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** `/s/:linkId/list` and `/s/:linkId/timeline`: a snapshot's header and one of its two views. */
export function SnapshotLayout({ view }: { view: SnapshotView }) {
  const { linkId = '' } = useParams();
  const location = useLocation();
  const content = useSnapshotContent(linkId);
  const leaving = useReturnToGate(linkId, content.error);
  const data = content.data;
  useDocumentTitle(data && `${data.roadmapName}: snapshot`);

  if (content.isPending || leaving) {
    return (
      <ViewerPage>
        <main>
          <p role="status">Loading</p>
        </main>
      </ViewerPage>
    );
  }
  if (content.isError) {
    const kind = linkProblemOf(content.error);
    if (kind) return <LinkProblem kind={kind} />;
    return (
      <ViewerPage>
        <main>
          <LoadFailed onRetry={() => void content.refetch()} />
        </main>
      </ViewerPage>
    );
  }

  const unlocked = (location.state as ViewState | null)?.unlocked === true;
  return (
    <ViewerPage>
      <SnapshotHeader linkId={linkId} content={content.data} view={view} search={location.search} focusHeading={unlocked} />
      <main>{view === 'list' ? <SnapshotList linkId={linkId} content={content.data} /> : <SnapshotTimeline content={content.data} />}</main>
    </ViewerPage>
  );
}

import type { SnapshotContent, SnapshotView } from '@roadmap/shared';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.ts';
import { formatDay } from '../projects/names.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { LinkProblem, linkProblemOf, LoadFailed } from './SnapshotGate.tsx';
import { SnapshotList } from './SnapshotList.tsx';
import { SnapshotTimeline } from './SnapshotTimeline.tsx';
import {
  useDocumentTitle,
  useReturnToGate,
  useSnapshotContent,
  useSnapshotPdf,
  viewPath,
  type ViewState,
} from './useSnapshot.ts';

const VIEW_NAMES: Record<SnapshotView, string> = { list: 'List', timeline: 'Timeline' };

export const PDF_PREPARING = 'Preparing the PDF…';
export const PDF_FAILED = "Couldn't create the PDF. Try again.";
export const PDF_BUSY = 'Other PDFs are being prepared. Try again in a minute.';

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
  /** "Download PDF", beside the views. */
  download: ReactNode;
}

/** The roadmap's name as the page heading, the "as of" date, and the two views. */
function SnapshotHeader({ linkId, content, view, search, focusHeading, download }: SnapshotHeaderProps) {
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
      {download}
    </header>
  );
}

/** `/s/:linkId/list` and `/s/:linkId/timeline`: a snapshot's header and one of its two views. */
export function SnapshotLayout({ view }: { view: SnapshotView }) {
  const { linkId = '' } = useParams();
  const location = useLocation();
  const content = useSnapshotContent(linkId);
  const pdf = useSnapshotPdf(linkId);
  // A press while one is under way asks for nothing: the state that disables the button lags a render behind.
  const asking = useRef(false);
  const leavingForContent = useReturnToGate(linkId, content.error);
  const leavingForPdf = useReturnToGate(linkId, pdf.error);
  const leaving = leavingForContent || leavingForPdf;
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
  // Revoked or expired since the page loaded: the PDF answer says so.
  const pdfProblem = linkProblemOf(pdf.error);
  if (pdfProblem) return <LinkProblem kind={pdfProblem} />;
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
  const download = () => {
    if (asking.current) return;
    asking.current = true;
    pdf.mutate(view, {
      onSettled: () => {
        asking.current = false;
      },
    });
  };
  return (
    <ViewerPage>
      <SnapshotHeader
        linkId={linkId}
        content={content.data}
        view={view}
        search={location.search}
        focusHeading={unlocked}
        download={
          // aria-disabled rather than disabled, so the button keeps focus while the PDF is made.
          <Button className="snapshot-pdf" aria-disabled={pdf.isPending || undefined} onClick={download}>
            Download PDF
          </Button>
        }
      />
      {/* Always on the page, so the words are announced when they appear. */}
      <p role="status" className="snapshot-pdf-status">
        {pdf.isPending ? PDF_PREPARING : ''}
      </p>
      {pdf.isError && (
        <div className="snapshot-pdf-status">
          <Alert>
            <p>{pdf.error instanceof ApiError && pdf.error.code === 'pdf_busy' ? PDF_BUSY : PDF_FAILED}</p>
          </Alert>
        </div>
      )}
      <main>{view === 'list' ? <SnapshotList linkId={linkId} content={content.data} /> : <SnapshotTimeline content={content.data} />}</main>
    </ViewerPage>
  );
}

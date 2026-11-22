import type { SnapshotContent, SnapshotView } from '@roadmap/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.ts';
import { formatDay } from '../projects/names.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { LinkProblem, linkProblemOf, LoadFailed, ReportLinkProblem, type LinkProblemKind } from './SnapshotGate.tsx';
import { SnapshotList, toggled, type Branches } from './SnapshotList.tsx';
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
export const PDF_TOO_LARGE = 'This snapshot is too large for a PDF. You can still read it here.';

/** The message beside "Download PDF" for a refusal: busy, too large, or anything else. */
function pdfMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code === 'pdf_busy') return PDF_BUSY;
  if (code === 'pdf_too_large') return PDF_TOO_LARGE;
  return PDF_FAILED;
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
  // Kept here, above both views, so a branch collapsed on the List is collapsed on the Timeline too, as in the app.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((itemId: string) => setCollapsed((c) => toggled(c, itemId)), []);
  const branches: Branches = useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);
  // Set by a part that found the link revoked or expired (an item's notes); the whole page becomes the card.
  const [partProblem, setPartProblem] = useState<LinkProblemKind | null>(null);

  if (content.isPending || leaving) {
    return (
      <ViewerPage>
        <main>
          <p role="status">Loading</p>
        </main>
      </ViewerPage>
    );
  }
  // Revoked or expired since the page loaded: the PDF answer or an item's notes say so.
  const linkProblem = linkProblemOf(pdf.error) ?? partProblem;
  if (linkProblem) return <LinkProblem kind={linkProblem} />;
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
            <p>{pdfMessage(pdf.error)}</p>
          </Alert>
        </div>
      )}
      <main>
        <ReportLinkProblem.Provider value={setPartProblem}>
          {view === 'list' ? (
            <SnapshotList linkId={linkId} content={content.data} branches={branches} />
          ) : (
            <SnapshotTimeline content={content.data} branches={branches} />
          )}
        </ReportLinkProblem.Provider>
      </main>
    </ViewerPage>
  );
}

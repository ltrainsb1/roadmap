import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.ts';
import { errorCode, GENERIC_ERROR, messageFor } from '../api/errors.ts';
import { Alert } from '../ui/Alert.tsx';
import { Button } from '../ui/Button.tsx';
import { Field } from '../ui/Field.tsx';
import { gatePath, useSnapshotStatus, useUnlock, viewPath, type GateState, type ViewState } from './useSnapshot.ts';

const SESSION_ENDED = 'Enter the password again to keep viewing.';
const NO_PASSWORD = 'Enter the password.';

/** The narrow, centred card the password page and the link problems sit in. No app header, no navigation. */
export function ViewerCard({ children }: { children: ReactNode }) {
  return (
    <main className="page page-narrow">
      <div className="viewer-card">{children}</div>
    </main>
  );
}

export type LinkProblemKind = 'not_found' | 'expired';

/** The card for a link that does not work, with no field and nothing about the roadmap. */
export function LinkProblem({ kind }: { kind: LinkProblemKind }) {
  return (
    <ViewerCard>
      {kind === 'expired' ? (
        <>
          <h1>This link has expired</h1>
          <p>Ask the person who sent it for a new link.</p>
        </>
      ) : (
        <>
          <h1>This link doesn't work</h1>
          <p>The snapshot may have been removed. Ask the person who sent it for a new link.</p>
        </>
      )}
    </ViewerCard>
  );
}

/** Which card a refusal stands for: a 404 or a 410; anything else is not about the link. */
export function linkProblemOf(err: unknown): LinkProblemKind | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === 404) return 'not_found';
  if (err.status === 410) return 'expired';
  return null;
}

/** A generic failure with a way to try again. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert>
      <p>{GENERIC_ERROR}</p>
      <Button onClick={onRetry}>Try again</Button>
    </Alert>
  );
}

/** Any other address under a snapshot's link goes to its password page. */
export function ToSnapshotGate() {
  const { linkId = '' } = useParams();
  return <Navigate to={gatePath(linkId)} replace />;
}

/**
 * `/s/:linkId`: the password page, the not-found and expired cards, or straight on to the list when this browser
 * already holds a session for the link.
 */
export function SnapshotGate() {
  const { linkId = '' } = useParams();
  const navigate = useNavigate();
  const state = useLocation().state as GateState | null;
  const status = useSnapshotStatus(linkId);
  const unlock = useUnlock(linkId);
  const field = useRef<HTMLInputElement>(null);
  // A ref, not `isPending`: a double press is quicker than the mutation's state reaches the render.
  const busy = useRef(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [failedAt, setFailedAt] = useState(0);
  const [problem, setProblem] = useState<LinkProblemKind | null>(null);

  // After every refused submit the field has focus, ready for another try.
  useEffect(() => {
    if (failedAt > 0) field.current?.focus();
  }, [failedAt]);

  const fail = (message: string) => {
    setError(message);
    setFailedAt((n) => n + 1);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy.current) return;
    if (password === '') return fail(NO_PASSWORD);
    busy.current = true;
    try {
      await unlock.mutateAsync(password);
      const home = gatePath(linkId);
      const back = state?.from?.startsWith(`${home}/`) ? state.from : viewPath(linkId, 'list');
      const next: ViewState = { unlocked: true };
      void navigate(back, { replace: true, state: next });
    } catch (err) {
      const kind = linkProblemOf(err);
      if (kind) setProblem(kind);
      else fail(errorCode(err) === 'validation' ? NO_PASSWORD : messageFor(err));
    } finally {
      // The mutation keeps what it sent; the field's own state is all a retry needs.
      unlock.reset();
      busy.current = false;
    }
  };

  if (problem) return <LinkProblem kind={problem} />;
  if (status.isPending) {
    return (
      <ViewerCard>
        <p role="status">Loading</p>
      </ViewerCard>
    );
  }
  if (status.isError) {
    const kind = linkProblemOf(status.error);
    if (kind) return <LinkProblem kind={kind} />;
    return (
      <ViewerCard>
        <LoadFailed onRetry={() => void status.refetch()} />
      </ViewerCard>
    );
  }
  if (status.data.unlocked) return <Navigate to={viewPath(linkId, 'list')} replace />;

  const notice = error ?? (state?.sessionEnded ? SESSION_ENDED : undefined);
  return (
    <ViewerCard>
      <h1>This snapshot is password protected</h1>
      <p>Enter the password you were given.</p>
      {notice && (
        // A new element for each refusal, so the same message twice is announced twice.
        <Alert key={failedAt} tone={error ? 'error' : 'info'}>
          {notice}
        </Alert>
      )}
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field
          ref={field}
          id="snapshot-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" className="btn-block">
          View snapshot
        </Button>
      </form>
      <p className="viewer-help">If you don't have the password, ask the person who sent you the link.</p>
    </ViewerCard>
  );
}

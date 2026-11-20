import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { errorCode, GENERIC_ERROR } from '../api/errors.ts';
import { Layout } from '../ui/Layout.tsx';
import { useMe } from './useMe.ts';

/**
 * Shows its children to a signed-in person. A 401 from `/api/me` sends them to the sign-in screen
 * through the API client, so this only has to wait. A 403 `mfa_required` means a sign-in was started and
 * not finished (the password step passed, the second step did not): that person starts sign-in again.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isSuccess) return <>{children}</>;
  // Not while refetching: after the second step the cached answer is still the old refusal until the new one lands.
  if (me.isError && !me.isFetching && errorCode(me.error) === 'mfa_required') {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (me.isError && (me.error as { status?: number }).status !== 401) {
    return (
      <Layout>
        <h1>Roadmaps</h1>
        <p role="alert">{GENERIC_ERROR}</p>
      </Layout>
    );
  }
  return (
    <Layout>
      <p role="status">Loading</p>
    </Layout>
  );
}

import type { ReactNode } from 'react';
import { GENERIC_ERROR } from '../api/errors.ts';
import { Layout } from '../ui/Layout.tsx';
import { useMe } from './useMe.ts';

/**
 * Shows its children to a signed-in person. A 401 from `/api/me` sends them to the sign-in screen
 * through the API client, so this only has to wait.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isSuccess) return <>{children}</>;
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

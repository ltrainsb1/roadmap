import type { QueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from '../api/client.ts';

/** Ends this session (or all of them) and forgets everything the app cached about the person. */
export async function signOut(queryClient: QueryClient, everywhere = false): Promise<void> {
  await api(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST' });
  setCsrfToken(null);
  queryClient.clear();
}

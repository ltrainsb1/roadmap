import type { MeResponse } from '@roadmap/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const ME_KEY = ['me'] as const;

/** The signed-in person. Reading it also stores the session's CSRF token for later writes. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<MeResponse>('/api/me'),
    retry: false,
    staleTime: 60_000,
  });
}

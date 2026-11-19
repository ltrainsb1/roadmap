import type { MembersResponse } from '@roadmap/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const MEMBERS_KEY = (roadmapId: string) => ['members', roadmapId] as const;

/** The roadmap's members and pending invites. */
export function useMembers(roadmapId: string) {
  return useQuery({
    queryKey: MEMBERS_KEY(roadmapId),
    queryFn: () => api<MembersResponse>(`/api/roadmaps/${encodeURIComponent(roadmapId)}/members`),
  });
}

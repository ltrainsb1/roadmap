import type { RoadmapListResponse } from '@roadmap/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const ROADMAPS_KEY = ['roadmaps'] as const;

/** The roadmaps the signed-in person belongs to, by name. */
export function useRoadmaps() {
  return useQuery({
    queryKey: ROADMAPS_KEY,
    queryFn: () => api<RoadmapListResponse>('/api/roadmaps'),
  });
}

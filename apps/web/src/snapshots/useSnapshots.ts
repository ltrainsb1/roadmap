import type { CreateSnapshotRequest, SnapshotSummary } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const SNAPSHOTS_KEY = (roadmapId: string) => ['snapshots', roadmapId] as const;

type SnapshotList = { snapshots: SnapshotSummary[] };

const base = (roadmapId: string) => `/api/roadmaps/${encodeURIComponent(roadmapId)}/snapshots`;

/** The roadmap's snapshots, newest first. Owners and Admins only. */
export function useSnapshots(roadmapId: string) {
  return useQuery({ queryKey: SNAPSHOTS_KEY(roadmapId), queryFn: () => api<SnapshotList>(base(roadmapId)) });
}

/** Freezes the roadmap into a new snapshot, then refreshes the list. */
export function useCreateSnapshot(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSnapshotRequest) => api<{ id: string; linkId: string }>(base(roadmapId), { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY(roadmapId) }),
  });
}

/** Deletes a snapshot. It leaves the cached list at once, so focus can move before the refetch is back. */
export function useRevokeSnapshot(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => api<void>(`${base(roadmapId)}/${encodeURIComponent(snapshotId)}`, { method: 'DELETE' }),
    onSuccess: (_data, snapshotId) => {
      queryClient.setQueryData<SnapshotList>(SNAPSHOTS_KEY(roadmapId), (list) =>
        list && { snapshots: list.snapshots.filter((s) => s.id !== snapshotId) },
      );
      void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY(roadmapId) });
    },
  });
}

/** The address a stakeholder opens. */
export const snapshotUrl = (linkId: string): string => `${window.location.origin}/s/${linkId}`;

/** The ISO instant of 23:59:59.999 on a `YYYY-MM-DD` day in the browser's own zone: when a link set to expire that day stops working. */
export function endOfLocalDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

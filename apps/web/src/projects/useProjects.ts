import type { CreateProjectRequest, PriorityLabel, Project, ProjectList, UpdateProjectRequest } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../api/client.ts';

export const PROJECTS_KEY = (roadmapId: string) => ['projects', roadmapId] as const;

const base = (roadmapId: string) => `/api/roadmaps/${encodeURIComponent(roadmapId)}/projects`;

/** Every item of the roadmap, archived ones included, and the same items by id. */
export function useProjects(roadmapId: string) {
  const query = useQuery({
    queryKey: PROJECTS_KEY(roadmapId),
    queryFn: () => api<ProjectList>(base(roadmapId)),
  });
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const byId = useMemo(() => new Map<string, Project>(items.map((item) => [item.id, item])), [items]);
  return { ...query, items, byId };
}

/** Adds an item last under `parentId` (null for a top-level project), then refreshes the list. */
export function useCreateProject(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api<{ id: string }>(base(roadmapId), { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) }),
  });
}

const putItemInCache = (queryClient: QueryClient, roadmapId: string, updated: Project) =>
  queryClient.setQueryData<ProjectList>(PROJECTS_KEY(roadmapId), (list) =>
    list && { ...list, items: list.items.map((item) => (item.id === updated.id ? updated : item)) },
  );

/** Saves edits to one item with the `version` they were made on, and puts the returned item in the cached list. */
export function useUpdateProject(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: UpdateProjectRequest }) =>
      api<Project>(`${base(roadmapId)}/${encodeURIComponent(projectId)}`, { method: 'PATCH', body }),
    onSuccess: (updated) => putItemInCache(queryClient, roadmapId, updated),
  });
}

/** Replaces who is assigned to an item (members only); the returned item goes in the cached list and the list is refetched. */
export function useSetAssignees(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, userIds }: { projectId: string; userIds: string[] }) =>
      api<Project>(`${base(roadmapId)}/${encodeURIComponent(projectId)}/assignees`, { method: 'PUT', body: { userIds } }),
    onSuccess: (updated) => {
      putItemInCache(queryClient, roadmapId, updated);
      return queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) });
    },
  });
}

/** Sets or clears an item's P1 to P4 label. */
export function useSetPriorityLabel(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, label }: { projectId: string; label: PriorityLabel | null }) =>
      api<Project>(`${base(roadmapId)}/${encodeURIComponent(projectId)}/priority-label`, { method: 'PUT', body: { label } }),
    onSuccess: (updated) => {
      putItemInCache(queryClient, roadmapId, updated);
      return queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) });
    },
  });
}

/**
 * Saves the order of the non-archived items under `parentId`. The cached order changes first so a drop does not
 * snap back while the request runs; a refused request puts the old order back, and the list is refetched either way.
 */
export function useReorder(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { parentId: string | null; orderedIds: string[] }) =>
      api<void>(`${base(roadmapId)}/order`, { method: 'PUT', body }),
    onMutate: async ({ orderedIds }) => {
      await queryClient.cancelQueries({ queryKey: PROJECTS_KEY(roadmapId) });
      const previous = queryClient.getQueryData<ProjectList>(PROJECTS_KEY(roadmapId));
      const rankOf = new Map(orderedIds.map((id, index) => [id, index]));
      queryClient.setQueryData<ProjectList>(
        PROJECTS_KEY(roadmapId),
        (list) => list && { ...list, items: list.items.map((item) => (rankOf.has(item.id) ? { ...item, rank: rankOf.get(item.id)! } : item)) },
      );
      return { previous };
    },
    onError: (_err, _body, context) => {
      if (context?.previous) queryClient.setQueryData(PROJECTS_KEY(roadmapId), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) }),
  });
}

/** Hides an item and everything under it; Unarchive brings them back. */
export function useArchive(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api<void>(`${base(roadmapId)}/${encodeURIComponent(projectId)}/archive`, { method: 'POST' }),
    // Not awaited: the caller moves on at once, and the refetch lands on its own.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) }),
  });
}

export function useUnarchive(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api<void>(`${base(roadmapId)}/${encodeURIComponent(projectId)}/unarchive`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) }),
  });
}

/** Deletes an item and everything under it for good. */
export function useDeleteProject(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api<{ deleted: number }>(`${base(roadmapId)}/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY(roadmapId) }),
  });
}

/** Whether the person is assigned to the item or to something above it; the server makes the real decision. */
export function isAssigned(item: Project, myId: string | undefined, byId: ReadonlyMap<string, Project>): boolean {
  return myId !== undefined && [item, ...item.path.map((id) => byId.get(id))].some((i) => i?.assigneeIds.includes(myId));
}

import type { CreateProjectRequest, Project, ProjectList, UpdateProjectRequest } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Saves edits to one item with the `version` they were made on, and puts the returned item in the cached list. */
export function useUpdateProject(roadmapId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: UpdateProjectRequest }) =>
      api<Project>(`${base(roadmapId)}/${encodeURIComponent(projectId)}`, { method: 'PATCH', body }),
    onSuccess: (updated) =>
      queryClient.setQueryData<ProjectList>(PROJECTS_KEY(roadmapId), (list) =>
        list && { ...list, items: list.items.map((item) => (item.id === updated.id ? updated : item)) },
      ),
  });
}

/** Whether the person is assigned to the item or to something above it; the server makes the real decision. */
export function isAssigned(item: Project, myId: string | undefined, byId: ReadonlyMap<string, Project>): boolean {
  return myId !== undefined && [item, ...item.path.map((id) => byId.get(id))].some((i) => i?.assigneeIds.includes(myId));
}

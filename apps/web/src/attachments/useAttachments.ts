import type { Attachment, AttachmentList, DownloadLink } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, upload } from '../api/client.ts';

export const ATTACHMENTS_KEY = (roadmapId: string, projectId: string) => ['attachments', roadmapId, projectId] as const;

const base = (roadmapId: string, projectId: string) =>
  `/api/roadmaps/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(projectId)}/attachments`;

/** The files on one item, oldest first. */
export function useAttachments(roadmapId: string, projectId: string) {
  return useQuery({
    queryKey: ATTACHMENTS_KEY(roadmapId, projectId),
    queryFn: () => api<AttachmentList>(base(roadmapId, projectId)),
    // One quick retry, so a failed load says so soon.
    retry: 1,
  });
}

/** Uploads one file; the new file goes at the end of the cached list. */
export function useUploadAttachment(roadmapId: string, projectId: string) {
  const queryClient = useQueryClient();
  const key = ATTACHMENTS_KEY(roadmapId, projectId);
  return useMutation({
    mutationFn: (file: File) => upload<Attachment>(base(roadmapId, projectId), file),
    onSuccess: (added) => {
      queryClient.setQueryData<AttachmentList>(key, (list) => list && { attachments: [...list.attachments, added] });
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** Removes a file; it leaves the cached list. */
export function useDeleteAttachment(roadmapId: string, projectId: string) {
  const queryClient = useQueryClient();
  const key = ATTACHMENTS_KEY(roadmapId, projectId);
  return useMutation({
    mutationFn: (id: string) => api<void>(`${base(roadmapId, projectId)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_done, id) => {
      queryClient.setQueryData<AttachmentList>(key, (list) => list && { attachments: list.attachments.filter((a) => a.id !== id) });
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Asks for a short-lived link to the file, then goes to it. The file is sent as an attachment, so the browser
 * saves it and the page stays where it is, with anything typed still in place.
 */
export async function downloadAttachment(roadmapId: string, projectId: string, id: string): Promise<void> {
  const { url } = await api<DownloadLink>(`${base(roadmapId, projectId)}/${encodeURIComponent(id)}/download`);
  window.location.assign(url);
}

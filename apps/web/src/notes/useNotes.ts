import type { CreateNoteBody, Note, NoteBody, NoteList } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const NOTES_KEY = (roadmapId: string, projectId: string) => ['notes', roadmapId, projectId] as const;

const base = (roadmapId: string, projectId: string) =>
  `/api/roadmaps/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(projectId)}/notes`;

/** Every note on one item, oldest first, replies included. */
export function useNotes(roadmapId: string, projectId: string) {
  return useQuery({
    queryKey: NOTES_KEY(roadmapId, projectId),
    queryFn: () => api<NoteList>(base(roadmapId, projectId)),
    // One quick retry, so a failed load says so soon.
    retry: 1,
  });
}

/** Adds a note, or a reply when `parentId` is a top-level note's id; the new note goes in the cached list. */
export function useAddNote(roadmapId: string, projectId: string) {
  const queryClient = useQueryClient();
  const key = NOTES_KEY(roadmapId, projectId);
  return useMutation({
    mutationFn: (body: CreateNoteBody) => api<Note>(base(roadmapId, projectId), { body }),
    onSuccess: (added) => {
      queryClient.setQueryData<NoteList>(key, (list) => list && { notes: [...list.notes, added] });
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** Changes the text of one of my notes; the saved note replaces it in the cached list. */
export function useEditNote(roadmapId: string, projectId: string) {
  const queryClient = useQueryClient();
  const key = NOTES_KEY(roadmapId, projectId);
  return useMutation({
    mutationFn: ({ noteId, body }: { noteId: string; body: NoteBody }) =>
      api<Note>(`${base(roadmapId, projectId)}/${encodeURIComponent(noteId)}`, { method: 'PATCH', body }),
    onSuccess: (saved) => {
      queryClient.setQueryData<NoteList>(key, (list) => list && { notes: list.notes.map((n) => (n.id === saved.id ? saved : n)) });
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * What the list holds once `noteId` is deleted, as the server does it: a reply or a note without replies goes; a
 * note with replies stays as a placeholder; a placeholder whose last reply goes, goes too.
 */
export function withoutNote(notes: readonly Note[], noteId: string): Note[] {
  const target = notes.find((n) => n.id === noteId);
  if (!target) return [...notes];
  const replies = (id: string) => notes.filter((n) => n.parentId === id && n.id !== noteId).length;
  if (target.parentId === null && replies(target.id) > 0) {
    return notes.map((n) => (n.id === noteId ? { ...n, body: '', mentions: [], deleted: true } : n));
  }
  const parent = target.parentId === null ? undefined : notes.find((n) => n.id === target.parentId);
  const dropParent = parent?.deleted === true && replies(parent.id) === 0;
  return notes.filter((n) => n.id !== noteId && !(dropParent && n.id === parent.id));
}

/** Deletes a note; the cached list changes as the server's did. */
export function useDeleteNote(roadmapId: string, projectId: string) {
  const queryClient = useQueryClient();
  const key = NOTES_KEY(roadmapId, projectId);
  return useMutation({
    mutationFn: (noteId: string) => api<void>(`${base(roadmapId, projectId)}/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
    onSuccess: (_done, noteId) => {
      queryClient.setQueryData<NoteList>(key, (list) => list && { notes: withoutNote(list.notes, noteId) });
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

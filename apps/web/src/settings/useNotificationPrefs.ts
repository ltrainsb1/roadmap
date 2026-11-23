import type { NotificationPrefs, PrefsResponse } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const PREFS_KEY = ['me', 'notification-prefs'] as const;
const PATH = '/api/me/notification-prefs';

/** The signed-in person's email setting for each kind of notification, and their time zone. */
export function useNotificationPrefs() {
  return useQuery({ queryKey: PREFS_KEY, queryFn: () => api<PrefsResponse>(PATH) });
}

/** Saves all four settings at once; the answer becomes the cached settings. */
export function useSaveNotificationPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: NotificationPrefs) => api<PrefsResponse>(PATH, { method: 'PUT', body: prefs }),
    onSuccess: (data) => queryClient.setQueryData(PREFS_KEY, data),
  });
}

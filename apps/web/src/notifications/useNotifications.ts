import type { NotificationPage, UnreadCount } from '@roadmap/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const UNREAD_KEY = ['notifications', 'unread'] as const;
export const NOTIFICATIONS_KEY = ['notifications', 'list'] as const;

/**
 * The signed-in person's unread count, asked for again every 60 seconds and when the window is shown again. Quiet, so
 * a poll that lands after the session ended never sends anyone to sign in; the poll stops when the bell unmounts.
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_KEY,
    queryFn: () => api<UnreadCount>('/api/notifications/unread-count', { quiet: true }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** The person's notifications, newest first, 30 a page, by cursor. */
export function useNotifications() {
  return useInfiniteQuery({
    queryKey: NOTIFICATIONS_KEY,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<NotificationPage>(pageParam ? `/api/notifications?cursor=${encodeURIComponent(pageParam)}` : '/api/notifications'),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const refresh = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: UNREAD_KEY }),
    queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  ]);

/** Marks one notification read. The list and the count are asked for again however it ends. */
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    onSettled: () => refresh(queryClient),
  });
}

/** Marks every notification read. The cache shows it at once, so the button goes before the refetch is back. */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.setQueryData<UnreadCount>(UNREAD_KEY, { unread: 0 });
      queryClient.setQueryData<InfiniteData<NotificationPage>>(NOTIFICATIONS_KEY, (data) =>
        data && {
          ...data,
          pages: data.pages.map((p) => ({ ...p, unread: 0, items: p.items.map((n) => ({ ...n, read: true })) })),
        },
      );
      void refresh(queryClient);
    },
  });
}

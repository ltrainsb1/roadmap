import type { FeedChoices, FeedLink, FeedState } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const CALENDAR_FEED_KEY = ['me', 'calendar-feed'] as const;
const PATH = '/api/me/calendar-feed';

/** The signed-in person's calendar feed, or `{ feed: null }`; never its link, which only creating or a new link returns. */
export function useCalendarFeed() {
  return useQuery({ queryKey: CALENDAR_FEED_KEY, queryFn: () => api<FeedState>(PATH) });
}

/**
 * Each change's answer becomes the cached feed. A failure refetches it, since the usual cause is a change made in
 * another tab (a feed already made, or one turned off).
 */
function useFeedMutation<Out extends FeedState | undefined, In = void>(send: (input: In) => Promise<Out>, after: (out: Out) => FeedState) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (out) => queryClient.setQueryData<FeedState>(CALENDAR_FEED_KEY, after(out)),
    onError: () => queryClient.invalidateQueries({ queryKey: CALENDAR_FEED_KEY }),
  });
}

/** Only the state goes into the cache: the URL stays with the screen that asked for it. */
const stateOf = ({ feed }: FeedState): FeedState => ({ feed });

export function useCreateFeed() {
  return useFeedMutation(() => api<FeedLink>(PATH, { method: 'POST' }), stateOf);
}

export function useSaveFeedChoices() {
  return useFeedMutation((choices: FeedChoices) => api<FeedState>(`${PATH}/choices`, { method: 'PUT', body: choices }), stateOf);
}

export function useNewFeedLink() {
  return useFeedMutation(() => api<FeedLink>(`${PATH}/new-link`, { method: 'POST' }), stateOf);
}

export function useTurnOffFeed() {
  return useFeedMutation(
    () => api<undefined>(PATH, { method: 'DELETE' }),
    (): FeedState => ({ feed: null }),
  );
}

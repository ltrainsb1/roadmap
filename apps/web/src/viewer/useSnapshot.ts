import type { SnapshotContent, SnapshotNote } from '@roadmap/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.ts';

/**
 * The calls a stakeholder's browser makes. Every one is quiet: the viewer has no account, so a 401 means the
 * snapshot's own session ended, never "go and sign in".
 */

const base = (linkId: string) => `/api/snapshots/${encodeURIComponent(linkId)}`;

export const SNAPSHOT_KEY = (linkId: string) => ['snapshot', linkId] as const;

/** The password page of a snapshot. */
export const gatePath = (linkId: string): string => `/s/${encodeURIComponent(linkId)}`;
export const viewPath = (linkId: string, view: 'list' | 'timeline'): string => `${gatePath(linkId)}/${view}`;

/** What a view hands the password page when it sends someone back to it. */
export interface GateState {
  /** The snapshot's session ended while it was showing. */
  sessionEnded?: boolean;
  /** The view to go back to once the password is accepted, with its query string. */
  from?: string;
}

/** What the password page hands a view after a correct password: the view's heading takes focus. */
export interface ViewState {
  unlocked?: boolean;
}

/** Whether the link exists, has not expired, and this browser already holds a session for it. Never cached. */
export function useSnapshotStatus(linkId: string) {
  return useQuery({
    queryKey: [...SNAPSHOT_KEY(linkId), 'status'],
    queryFn: () => api<{ unlocked: boolean }>(base(linkId), { quiet: true }),
    retry: false,
    // An old answer saying "unlocked" would send someone whose session just ended straight back to the view.
    gcTime: 0,
  });
}

/** Sends the password. Reset it after it settles, so the password is not kept in the mutation cache. */
export function useUnlock(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api<void>(`${base(linkId)}/unlock`, { body: { password }, quiet: true }),
    gcTime: 0,
    onSuccess: () =>
      // A content or notes answer from before (a 401) must not be shown again.
      queryClient.removeQueries({ queryKey: SNAPSHOT_KEY(linkId), predicate: (q) => q.queryKey[2] !== 'status' }),
  });
}

/** The frozen roadmap. It never changes, so it is fetched once per page load. */
export function useSnapshotContent(linkId: string, opts: { allNotes?: boolean } = {}) {
  const all = opts.allNotes === true;
  return useQuery({
    queryKey: [...SNAPSHOT_KEY(linkId), 'content', all ? 'all' : 'items'],
    queryFn: () => api<SnapshotContent>(`${base(linkId)}/content${all ? '?notes=all' : ''}`, { quiet: true }),
    retry: false,
    staleTime: Infinity,
  });
}

/** One item's frozen notes, oldest first, fetched the first time `enabled` is true and kept. */
export function useSnapshotNotes(linkId: string, itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...SNAPSHOT_KEY(linkId), 'notes', itemId],
    queryFn: () => api<{ notes: SnapshotNote[] }>(`${base(linkId)}/items/${encodeURIComponent(itemId)}/notes`, { quiet: true }),
    enabled,
    retry: false,
    staleTime: Infinity,
  });
}

/** Whether `err` says the snapshot's session has ended. */
export const sessionEnded = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

/**
 * When `err` says the session ended, sends the person to the password page, which asks for the password again and
 * then brings them back here. Returns whether it is doing so.
 */
export function useReturnToGate(linkId: string, err: unknown): boolean {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const ended = sessionEnded(err);
  useEffect(() => {
    if (!ended) return;
    const state: GateState = { sessionEnded: true, from: pathname + search };
    void navigate(gatePath(linkId), { replace: true, state });
  }, [ended, linkId, navigate, pathname, search]);
  return ended;
}

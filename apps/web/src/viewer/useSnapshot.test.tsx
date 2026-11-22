import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setUnauthorizedHandler } from '../api/client.ts';
import { useSnapshotContent, useSnapshotNotes, useSnapshotStatus, useUnlock } from './useSnapshot.ts';

const onUnauthorized = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  onUnauthorized.mockReset();
  setUnauthorizedHandler(onUnauthorized);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: 'password_required' }), { status: 401 })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

test('FR-3.2: a 401 from any viewer call never sends anyone to the sign-in page', async () => {
  const status = renderHook(() => useSnapshotStatus('abc'), { wrapper });
  const contentAll = renderHook(() => useSnapshotContent('abc', { allNotes: true }), { wrapper });
  const notes = renderHook(() => useSnapshotNotes('abc', 'item 1', true), { wrapper });
  const unlock = renderHook(() => useUnlock('abc'), { wrapper });
  await expect(unlock.result.current.mutateAsync('pw')).rejects.toMatchObject({ status: 401 });
  await waitFor(() => {
    expect(status.result.current.isError).toBe(true);
    expect(contentAll.result.current.isError).toBe(true);
    expect(notes.result.current.isError).toBe(true);
  });
  expect(fetchMock.mock.calls.map(([path]) => path as string).sort()).toEqual([
    '/api/snapshots/abc',
    '/api/snapshots/abc/content?notes=all',
    '/api/snapshots/abc/items/item%201/notes',
    '/api/snapshots/abc/unlock',
  ]);
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test('FR-3.5: notes are not asked for until enabled', () => {
  renderHook(() => useSnapshotNotes('abc', 'p1', false), { wrapper });
  expect(fetchMock).not.toHaveBeenCalled();
});

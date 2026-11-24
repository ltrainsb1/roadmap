import type { Project, Role } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { useMembers } from '../members/useMembers.ts';
import { useItemActions } from './useItemActions.tsx';
import type { useProjects } from './useProjects.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  parentId: null,
  depth: 1,
  path: [],
  title: 'Launch site',
  description: '',
  status: 'not_started',
  startDate: null,
  endDate: null,
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  assigneeIds: [],
  rank: 1,
  priorityLabel: null,
  archived: false,
  version: 1,
  updatedAt: '2027-01-01T00:00:00.000Z',
  ...over,
});

function renderActions(role: Role, target: Project, myId = 'me') {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  const projects = { items: [target], byId: new Map([[target.id, target]]) } as unknown as ReturnType<typeof useProjects>;
  const members = {} as ReturnType<typeof useMembers>;
  const { result } = renderHook(
    () => useItemActions({ roadmapId: 'r1', role, myId, basePath: '/r/r1/projects', search: '', projectId: undefined, projects, members }),
    { wrapper },
  );
  return result;
}

const menuLabels = (role: Role, target: Project, myId = 'me') => renderActions(role, target, myId).current.menuFor(target).map((entry) => entry.label);

describe('useItemActions menuFor', () => {
  test('offers Open, Archive and Delete to someone who may delete the item', () => {
    expect(menuLabels('owner', item())).toEqual(['Open', 'Archive', 'Delete']);
  });

  test('offers Unarchive in place of Archive for an archived item', () => {
    expect(menuLabels('owner', item({ archived: true }))).toEqual(['Open', 'Unarchive', 'Delete']);
  });

  test('offers only Open to someone who may not delete the item', () => {
    expect(menuLabels('contributor', item())).toEqual(['Open']);
  });

  test('offers the full menu to a contributor assigned to the item', () => {
    expect(menuLabels('contributor', item({ assigneeIds: ['me'] }))).toEqual(['Open', 'Archive', 'Delete']);
  });
});

describe('useItemActions Add to calendar', () => {
  test('FR-4.5: the Actions menu and the panel offer "Add to calendar" only for items with a date or a milestone', () => {
    expect(menuLabels('contributor', item())).toEqual(['Open']);
    expect(menuLabels('contributor', item({ startDate: '2027-03-03' }))).toEqual(['Open', 'Add to calendar']);
    expect(menuLabels('contributor', item({ endDate: '2027-04-28' }))).toEqual(['Open', 'Add to calendar']);
    expect(menuLabels('owner', item({ milestones: [{ id: 'm1', name: 'Beta', date: '2027-03-20' }] }))).toEqual(['Open', 'Add to calendar', 'Archive', 'Delete']);
    expect(menuLabels('owner', item({ startDate: '2027-03-03', archived: true }))).toEqual(['Open', 'Unarchive', 'Delete']);
  });

  test('FR-4.5: a failed download shows its message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"no_dates"}', { status: 422 })));
    const target = item({ startDate: '2027-03-03' });
    const result = renderActions('contributor', target);
    const entry = result.current.menuFor(target).find((e) => e.label === 'Add to calendar');
    act(() => entry?.onSelect());
    await waitFor(() => expect(result.current.actionError).toBe("Couldn't download the calendar file. Try again."));
  });
});

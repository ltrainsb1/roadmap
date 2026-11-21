import type { Project, Role } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import type { useMembers } from '../members/useMembers.ts';
import { useItemActions } from './useItemActions.tsx';
import type { useProjects } from './useProjects.ts';

afterEach(cleanup);

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

function menuLabels(role: Role, target: Project, myId = 'me') {
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
  return result.current.menuFor(target).map((entry) => entry.label);
}

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

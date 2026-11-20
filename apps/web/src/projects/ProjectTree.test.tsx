import type { Project } from '@roadmap/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectTree } from './ProjectTree.tsx';

afterEach(cleanup);

const item = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  parentId: null,
  depth: 1,
  path: [],
  title: `Item ${id}`,
  description: '',
  status: 'not_started',
  startDate: null,
  endDate: null,
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  assigneeIds: [],
  rank: Number(id),
  priorityLabel: null,
  archived: false,
  version: 1,
  updatedAt: '2027-01-01T00:00:00.000Z',
  ...over,
});

function renderTree(items: Project[], role: 'owner' | 'contributor' = 'owner') {
  const handlers = { onReorder: vi.fn(), onArchive: vi.fn(), onUnarchive: vi.fn(), onDelete: vi.fn() };
  render(
    <MemoryRouter>
      <ProjectTree
        roadmapId="r1"
        role={role}
        myId="me"
        items={items}
        byId={new Map(items.map((i) => [i.id, i]))}
        memberNames={new Map()}
        selectedId={undefined}
        collapsed={new Set()}
        onToggle={() => undefined}
        adding={null}
        onStartAdd={() => undefined}
        onAdd={() => Promise.resolve()}
        onCancelAdd={() => undefined}
        onChangeStatus={() => undefined}
        onOpen={() => undefined}
        {...handlers}
      />
    </MemoryRouter>,
  );
  return handlers;
}

const menuNames = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

describe('row menu', () => {
  test('FR-1.3: an archived row offers Unarchive in place of Archive, and no move or add items', () => {
    const handlers = renderTree([item('1', { archived: true }), item('2')]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Item 1' }));
    expect(menuNames()).toEqual(['Open', 'Unarchive', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }));
    expect(handlers.onUnarchive).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
    expect(screen.queryByRole('button', { name: 'Reorder Item 1' })).toBeNull();
  });

  test('FR-1.3: Move up and Move down are disabled at the ends and reorder the whole sibling group otherwise', () => {
    const handlers = renderTree([item('1'), item('2'), item('3')]);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Item 1' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(handlers.onReorder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(handlers.onReorder).toHaveBeenCalledWith(null, ['2', '1', '3'], 'Moved Item 1 to position 2 of 3.');
  });

  test('FR-1.3: a Contributor assigned to an item gets Archive and Delete but no drag handle or Move items', () => {
    renderTree([item('1', { assigneeIds: ['me'] })], 'contributor');
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Item 1' }));
    expect(menuNames()).toEqual(['Open', 'Add sub-project', 'Archive', 'Delete']);
  });
});

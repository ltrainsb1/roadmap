import type { Project } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProjectPanel } from './ProjectPanel.tsx';

beforeEach(() => {
  // The files and notes sections ask for their lists; they never answer here.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
});
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

function renderPanel(target: Project) {
  const onAddToCalendar = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ProjectPanel
          roadmapId="r1"
          role="contributor"
          myId="me"
          item={target}
          byId={new Map([[target.id, target]])}
          listPath="/r/r1/projects"
          onClose={() => undefined}
          onReload={() => Promise.resolve(target)}
          members={[]}
          ownChange={undefined}
          onToggleAssignee={() => undefined}
          onSetPriorityLabel={() => undefined}
          onDirtyChange={() => undefined}
          onAddToCalendar={onAddToCalendar}
          timeZone="UTC"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onAddToCalendar;
}

describe('ProjectPanel Add to calendar', () => {
  test('FR-4.5: the Actions menu and the panel offer "Add to calendar" only for items with a date or a milestone', () => {
    renderPanel(item());
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
    cleanup();

    const onAddToCalendar = renderPanel(item({ startDate: '2027-03-03', endDate: '2027-04-28' }));
    const button = screen.getByRole('button', { name: 'Add to calendar' });
    // A link-styled button, under the dates.
    expect(button.className).toContain('btn-link');
    expect(screen.getByLabelText('End date').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Priority label').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(button);
    expect(onAddToCalendar).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  test('FR-4.5: a cancelled item\'s panel has no "Add to calendar"', () => {
    renderPanel(item({ status: 'cancelled', startDate: '2027-03-03', endDate: '2027-04-28' }));
    expect(screen.getByLabelText('End date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to calendar' })).toBeNull();
  });
});

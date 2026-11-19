import { NO_FILTERS } from '@roadmap/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { FiltersPanel } from './FiltersPanel.tsx';

afterEach(cleanup);

const panel = (over: Partial<Parameters<typeof FiltersPanel>[0]> = {}) =>
  render(
    <FiltersPanel
      open
      filters={{ ...NO_FILTERS, assigneeIds: ['u-gone'] }}
      onChange={() => undefined}
      onClear={() => undefined}
      onDone={() => undefined}
      tagsInUse={[]}
      members={[{ userId: 'u-me', name: 'Maria' }, { userId: 'u2', name: 'Bob' }]}
      membersLoaded
      myId="u-me"
      {...over}
    />,
  );

describe('FiltersPanel assignees', () => {
  test('FR-1.8: an assignee id with no member reads "Former member" once the members have loaded', () => {
    panel();
    expect(screen.getByLabelText<HTMLInputElement>('Former member').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Assigned to me').checked).toBe(false);
    expect(screen.getByLabelText('Bob')).toBeTruthy();
    expect(screen.queryByLabelText('Maria')).toBeNull();
  });

  test('FR-1.8: while the members load, an unknown assignee id is not called a former member', () => {
    panel({ members: [], membersLoaded: false });
    expect(screen.queryByLabelText('Former member')).toBeNull();
    expect(screen.getByLabelText('Assigned to me')).toBeTruthy();
  });

  test('FR-1.8: "Assigned to me" is ticked by the literal me', () => {
    panel({ filters: { ...NO_FILTERS, assigneeIds: ['me'] } });
    expect(screen.getByLabelText<HTMLInputElement>('Assigned to me').checked).toBe(true);
    expect(screen.queryByLabelText('Former member')).toBeNull();
  });
});

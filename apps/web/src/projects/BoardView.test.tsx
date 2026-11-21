import type { Project } from '@roadmap/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useBoardMoves } from './BoardView.tsx';

afterEach(cleanup);

const hire: Project = {
  id: 'p1',
  parentId: null,
  depth: 1,
  path: [],
  title: 'Hire',
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
  updatedAt: '2026-11-20T00:00:00.000Z',
};

/** A `changeStatus` whose promise the test settles. */
function pendingSave() {
  let settle: (saved: boolean) => void = () => undefined;
  const changeStatus = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)));
  return { changeStatus, settle: (saved: boolean) => settle(saved) };
}

/** Settles a save and lets the hook see it. */
const settled = (settle: () => void) =>
  act(async () => {
    settle();
    await Promise.resolve();
  });

describe('useBoardMoves', () => {
  test('FR-1.7: a card shows in the target column while its move is being saved', () => {
    const { changeStatus } = pendingSave();
    const { result } = renderHook(() => useBoardMoves({ changeStatus }));
    act(() => result.current.move(hire, 'done'));
    expect(result.current.statusOf(hire)).toBe('done');
    expect(changeStatus).toHaveBeenCalledTimes(1);
    expect(changeStatus).toHaveBeenCalledWith(hire, 'done');
  });

  test('FR-1.7: the card goes back when the save is refused', async () => {
    const { changeStatus, settle } = pendingSave();
    const { result } = renderHook(() => useBoardMoves({ changeStatus }));
    act(() => result.current.move(hire, 'done'));
    await settled(() => settle(false));
    expect(result.current.statusOf(hire)).toBe('not_started');
  });

  test('FR-1.7: once saved, the card follows the item, which by then has the new status', async () => {
    const { changeStatus, settle } = pendingSave();
    const { result } = renderHook(() => useBoardMoves({ changeStatus }));
    act(() => result.current.move(hire, 'done'));
    await settled(() => settle(true));
    expect(result.current.statusOf({ ...hire, status: 'done' })).toBe('done');
  });

  test('FR-1.7: a move to the status the card already has does nothing', () => {
    const { changeStatus } = pendingSave();
    const { result } = renderHook(() => useBoardMoves({ changeStatus }));
    act(() => result.current.move(hire, 'not_started'));
    expect(changeStatus).not.toHaveBeenCalled();
    expect(result.current.statusOf(hire)).toBe('not_started');
  });

  test('FR-1.7: beforeChange is told before the card moves and again before it goes back, and not for a no-op move', async () => {
    const { changeStatus, settle } = pendingSave();
    const seen: string[] = [];
    const { result } = renderHook(() => useBoardMoves({ changeStatus }, (item) => seen.push(result.current.statusOf(item))));
    act(() => result.current.move(hire, 'not_started'));
    expect(seen).toEqual([]);
    act(() => result.current.move(hire, 'done'));
    // Told while the card still shows its old status.
    expect(seen).toEqual(['not_started']);
    await settled(() => settle(false));
    expect(seen).toEqual(['not_started', 'done']);
  });

  test('FR-1.7: a second move before the first is saved wins, and the first settling does not undo it', async () => {
    const saves: ((saved: boolean) => void)[] = [];
    const changeStatus = vi.fn(() => new Promise<boolean>((resolve) => saves.push(resolve)));
    const { result } = renderHook(() => useBoardMoves({ changeStatus }));
    act(() => result.current.move(hire, 'done'));
    act(() => result.current.move(hire, 'blocked'));
    expect(result.current.statusOf(hire)).toBe('blocked');
    await settled(() => saves[0]!(true));
    expect(result.current.statusOf(hire)).toBe('blocked');
    await settled(() => saves[1]!(false));
    expect(result.current.statusOf(hire)).toBe('not_started');
  });
});

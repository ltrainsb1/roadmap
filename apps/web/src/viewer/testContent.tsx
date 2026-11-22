import type { SnapshotContent, SnapshotItem, SnapshotNote } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Mock } from 'vitest';
import { ApiError, type api, type ApiOptions } from '../api/client.ts';
import { SnapshotGate } from './SnapshotGate.tsx';
import { PrintPage } from './PrintPage.tsx';
import { SnapshotLayout } from './SnapshotLayout.tsx';

/** Test data and a test harness for the viewer's unit tests. */

export const LINK = 'link_abcdefghijklmnopqrstuvwx';

export const item = (over: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'title'>): SnapshotItem => ({
  parentId: null,
  depth: 1,
  description: '',
  status: 'not_started',
  startDate: null,
  endDate: null,
  milestones: [],
  tags: [],
  links: [],
  blockedBy: [],
  priorityLabel: null,
  rank: 1,
  ...over,
});

export const note = (over: Partial<SnapshotNote> & Pick<SnapshotNote, 'id' | 'body'>): SnapshotNote => ({
  itemId: 'p1',
  parentId: null,
  authorName: 'Maria',
  mentions: [],
  createdAt: '2026-03-10T09:30:00.000Z',
  edited: false,
  deleted: false,
  ...over,
});

/** "Launch site" (with everything) holding "Design", then "Hire", which blocks "Launch site". */
export const ITEMS: SnapshotItem[] = [
  item({
    id: 'p1',
    title: 'Launch site',
    description: 'Line one\nLine two',
    status: 'in_progress',
    startDate: '2026-03-03',
    endDate: '2026-04-28',
    milestones: [{ id: 'm1', name: 'Beta', date: '2026-04-01' }],
    tags: ['web'],
    links: [
      { id: 'l1', label: 'Spec', url: 'https://example.com/spec' },
      { id: 'l2', label: 'Sneaky', url: 'javascript:alert(1)' },
    ],
    blockedBy: ['p2'],
    priorityLabel: 'P1',
    rank: 1,
  }),
  item({ id: 'c1', parentId: 'p1', depth: 2, title: 'Design', status: 'done', rank: 1 }),
  item({ id: 'p2', title: 'Hire', rank: 2 }),
];

export const content = (over: Partial<SnapshotContent> = {}): SnapshotContent => ({
  roadmapName: 'Launch plan',
  asOf: '2026-03-12',
  frozenAt: '2026-03-12T10:00:00.000Z',
  include: { notes: false, assignees: false },
  items: ITEMS,
  ...over,
});

/** Includes notes and names: each item carries its names and note count. */
export const fullContent = (counts: Record<string, number> = { p1: 3, c1: 0, p2: 0 }): SnapshotContent =>
  content({
    include: { notes: true, assignees: true },
    items: ITEMS.map((i) => ({ ...i, assignees: i.id === 'p1' ? ['Maria', 'Sam'] : [], noteCount: counts[i.id] ?? 0 })),
  });

/** A value to resolve with, or an `ApiError` to reject with. */
type Answer = unknown;

export interface ApiScript {
  status?: () => Answer;
  unlock?: (password: string) => Answer;
  /** `all` is true for `/content?notes=all`. */
  content?: (all: boolean) => Answer;
  notes?: (itemId: string) => Answer;
  pdf?: (view: string) => Answer;
}

/**
 * Answers the viewer's API calls from `script`, and records every call. Throws for a call that is not quiet, so no
 * test can pass while a viewer call would send someone to sign in.
 */
export function scriptApi(mock: Mock<typeof api>, script: ApiScript) {
  const calls: string[] = [];
  mock.mockImplementation((path: string, opts: ApiOptions = {}) => {
    calls.push(path);
    if (opts.quiet !== true) throw new Error(`${path} was called without quiet: true`);
    const prefix = `/api/snapshots/${LINK}`;
    let answer: Answer;
    if (path === prefix) answer = script.status?.() ?? { unlocked: false };
    else if (path === `${prefix}/unlock`) answer = script.unlock?.((opts.body as { password: string }).password);
    else if (path === `${prefix}/content` || path === `${prefix}/content?notes=all`) {
      answer = script.content?.(path.endsWith('?notes=all')) ?? content();
    } else if (path === `${prefix}/pdf`) answer = script.pdf?.((opts.body as { view: string }).view);
    else {
      const itemId = /\/items\/([^/]+)\/notes$/.exec(path)?.[1];
      if (!itemId) throw new Error(`unexpected call ${path}`);
      answer = script.notes?.(decodeURIComponent(itemId)) ?? { notes: [] };
    }
    return answer instanceof ApiError ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return calls;
}

function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

/** Renders the viewer's routes at `path`. */
export function renderViewer(path: string, state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: path.split('?')[0]!, search: path.includes('?') ? `?${path.split('?')[1]}` : '', state }]}>
        <Routes>
          <Route path="/s/:linkId" element={<SnapshotGate />} />
          <Route path="/s/:linkId/list" element={<SnapshotLayout view="list" />} />
          <Route path="/s/:linkId/timeline" element={<SnapshotLayout view="timeline" />} />
          <Route path="/s/:linkId/print/list" element={<PrintPage view="list" />} />
          <Route path="/s/:linkId/print/timeline" element={<PrintPage view="timeline" />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

export const locationOf = (container: HTMLElement) => container.querySelector('[data-testid="location"]')?.textContent;

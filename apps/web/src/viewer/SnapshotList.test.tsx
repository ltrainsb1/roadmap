import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
import { content, fullContent, LINK, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(cleanup);

const table = () => screen.getByRole('table', { name: 'List' });
const rowOf = (title: string) => {
  const row = within(table())
    .getAllByRole('row')
    .find((r) => within(r).queryByRole('rowheader')?.textContent?.includes(title));
  if (!row) throw new Error(`no row for ${title}`);
  return row;
};
const cellsOf = (title: string) => within(rowOf(title)).getAllByRole('cell').map((c) => c.textContent);

test('FR-3.3: the list nests items, collapses a branch with its chevron, and shows status, dates and priority as text', async () => {
  scriptApi(mockApi, { content: () => content() });
  renderViewer(`/s/${LINK}/list`);
  await screen.findByRole('table', { name: 'List' });
  expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Status', 'Dates', 'Priority']);
  expect(within(table()).getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
    'Project: Launch site',
    'Sub-project: Design',
    'Project: Hire',
  ]);
  expect(rowOf('Design').className).toContain('depth-2');
  expect(cellsOf('Launch site')).toEqual(['In progress', '3 Mar to 28 Apr 2026', '1 · P1']);
  expect(cellsOf('Design')).toEqual(['Done', 'No dates', '1']);
  expect(cellsOf('Hire')).toEqual(['Not started', 'No dates', '2']);

  fireEvent.click(screen.getByRole('button', { name: 'Collapse Launch site' }));
  expect(within(table()).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Project: Launch site', 'Project: Hire']);
  fireEvent.click(screen.getByRole('button', { name: 'Expand Launch site' }));
  expect(within(table()).getAllByRole('rowheader')).toHaveLength(3);
  // Only an item with children has a chevron.
  expect(screen.queryByRole('button', { name: /^(Collapse|Expand) (Design|Hire)$/ })).toBeNull();
});

test('FR-3.3: the title opens a details row under its item, with aria-expanded', async () => {
  scriptApi(mockApi, { content: () => content() });
  renderViewer(`/s/${LINK}/list`);
  const title = await screen.findByRole('button', { name: 'Details for Launch site' });
  expect(title.textContent).toBe('Launch site');
  expect(title.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(title);
  expect(title.getAttribute('aria-expanded')).toBe('true');
  const details = document.getElementById(title.getAttribute('aria-controls')!)!;
  expect(within(details).getByRole('heading', { name: 'Description' })).toBeTruthy();
  // The details row comes straight after its item's row.
  const rows = within(table()).getAllByRole('row');
  expect(rows[rows.indexOf(rowOf('Launch site')) + 1]!.contains(details)).toBe(true);
  fireEvent.click(title);
  expect(title.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('heading', { name: 'Description' })).toBeNull();
});

test('FR-3.5: the "Assigned to" column and the Notes part exist only when the snapshot includes them', async () => {
  scriptApi(mockApi, { content: () => content() });
  const without = renderViewer(`/s/${LINK}/list`);
  await screen.findByRole('table', { name: 'List' });
  expect(screen.queryByRole('columnheader', { name: 'Assigned to' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Details for Launch site' }));
  expect(screen.getByRole('heading', { name: 'Description' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
  expect(mockApi.mock.calls.some(([path]) => path.includes('/notes'))).toBe(false);
  without.unmount();

  scriptApi(mockApi, { content: () => fullContent() });
  renderViewer(`/s/${LINK}/list`);
  await screen.findByRole('table', { name: 'List' });
  expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Status', 'Dates', 'Priority', 'Assigned to']);
  expect(cellsOf('Launch site')[3]).toBe('Maria, Sam');
  expect(cellsOf('Hire')[3]).toBe('Unassigned');
  // With notes included every item has details, if only to say it has no notes.
  fireEvent.click(screen.getByRole('button', { name: 'Details for Hire' }));
  expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
  expect(screen.getByText('No notes.')).toBeTruthy();
});

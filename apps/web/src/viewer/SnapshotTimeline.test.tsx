import { timelineRange, xOf } from '@roadmap/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
import { TimelineAxis } from '../projects/TimelineAxis.tsx';
import { content, ITEMS, LINK, locationOf, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(cleanup);

test('FR-3.3: the timeline puts the marker on the as-of date and labels it "As of"', async () => {
  scriptApi(mockApi, { content: () => content() });
  const { container } = renderViewer(`/s/${LINK}/timeline`);
  const table = await screen.findByRole('table', { name: 'Timeline' });
  const range = timelineRange(ITEMS, '2026-03-12', 'months');
  const at = `${xOf('2026-03-12', range)}px`;

  const label = container.querySelector<HTMLElement>('.today-label')!;
  expect(label.textContent).toBe('As of');
  expect(label.style.left).toBe(at);
  const lines = [...container.querySelectorAll<HTMLElement>('.today-line')];
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(line.style.left).toBe(at);

  // The name column nests like the List, with the status and dates in words and no way to change anything.
  expect(within(table).getAllByRole('rowheader').map((h) => h.querySelector('.item-title')?.textContent)).toEqual(['Launch site', 'Design', 'Hire']);
  expect(within(table).getByText('3 Mar to 28 Apr 2026')).toBeTruthy();
  expect(within(table).getByText('Milestone: Beta, 1 Apr 2026')).toBeTruthy();
  expect(within(table).queryByRole('link')).toBeNull();
  expect(within(table).queryByRole('button', { name: /^Actions for/ })).toBeNull();
  fireEvent.click(within(table).getByRole('button', { name: 'Collapse Launch site' }));
  expect(within(table).getAllByRole('rowheader')).toHaveLength(2);

  // Zoom lives in the address, as in the app's Timeline.
  const zoom = screen.getByLabelText<HTMLSelectElement>('Zoom');
  expect([...zoom.options].map((o) => o.textContent)).toEqual(['Weeks', 'Months', 'Quarters']);
  expect(zoom.value).toBe('months');
  fireEvent.change(zoom, { target: { value: 'weeks' } });
  await waitFor(() => expect(locationOf(container)).toBe(`/s/${LINK}/timeline?zoom=weeks`));
  expect(container.querySelector<HTMLElement>('.today-label')!.style.left).toBe(`${xOf('2026-03-12', timelineRange(ITEMS, '2026-03-12', 'weeks'))}px`);
  fireEvent.change(zoom, { target: { value: 'months' } });
  await waitFor(() => expect(locationOf(container)).toBe(`/s/${LINK}/timeline`));
});

test("FR-3.3: the app's Timeline axis still labels its marker \"Today\"", () => {
  const range = timelineRange(ITEMS, '2026-03-12', 'months');
  render(
    <table>
      <TimelineAxis range={range} zoom="months" today="2026-03-12" />
    </table>,
  );
  expect(document.querySelector('.today-label')!.textContent).toBe('Today');
});

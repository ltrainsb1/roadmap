import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from '../api/client.ts';
import { content, fullContent, item, ITEMS, LINK, note, renderViewer, scriptApi } from './testContent.tsx';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});
afterEach(cleanup);

/** Opens the details of `title` and returns the details block. */
async function openDetails(title: string) {
  const button = await screen.findByRole('button', { name: `Details for ${title}` });
  fireEvent.click(button);
  return document.getElementById(button.getAttribute('aria-controls')!)!;
}
const headingsIn = (el: HTMLElement) => within(el).getAllByRole('heading').map((h) => h.textContent);

test('FR-3.3: details show only the parts that have content, and "Blocked by" lists the blockers\' titles', async () => {
  const onlyTags = item({ id: 'c1', parentId: 'p1', depth: 2, title: 'Design', tags: ['ux', 'research'] });
  scriptApi(mockApi, { content: () => content({ items: [ITEMS[0]!, onlyTags, ITEMS[2]!] }) });
  renderViewer(`/s/${LINK}/list`);

  const full = await openDetails('Launch site');
  expect(headingsIn(full)).toEqual(['Description', 'Milestones', 'Tags', 'Links', 'Blocked by']);
  const section = (name: string) => within(full).getByRole('heading', { name }).closest('section')!;
  // Plain text, with its line break kept.
  expect(section('Description').querySelector('p')!.textContent).toBe('Line one\nLine two');
  expect(within(section('Milestones')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Beta, 1 Apr 2026']);
  expect(within(section('Tags')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['web']);
  const spec = within(section('Links')).getByRole('link', { name: 'Spec' });
  expect(spec.getAttribute('href')).toBe('https://example.com/spec');
  expect(spec.getAttribute('target')).toBe('_blank');
  expect(spec.getAttribute('rel')).toBe('noopener noreferrer');
  // Only http and https addresses become links.
  expect(within(section('Links')).queryByRole('link', { name: 'Sneaky' })).toBeNull();
  expect(within(section('Links')).getByText('Sneaky')).toBeTruthy();
  expect(within(section('Blocked by')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Hire']);

  expect(headingsIn(await openDetails('Design'))).toEqual(['Tags']);
  // An item with nothing to show has no details to open: its title is plain text.
  expect(screen.queryByRole('button', { name: 'Details for Hire' })).toBeNull();
  expect(screen.getByText('Hire', { selector: '.item-title' })).toBeTruthy();
});

test('FR-3.3: note text and descriptions with <script> or an <img onerror> show as text', async () => {
  const base = fullContent({ p1: 1 });
  const hostile = '<script>window.hacked = true</script><img src="x" onerror="window.hacked = true">';
  scriptApi(mockApi, {
    content: () => ({ ...base, items: base.items.map((i) => (i.id === 'p1' ? { ...i, description: hostile, title: '<b>Launch site</b>' } : i)) }),
    notes: () => ({ notes: [note({ id: 'n1', body: hostile })] }),
  });
  renderViewer(`/s/${LINK}/list`);
  const details = await openDetails('<b>Launch site</b>');
  await within(details).findByRole('heading', { name: 'Notes' });
  await within(details).findByRole('article');
  expect(document.querySelector('script, img, b')).toBeNull();
  expect(within(details).getAllByText(hostile, { exact: false }).length).toBeGreaterThan(0);
  expect((window as { hacked?: boolean }).hacked).toBeUndefined();
});

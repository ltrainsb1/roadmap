import type { FeedChoices, FeedLink, FeedState, MeResponse } from '@roadmap/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../api/client.ts';
import { CalendarSettingsPage } from './CalendarSettingsPage.tsx';
import { CALENDAR_FEED_KEY } from './useCalendarFeed.ts';

vi.mock('../api/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client.ts')>()),
  api: vi.fn(),
}));

const mockApi = vi.mocked(api);

// jsdom has no modal dialogs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
beforeEach(() => {
  mockApi.mockReset();
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const ME: MeResponse = {
  user: { id: 'u1', email: 'pat@example.com', name: 'Pat', timezone: 'Europe/Paris', hasTotp: true, passkeys: [] },
  csrfToken: 'csrf',
  memberships: [
    { roadmapId: 'r1', roadmapName: 'Launch plan', role: 'owner' },
    { roadmapId: 'r2', roadmapName: 'Hiring', role: 'contributor' },
  ],
};

const DEFAULTS: FeedChoices = { roadmaps: 'all', itemDates: true, milestones: true, onlyMine: false };
/** The choices as stored, where a chosen list can be empty. */
type Kept = NonNullable<FeedState['feed']>['choices'];
const feedOf = (choices: Kept = DEFAULTS, lastFetchedAt: string | null = null): FeedState => ({
  feed: { choices, createdAt: '2026-09-03T10:00:00.000Z', linkCreatedAt: '2026-09-03T10:00:00.000Z', lastFetchedAt },
});
const URL_1 = 'http://localhost:5173/api/calendar/first-token.ics';
const URL_2 = 'http://localhost:5173/api/calendar/second-token.ics';

type Answer = unknown;
interface Server {
  get: () => Answer;
  create?: () => Answer;
  put?: (body: FeedChoices) => Answer;
  newLink?: () => Answer;
  remove?: () => Answer;
}
/** Answers the page's calls; each answer can be a value, a promise or an error to throw. */
function serve(s: Server) {
  mockApi.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
    const answer = (a: Answer) => (a instanceof Error ? Promise.reject(a) : a instanceof Promise ? a : Promise.resolve(a));
    const method = opts?.method ?? 'GET';
    if (path === '/api/notifications/unread-count') return answer({ unread: 0 });
    if (path === '/api/me') return answer(ME);
    if (path === '/api/me/calendar-feed' && method === 'GET') return answer(s.get());
    if (path === '/api/me/calendar-feed' && method === 'POST') return answer(s.create?.());
    if (path === '/api/me/calendar-feed' && method === 'DELETE') return answer(s.remove?.());
    if (path === '/api/me/calendar-feed/choices' && method === 'PUT') return answer(s.put?.(opts!.body as FeedChoices));
    if (path === '/api/me/calendar-feed/new-link' && method === 'POST') return answer(s.newLink?.());
    throw new Error(`unexpected call ${method} ${path}`);
  });
}
const callsTo = (path: string, method: string) => mockApi.mock.calls.filter(([p, o]) => p === path && (o?.method ?? 'GET') === method);

function renderPage(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/calendar']}>
        <Routes>
          <Route path="/settings/calendar" element={<CalendarSettingsPage />} />
          <Route path="/settings/notifications" element={<p>Email settings screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
const box = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });
const roadmapBoxes = () => within(screen.getByRole('group', { name: 'Only these' })).getAllByRole<HTMLInputElement>('checkbox');
const linkHeading = () => screen.getByRole('heading', { name: 'Your calendar link', level: 2 });
/** The form, once the person's roadmaps are listed in it. */
const formReady = () => screen.findByRole('checkbox', { name: 'Hiring' });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

test('FR-4.1: with no feed the page offers "Create calendar link"; creating shows the link, "Copy link", the warning, the instructions and the delay note, and moves focus to "Your calendar link"', async () => {
  let state: FeedState = { feed: null };
  serve({
    get: () => state,
    create: (): FeedLink => {
      state = feedOf();
      return { ...state, url: URL_1 };
    },
  });
  const client = renderPage();
  expect(screen.getByRole('heading', { name: 'Calendar feed', level: 1 })).toBeTruthy();
  expect(
    screen.getByText('See your roadmap dates in Google Calendar, Apple Calendar or Outlook. The calendar updates on its own when dates change.'),
  ).toBeTruthy();
  const create = await screen.findByRole('button', { name: 'Create calendar link' });
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Get a new link' })).toBeNull();

  fireEvent.click(create);
  // A second press while the first is on its way makes no second feed.
  fireEvent.click(create);
  await waitFor(() => expect(document.activeElement).toBe(linkHeading()));
  expect(callsTo('/api/me/calendar-feed', 'POST')).toEqual([['/api/me/calendar-feed', { method: 'POST' }]]);
  expect(client.getQueryData(CALENDAR_FEED_KEY)).toEqual(feedOf());

  const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Calendar link' });
  expect(field.value).toBe(URL_1);
  expect(field.readOnly).toBe(true);
  expect(
    screen.getByText('Anyone with this link can see the dates it shows. Copy it now: for your safety it can\'t be shown again.'),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Add it to your calendar' })).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Add it to your calendar' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Google Calendar: Other calendars, +, From URL, then paste the link.',
    'Apple Calendar: File, New Calendar Subscription, then paste the link.',
    'Outlook: Add calendar, Subscribe from web, then paste the link.',
  ]);
  expect(
    screen.getByText(
      'Calendar apps check for changes every few hours, and Google can take longer. To add one item right away, use Add to calendar on the item.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/^Your calendar link is active/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect((await screen.findByText('Link copied.')).getAttribute('role')).toBe('status');
  expect(writeText).toHaveBeenCalledWith(URL_1);

  // The clipboard refuses: the page says what to do, and the link is still there to select.
  writeText.mockRejectedValueOnce(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't copy the link. Select it and copy it yourself.");
  expect(screen.queryByText('Link copied.')).toBeNull();
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Calendar link' }).value).toBe(URL_1);

  // The form for the new feed starts at the defaults.
  expect(radio('All my roadmaps').checked).toBe(true);
});

test('FR-4.1: creating that fails says so and keeps "Create calendar link"', async () => {
  serve({ get: () => ({ feed: null }), create: () => new ApiError(500, 'unknown') });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Create calendar link' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Something went wrong. Try again.');
  expect(screen.getByRole('button', { name: 'Create calendar link' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Calendar link' })).toBeNull();
});

test('FR-4.1: on a later visit the link is not shown, and the page says when it was made and when it was last checked (or that it hasn\'t been)', async () => {
  let state = feedOf(DEFAULTS, '2026-11-20T13:05:00.000Z');
  serve({ get: () => state });
  const client = renderPage();
  // Paris is an hour ahead of UTC in November.
  expect(await screen.findByText('A calendar app last checked it on 20 Nov 2026 at 14:05.')).toBeTruthy();
  expect(screen.getByText('Your calendar link is active. It was made on 3 Sep 2026.')).toBeTruthy();
  expect(screen.getByText("For your safety the link can't be shown again. If you've lost it, get a new link.")).toBeTruthy();
  expect(linkHeading()).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Calendar link' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  expect(screen.queryByText(/^Anyone with this link/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create calendar link' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Get a new link' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off the feed' })).toBeTruthy();

  state = feedOf(DEFAULTS, null);
  await client.invalidateQueries({ queryKey: CALENDAR_FEED_KEY });
  expect(await screen.findByText('No calendar app has checked it yet.')).toBeTruthy();
  expect(screen.queryByText(/^A calendar app last checked it/)).toBeNull();
});

test('FR-4.4: a later visit after a new link says when the new link was made and that no calendar app has checked it yet', async () => {
  const before = feedOf(DEFAULTS, '2026-11-20T13:05:00.000Z');
  serve({ get: () => ({ feed: { ...before.feed!, linkCreatedAt: '2026-11-22T08:00:00.000Z', lastFetchedAt: null } }) });
  renderPage();
  expect(await screen.findByText('Your calendar link is active. It was made on 22 Nov 2026.')).toBeTruthy();
  expect(screen.getByText('No calendar app has checked it yet.')).toBeTruthy();
  expect(screen.queryByText(/It was made on 3 Sep 2026/)).toBeNull();
});

test('FR-4.2: the choices load, "Only these" enables the roadmap checkboxes, and "Save changes" sends exactly what is ticked; an empty list and nothing to show are refused with their messages', async () => {
  let fail = true;
  let state = feedOf({ roadmaps: 'all', itemDates: true, milestones: false, onlyMine: true });
  serve({
    get: () => state,
    put: (body) => {
      if (fail) return new ApiError(500, 'unknown');
      state = feedOf(body);
      return state;
    },
  });
  const client = renderPage();
  await formReady();

  expect(screen.getByRole('group', { name: 'Roadmaps' })).toBeTruthy();
  expect(radio('All my roadmaps').checked).toBe(true);
  expect(radio('Only these').checked).toBe(false);
  // Shown but not usable while "All my roadmaps" is chosen, so the page doesn't jump.
  expect(roadmapBoxes().map((b) => b.closest('div')?.textContent)).toEqual(['Launch plan', 'Hiring']);
  expect(roadmapBoxes().map((b) => [b.disabled, b.checked])).toEqual([
    [true, false],
    [true, false],
  ]);
  const show = screen.getByRole('group', { name: 'Show' });
  expect(document.getElementById(show.getAttribute('aria-describedby')!)?.textContent).toBe(
    'Item dates show as one entry from the start date to the end date.',
  );
  expect(box('Item dates').checked).toBe(true);
  expect(box('Milestones').checked).toBe(false);
  expect(box('Only items assigned to me').checked).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();

  // "Only these" with nothing ticked: said at once, and the save is refused with focus on the first box.
  fireEvent.click(radio('Only these'));
  expect(roadmapBoxes().map((b) => b.disabled)).toEqual([false, false]);
  expect(screen.getByRole('alert').textContent).toBe('Choose at least one roadmap.');
  save();
  expect(document.activeElement).toBe(roadmapBoxes()[0]);
  fireEvent.click(box('Hiring'));
  expect(screen.queryByText('Choose at least one roadmap.')).toBeNull();

  // Nothing to show: refused too, with focus on "Item dates".
  fireEvent.click(box('Item dates'));
  expect(screen.getByRole('alert').textContent).toBe('Choose item dates, milestones or both.');
  save();
  expect(document.activeElement).toBe(box('Item dates'));
  fireEvent.click(box('Milestones'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(callsTo('/api/me/calendar-feed/choices', 'PUT')).toHaveLength(0);

  // A failed save says so and keeps the choices.
  save();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save your choices. Try again.");
  expect(box('Hiring').checked).toBe(true);

  fail = false;
  save();
  const saved = await screen.findByText('Saved.');
  expect(saved.getAttribute('role')).toBe('status');
  expect(screen.queryByRole('alert')).toBeNull();
  const expected = { roadmaps: ['r2'], itemDates: false, milestones: true, onlyMine: true };
  expect(callsTo('/api/me/calendar-feed/choices', 'PUT').map(([, o]) => o)).toEqual([
    { method: 'PUT', body: expected },
    { method: 'PUT', body: expected },
  ]);
  expect(client.getQueryData(CALENDAR_FEED_KEY)).toEqual(feedOf(expected));

  // A new change clears "Saved."; going back to "All my roadmaps" sends "all", whatever was ticked.
  fireEvent.click(radio('All my roadmaps'));
  expect(screen.queryByText('Saved.')).toBeNull();
  expect(box('Hiring').checked).toBe(true);
  expect(box('Hiring').disabled).toBe(true);
  save();
  await screen.findByText('Saved.');
  expect(callsTo('/api/me/calendar-feed/choices', 'PUT').at(-1)?.[1]).toEqual({
    method: 'PUT',
    body: { roadmaps: 'all', itemDates: false, milestones: true, onlyMine: true },
  });
});

test('FR-4.2: a chosen list left empty by a deleted roadmap shows "Only these" with nothing ticked and asks for one', async () => {
  serve({ get: () => feedOf({ roadmaps: [], itemDates: true, milestones: true, onlyMine: false }) });
  renderPage();
  await formReady();
  expect(radio('Only these').checked).toBe(true);
  expect(roadmapBoxes().map((b) => [b.disabled, b.checked])).toEqual([
    [false, false],
    [false, false],
  ]);
  expect(screen.getByRole('alert').textContent).toBe('Choose at least one roadmap.');
  save();
  expect(callsTo('/api/me/calendar-feed/choices', 'PUT')).toHaveLength(0);
});

test('FR-4.2: a chosen roadmap the person has since left is not ticked or sent', async () => {
  serve({ get: () => feedOf({ roadmaps: ['r1', 'gone'], itemDates: true, milestones: true, onlyMine: false }), put: (body) => feedOf(body) });
  renderPage();
  await formReady();
  expect(roadmapBoxes().map((b) => b.checked)).toEqual([true, false]);
  fireEvent.click(box('Hiring'));
  save();
  await screen.findByText('Saved.');
  expect(callsTo('/api/me/calendar-feed/choices', 'PUT')[0]?.[1]).toEqual({
    method: 'PUT',
    body: { roadmaps: ['r1', 'r2'], itemDates: true, milestones: true, onlyMine: false },
  });
});

test('FR-4.4: "Get a new link" and "Turn off the feed" ask first, then act; focus moves as the accessibility notes say', async () => {
  let state: FeedState = feedOf(DEFAULTS, '2026-11-20T13:05:00.000Z');
  let failNewLink = true;
  serve({
    get: () => state,
    newLink: (): Answer => (failNewLink ? new ApiError(500, 'unknown') : { ...state, url: URL_2 }),
    remove: () => {
      state = { feed: null };
      return undefined;
    },
    create: (): FeedLink => {
      state = feedOf();
      return { ...state, url: URL_1 };
    },
  });
  const client = renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Get a new link' }));
  let dialog = screen.getByRole('dialog', { name: 'Get a new calendar link?' });
  expect(
    within(dialog).getByText(
      "The current link stops working, and calendars that use it stop updating. You'll need to add the new link to them.",
    ),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(callsTo('/api/me/calendar-feed/new-link', 'POST')).toHaveLength(0);

  // A failure is said in the dialog, which stays open.
  fireEvent.click(screen.getByRole('button', { name: 'Get a new link' }));
  dialog = screen.getByRole('dialog', { name: 'Get a new calendar link?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Get new link' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Something went wrong. Try again.');

  failNewLink = false;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Get new link' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Calendar link' }).value).toBe(URL_2);
  expect(document.activeElement).toBe(linkHeading());
  expect(callsTo('/api/me/calendar-feed/new-link', 'POST')).toEqual([
    ['/api/me/calendar-feed/new-link', { method: 'POST' }],
    ['/api/me/calendar-feed/new-link', { method: 'POST' }],
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Turn off the feed' }));
  dialog = screen.getByRole('dialog', { name: 'Turn off your calendar feed?' });
  expect(
    within(dialog).getByText('The link stops working and calendars that use it stop updating. Your roadmap dates stay in the app.'),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(callsTo('/api/me/calendar-feed', 'DELETE')).toHaveLength(0);

  fireEvent.click(screen.getByRole('button', { name: 'Turn off the feed' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Turn off your calendar feed?' })).getByRole('button', { name: 'Turn off' }));
  const create = await screen.findByRole('button', { name: 'Create calendar link' });
  await waitFor(() => expect(document.activeElement).toBe(create));
  expect(callsTo('/api/me/calendar-feed', 'DELETE')).toEqual([['/api/me/calendar-feed', { method: 'DELETE' }]]);
  expect(client.getQueryData(CALENDAR_FEED_KEY)).toEqual({ feed: null });
  // The link made before is gone with the feed.
  expect(screen.queryByRole('textbox', { name: 'Calendar link' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
});

test('FR-4.4: turning off that fails says so in the dialog', async () => {
  serve({ get: () => feedOf(), remove: () => new ApiError(500, 'unknown') });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off the feed' }));
  const dialog = screen.getByRole('dialog', { name: 'Turn off your calendar feed?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Something went wrong. Try again.');
  expect(screen.getByRole('button', { name: 'Get a new link' })).toBeTruthy();
});

test('FR-4.2: leaving with unsaved choices asks first', async () => {
  serve({ get: () => feedOf(), put: (body) => feedOf(body) });
  renderPage();
  await screen.findByRole('button', { name: 'Save changes' });
  const unload = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const emailTab = () => within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('link', { name: 'Email notifications' });
  expect(unload()).toBe(false);

  fireEvent.click(box('Milestones'));
  expect(unload()).toBe(true);
  fireEvent.click(emailTab());
  const dialog = await screen.findByRole('dialog', { name: 'Discard your unsaved changes?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(box('Milestones').checked).toBe(false);

  // Changed back: nothing is unsaved, so leaving does not ask.
  fireEvent.click(box('Milestones'));
  expect(unload()).toBe(false);

  fireEvent.click(box('Only items assigned to me'));
  save();
  await screen.findByText('Saved.');
  expect(unload()).toBe(false);
  fireEvent.click(box('Item dates'));
  fireEvent.click(emailTab());
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your unsaved changes?' })).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByText('Email settings screen')).toBeTruthy();
});

test('FR-4.1: a feed that could not load says so, with "Try again"', async () => {
  let fail = true;
  serve({ get: () => (fail ? new ApiError(500, 'unknown') : { feed: null }) });
  renderPage();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load your calendar feed. Try again.");
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('button', { name: 'Create calendar link' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

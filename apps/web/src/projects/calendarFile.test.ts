import type { Project } from '@roadmap/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { downloadItemCalendar, hasCalendarDates } from './calendarFile.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const item = (over: Partial<Project> = {}): Pick<Project, 'id' | 'title' | 'startDate' | 'endDate' | 'milestones' | 'archived'> => ({
  id: 'p1',
  title: 'Launch site',
  startDate: null,
  endDate: null,
  milestones: [],
  archived: false,
  ...over,
});

describe('hasCalendarDates', () => {
  test('FR-4.5: an item has something for a calendar with a start date, an end date or a milestone, and not when archived', () => {
    expect(hasCalendarDates(item())).toBe(false);
    expect(hasCalendarDates(item({ startDate: '2027-03-03' }))).toBe(true);
    expect(hasCalendarDates(item({ endDate: '2027-04-28' }))).toBe(true);
    expect(hasCalendarDates(item({ milestones: [{ id: 'm1', name: 'Beta', date: '2027-03-20' }] }))).toBe(true);
    // The server answers 404 for an archived item, so it is not offered.
    expect(hasCalendarDates(item({ startDate: '2027-03-03', archived: true }))).toBe(false);
  });
});

describe('downloadItemCalendar', () => {
  test('FR-4.5: fetches the item\'s file with the session cookie and saves it as "{title}.ics" through a Blob URL it then revokes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/abc');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    await downloadItemCalendar('r 1', item({ id: 'p/1', title: 'Q3: launch/site' }));

    expect(fetchMock).toHaveBeenCalledWith('/api/roadmaps/r%201/projects/p%2F1/calendar.ics', { credentials: 'same-origin' });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.href).toBe('blob:http://localhost/abc');
    // The server's name for it: cleanFileName drops the folder part.
    expect(clicked[0]?.download).toBe('site.ics');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/abc');
  });

  test('FR-4.5: a refused download throws and saves nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"no_dates"}', { status: 422 })));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await expect(downloadItemCalendar('r1', item())).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
  });
});

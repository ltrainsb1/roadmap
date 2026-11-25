import { calendarFileName, type Project } from '@roadmap/shared';
import { ApiError } from '../api/client.ts';

/**
 * Whether "Add to calendar" is offered for an item: it has a date or a milestone (FR-4.5). Not for an archived
 * item, which the server answers with a 404, nor a cancelled one, which the feed leaves out and the server answers
 * with a 422.
 */
export const hasCalendarDates = (item: Pick<Project, 'status' | 'startDate' | 'endDate' | 'milestones' | 'archived'>): boolean =>
  !item.archived && item.status !== 'cancelled' && (item.startDate !== null || item.endDate !== null || item.milestones.length > 0);

/**
 * Downloads one item's dates as `{title}.ics` (the server's name for it). It is fetched rather than linked, so a
 * refusal throws for the screen to report and the page stays put; the answer is saved through a Blob URL, revoked a
 * second later, since some browsers are still reading it straight after the click.
 */
export async function downloadItemCalendar(roadmapId: string, item: Pick<Project, 'id' | 'title'>): Promise<void> {
  const res = await fetch(`/api/roadmaps/${encodeURIComponent(roadmapId)}/projects/${encodeURIComponent(item.id)}/calendar.ics`, {
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError(res.status, 'download_failed');
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = calendarFileName(item.title);
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

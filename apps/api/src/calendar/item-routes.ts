import { calendarFileName } from '@roadmap/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HttpError } from '../errors.ts';
import { contentDisposition } from '../files/object-store.ts';
import { projectParams } from '../params.ts';
import { loadProject } from '../projects/access.ts';
import { eventsFor, icsCalendar } from './ics.ts';

/** One item's dates as a calendar file to open or import (FR-4.5). The UIDs are the feed's, so subscribing later adds nothing twice. */
export function registerCalendarItemRoutes(app: FastifyInstance, deps: { origin: string }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/roadmaps/:roadmapId/projects/:projectId/calendar.ics',
    { config: { auth: { level: 'full', action: 'roadmap.view' } }, schema: { params: projectParams } },
    async (req, reply) => {
      const { roadmapId, projectId } = req.params;
      const item = await loadProject(req.actor!.db, roadmapId, projectId);
      // Archiving an item archives everything under it, so this also covers items under an archived ancestor.
      if (item.archived) throw new HttpError(404, 'not_found');
      // The feed leaves cancelled items out, so the download does too: the two always agree.
      const events = item.status === 'cancelled' ? [] : eventsFor(item, { origin: deps.origin, itemDates: true, milestones: true });
      if (events.length === 0) throw new HttpError(422, 'no_dates');
      return reply
        .type('text/calendar; charset=utf-8')
        .header('content-disposition', contentDisposition(calendarFileName(item.title)))
        .header('cache-control', 'no-store')
        .send(icsCalendar({ name: 'Roadmap dates', events }));
    },
  );
}

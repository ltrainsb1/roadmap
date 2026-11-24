import { createHash } from 'node:crypto';
import { CALENDAR_LIMITS } from '@roadmap/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashToken } from '../auth/tokens.ts';
import type { Db } from '../db/client.ts';
import { scoped, type ScopedCollection, type ScopedDb } from '../db/scoped.ts';
import type { CalendarFeedDoc, ProjectDoc } from '../db/types.ts';
import { unscoped } from '../db/unscoped.ts';
import { eventsFor, icsCalendar, type IcsEvent } from './ics.ts';

/** A feed token as newToken() makes it: 32 bytes as base64url. Anything else is not looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** lastFetchedAt is written at most this often, so a busy feed doesn't write on every fetch. */
export const LAST_FETCHED_EVERY_MS = 10 * 60_000;

const CALENDAR_NAME = 'Roadmap dates';
const CUT_NAME = `Roadmap dates (first ${CALENDAR_LIMITS.events.toLocaleString('en-US')} dates)`;

const params = z.object({ token: z.string().max(100) });

type ProjectFilter = Parameters<ScopedCollection<ProjectDoc>['find']>[0];

const byEndThenUid = (a: IcsEvent, b: IcsEvent) =>
  a.end < b.end ? -1 : a.end > b.end ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;

/** Every unknown, replaced or malformed token gets the same answer: 404 with nothing in it. */
const nothing = (reply: FastifyReply) => reply.status(404).send();

/** The roadmaps the feed may show right now: those chosen that the person still belongs to (FR-4.2). */
async function roadmapsOf(s: ScopedDb, feed: CalendarFeedDoc): Promise<string[]> {
  const chosen = feed.choices.roadmaps;
  const memberships = await s
    .collection('memberships')
    .find({ userId: feed.userId, ...(chosen !== 'all' && { roadmapId: { $in: chosen } }) });
  return memberships.map((m) => m.roadmapId);
}

/** The calendar a feed shows, built from what is stored now (FR-4.1, FR-4.2). */
async function buildCalendar(s: ScopedDb, feed: CalendarFeedDoc, origin: string): Promise<string> {
  const { itemDates, milestones, onlyMine } = feed.choices;
  const roadmapIds = await roadmapsOf(s, feed);
  if (roadmapIds.length === 0) return icsCalendar({ name: CALENDAR_NAME, events: [] });
  const hasSomething: ProjectFilter[] = [
    ...(itemDates ? [{ startDate: { $ne: null } }, { endDate: { $ne: null } }] : []),
    ...(milestones ? [{ 'milestones.0': { $exists: true } }] : []),
  ];
  // Archiving an item archives everything under it, so `archived: false` also leaves out items under an archived
  // ancestor. Cancelled items are left out; done items stay, they are history.
  const items = await s.collection('projects').find({
    roadmapId: { $in: roadmapIds },
    archived: false,
    status: { $ne: 'cancelled' },
    ...(onlyMine && { assigneeIds: feed.userId }),
    $or: hasSomething,
  });
  const events = items.flatMap((item) => eventsFor(item, { origin, itemDates, milestones })).sort(byEndThenUid);
  const cut = events.length > CALENDAR_LIMITS.events;
  return icsCalendar({ name: cut ? CUT_NAME : CALENDAR_NAME, events: cut ? events.slice(0, CALENDAR_LIMITS.events) : events });
}

/** True when If-None-Match names this ETag (or is `*`); weak and strong forms compare alike for a GET. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const t = tag.trim().replace(/^W\//, '');
    return t === '*' || t === etag;
  });
}

/** The private calendar feed a calendar app subscribes to. It reads no session: the token alone opens it. */
export function registerCalendarPublicRoutes(app: FastifyInstance, deps: { db: Db; now: () => Date; origin: string }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const lookup = unscoped(deps.db);

  r.get(
    '/api/calendar/:token.ics',
    {
      config: {
        auth: { level: 'public' },
        rateLimit: {
          max: CALENDAR_LIMITS.fetchesPerMinute,
          timeWindow: '1 minute',
          // Counted per token, whatever address it comes from. The key is the hash: the token stays out of memory.
          keyGenerator: (req) => `calendar:${hashToken(String((req.params as { token?: unknown }).token))}`,
          // The global allow list exempts every route but sign-in ones; this route is limited on its own terms.
          allowList: [],
        },
      },
      schema: { params },
    },
    async (req, reply) => {
      const { token } = req.params;
      if (!TOKEN.test(token)) return nothing(reply);
      const feed = await lookup.findCalendarFeedByTokenHash(hashToken(token));
      if (!feed) return nothing(reply);
      // The tenant comes from the feed, never from a session: a signed-in cookie changes nothing.
      const s = scoped(deps.db, feed.tenantId);
      const now = deps.now();
      const body = await buildCalendar(s, feed, deps.origin);
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;

      if (feed.lastFetchedAt === null || now.getTime() - feed.lastFetchedAt.getTime() > LAST_FETCHED_EVERY_MS) {
        const cutoff = new Date(now.getTime() - LAST_FETCHED_EVERY_MS);
        // The filter keeps two fetches at once from both writing.
        await s
          .collection('calendarFeeds')
          .updateOne({ _id: feed._id, $or: [{ lastFetchedAt: null }, { lastFetchedAt: { $lt: cutoff } }] }, { $set: { lastFetchedAt: now } });
      }

      void reply
        .header('cache-control', `private, max-age=${CALENDAR_LIMITS.maxAgeSeconds}`)
        .header('etag', etag)
        .header('x-robots-tag', 'noindex, nofollow');
      if (matches(req.headers['if-none-match'], etag)) return reply.status(304).send();
      return reply.type('text/calendar; charset=utf-8').send(body);
    },
  );
}

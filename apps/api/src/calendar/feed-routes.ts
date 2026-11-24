import {
  DEFAULT_FEED_CHOICES,
  feedChoicesSchema,
  feedLinkSchema,
  feedStateSchema,
  type FeedChoices,
  type FeedLink,
  type FeedState,
} from '@roadmap/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { createAuditLog } from '../audit/audit.ts';
import { newToken } from '../auth/tokens.ts';
import { isDuplicateKey } from '../db/errors.ts';
import type { ScopedDb } from '../db/scoped.ts';
import type { CalendarFeedDoc } from '../db/types.ts';
import { HttpError } from '../errors.ts';

const config = { auth: { level: 'full' } } as const;
const noContent = { 204: z.null().describe('No content') };

/** What happened to the feed, as the audit event records it. */
type FeedChange = 'created' | 'choices' | 'new_link' | 'turned_off';

const toState = (feed: CalendarFeedDoc | null): FeedState => ({
  feed: feed && {
    choices: feed.choices,
    createdAt: feed.createdAt.toISOString(),
    lastFetchedAt: feed.lastFetchedAt?.toISOString() ?? null,
  },
});

/** The feed's URL: the one place the token is ever put into words. */
export const feedUrl = (origin: string, token: string): string => `${origin.replace(/\/+$/, '')}/api/calendar/${token}.ics`;

/** The private calendar feed's settings, for the signed-in person (FR-4.1, FR-4.2, FR-4.4). */
export function registerCalendarFeedRoutes(app: FastifyInstance, deps: { now: () => Date; origin: string }): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = createAuditLog();

  /** An account-level event: no roadmapId, so no roadmap's audit page lists it. Never the token or its hash. */
  const record = (s: ScopedDb, req: FastifyRequest, change: FeedChange, before: FeedChoices | null, after: FeedChoices | null) =>
    audit.record(s, {
      action: 'user.calendar_feed',
      actor: { type: 'user', userId: req.actor!.userId },
      target: { type: 'user', id: req.actor!.userId },
      ...(before !== null && { before: { choices: before } }),
      after: { change, choices: after },
      ip: req.ip,
    });

  const mine = (s: ScopedDb, userId: string) => s.collection('calendarFeeds').findOne({ userId });
  const existing = async (s: ScopedDb, userId: string) => {
    const feed = await mine(s, userId);
    if (!feed) throw new HttpError(404, 'not_found');
    return feed;
  };

  r.get('/api/me/calendar-feed', { config, schema: { response: { 200: feedStateSchema } } }, async (req) => {
    const actor = req.actor!;
    return toState(await mine(actor.db, actor.userId));
  });

  r.post('/api/me/calendar-feed', { config, schema: { response: { 201: feedLinkSchema } } }, async (req, reply) => {
    const actor = req.actor!;
    const { token, hash } = newToken();
    try {
      const link = await actor.db.withTransaction(async (s): Promise<FeedLink> => {
        if (await mine(s, actor.userId)) throw new HttpError(409, 'feed_exists');
        const feed = await s.collection('calendarFeeds').insertOne({
          _id: uuidv7(),
          userId: actor.userId,
          tokenHash: hash,
          choices: DEFAULT_FEED_CHOICES,
          createdAt: deps.now(),
          lastFetchedAt: null,
        });
        await record(s, req, 'created', null, feed.choices);
        return { ...toState(feed), url: feedUrl(deps.origin, token) };
      });
      return reply.status(201).send(link);
    } catch (err) {
      // Two creates at once: the unique index on the person lets one through.
      if (isDuplicateKey(err)) throw new HttpError(409, 'feed_exists');
      throw err;
    }
  });

  r.put(
    '/api/me/calendar-feed/choices',
    { config, schema: { body: feedChoicesSchema, response: { 200: feedStateSchema } } },
    async (req) => {
      const actor = req.actor!;
      const choices: FeedChoices = req.body;
      return actor.db.withTransaction(async (s) => {
        const feed = await existing(s, actor.userId);
        if (choices.roadmaps !== 'all') {
          const chosen = [...new Set(choices.roadmaps)];
          const memberships = await s.collection('memberships').find({ userId: actor.userId, roadmapId: { $in: chosen } });
          if (memberships.length !== chosen.length) throw new HttpError(422, 'unknown_roadmap');
          choices.roadmaps = chosen;
        }
        const updated = await s.collection('calendarFeeds').findOneAndUpdate({ _id: feed._id }, { $set: { choices } });
        await record(s, req, 'choices', feed.choices, choices);
        return toState(updated);
      });
    },
  );

  r.post('/api/me/calendar-feed/new-link', { config, schema: { response: { 200: feedLinkSchema } } }, async (req) => {
    const actor = req.actor!;
    const { token, hash } = newToken();
    return actor.db.withTransaction(async (s): Promise<FeedLink> => {
      const feed = await existing(s, actor.userId);
      // One update: the old hash stops matching the moment the new one is written.
      const updated = await s.collection('calendarFeeds').findOneAndUpdate({ _id: feed._id }, { $set: { tokenHash: hash } });
      await record(s, req, 'new_link', feed.choices, feed.choices);
      return { ...toState(updated), url: feedUrl(deps.origin, token) };
    });
  });

  r.delete('/api/me/calendar-feed', { config, schema: { response: noContent } }, async (req, reply) => {
    const actor = req.actor!;
    await actor.db.withTransaction(async (s) => {
      const feed = await existing(s, actor.userId);
      await s.collection('calendarFeeds').deleteOne({ _id: feed._id });
      await record(s, req, 'turned_off', feed.choices, null);
    });
    return reply.status(204).send(null);
  });
}

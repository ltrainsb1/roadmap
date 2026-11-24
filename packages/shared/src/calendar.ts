import { z } from 'zod';

export const CALENDAR_LIMITS = { events: 5000, roadmaps: 100, fetchesPerMinute: 60, maxAgeSeconds: 300 } as const;

export const feedChoicesSchema = z
  .object({
    roadmaps: z.union([z.literal('all'), z.array(z.string().min(1)).min(1).max(CALENDAR_LIMITS.roadmaps)]),
    itemDates: z.boolean(),
    milestones: z.boolean(),
    onlyMine: z.boolean(),
  })
  .refine((c) => c.itemDates || c.milestones, { message: 'nothing_to_show', path: ['itemDates'] });
export type FeedChoices = z.infer<typeof feedChoicesSchema>;

export const DEFAULT_FEED_CHOICES: FeedChoices = { roadmaps: 'all', itemDates: true, milestones: true, onlyMine: false };

export const feedStateSchema = z.object({
  feed: z.object({ choices: feedChoicesSchema, createdAt: z.string(), lastFetchedAt: z.string().nullable() }).nullable(),
});
export type FeedState = z.infer<typeof feedStateSchema>;

/** Only from create and new-link: the one time the URL is ever returned. */
export const feedLinkSchema = feedStateSchema.extend({ url: z.string() });
export type FeedLink = z.infer<typeof feedLinkSchema>;

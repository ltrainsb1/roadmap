import { z } from 'zod';

export const CALENDAR_LIMITS = { events: 5000, roadmaps: 100, fetchesPerMinute: 60, maxAgeSeconds: 300 } as const;

const roadmapIds = z.array(z.string().min(1)).max(CALENDAR_LIMITS.roadmaps);
const shows = { itemDates: z.boolean(), milestones: z.boolean(), onlyMine: z.boolean() };

export const feedChoicesSchema = z
  .object({ roadmaps: z.union([z.literal('all'), roadmapIds.min(1)]), ...shows })
  .refine((c) => c.itemDates || c.milestones, { message: 'nothing_to_show', path: ['itemDates'] });
export type FeedChoices = z.infer<typeof feedChoicesSchema>;

export const DEFAULT_FEED_CHOICES: FeedChoices = { roadmaps: 'all', itemDates: true, milestones: true, onlyMine: false };

/**
 * The choices as kept and shown. Deleting a roadmap takes it out of every chosen list, so a list can be left empty:
 * it stays empty and shows an empty calendar until the person chooses again.
 */
const keptChoicesSchema = z
  .object({ roadmaps: z.union([z.literal('all'), roadmapIds]), ...shows })
  .refine((c) => c.itemDates || c.milestones, { message: 'nothing_to_show', path: ['itemDates'] });

export const feedStateSchema = z.object({
  feed: z
    .object({
      choices: keptChoicesSchema,
      createdAt: z.string(),
      /** When the current link was made: the feed's createdAt until "Get a new link" makes another (FR-4.4). */
      linkCreatedAt: z.string(),
      lastFetchedAt: z.string().nullable(),
    })
    .nullable(),
});
export type FeedState = z.infer<typeof feedStateSchema>;

/** Only from create and new-link: the one time the URL is ever returned. */
export const feedLinkSchema = feedStateSchema.extend({ url: z.string() });
export type FeedLink = z.infer<typeof feedLinkSchema>;

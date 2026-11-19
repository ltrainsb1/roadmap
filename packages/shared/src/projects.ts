import { z } from 'zod';

export const PROJECT_STATUSES = ['not_started', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PRIORITY_LABELS = ['P1', 'P2', 'P3', 'P4'] as const;
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];
export const MAX_DEPTH = 4;
export const LIMITS = {
  title: 200,
  description: 5000,
  tags: 10,
  tagLength: 30,
  links: 10,
  linkLabel: 80,
  linkUrl: 2000,
  milestones: 20,
  milestoneName: 80,
  blockedBy: 20,
  itemsPerRoadmap: 2000,
} as const;

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

const isRealDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
};

/** A calendar date as `YYYY-MM-DD`, with no time or zone. */
export const calendarDateSchema = z.string().refine(isRealDate, 'invalid_date');

export const tagSchema = z.string().trim().toLowerCase().min(1).max(LIMITS.tagLength);

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};
const urlSchema = z.string().max(LIMITS.linkUrl).refine(isHttpUrl, 'invalid_url');

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const linkSchema = z.object({
  id: z.string(),
  label: z.string().trim().max(LIMITS.linkLabel),
  url: urlSchema,
});
export type ProjectLink = z.infer<typeof linkSchema>;

export const milestoneSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(LIMITS.milestoneName),
  date: calendarDateSchema,
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const projectSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int().min(1).max(MAX_DEPTH),
  path: z.array(z.string()),
  title: z.string(),
  description: z.string(),
  status: z.enum(PROJECT_STATUSES),
  startDate: calendarDateSchema.nullable(),
  endDate: calendarDateSchema.nullable(),
  milestones: z.array(milestoneSchema),
  tags: z.array(z.string()),
  links: z.array(linkSchema),
  blockedBy: z.array(z.string()),
  assigneeIds: z.array(z.string()),
  rank: z.number().int(),
  priorityLabel: z.enum(PRIORITY_LABELS).nullable(),
  archived: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.object({ items: z.array(projectSchema) });
export type ProjectList = z.infer<typeof projectListSchema>;

export const createProjectRequestSchema = z.object({
  parentId: z.string().nullable(),
  title: z.string().trim().min(1).max(LIMITS.title),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** Entries without an `id` are new; the server assigns one. */
const linkInputSchema = linkSchema.extend({ id: z.string().optional() });
const milestoneInputSchema = milestoneSchema.extend({ id: z.string().optional() });

export const updateProjectRequestSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(LIMITS.title).optional(),
    description: z.string().max(LIMITS.description).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    startDate: calendarDateSchema.nullable().optional(),
    endDate: calendarDateSchema.nullable().optional(),
    milestones: z.array(milestoneInputSchema).max(LIMITS.milestones).optional(),
    tags: z.array(tagSchema).max(LIMITS.tags).transform(unique).optional(),
    links: z.array(linkInputSchema).max(LIMITS.links).optional(),
    blockedBy: z.array(z.string()).max(LIMITS.blockedBy).transform(unique).optional(),
  })
  .superRefine((value, ctx) => {
    const { startDate, endDate } = value;
    if (startDate && endDate && endDate < startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'date_order' });
    }
  });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const setAssigneesRequestSchema = z.object({ userIds: z.array(z.string()).max(50) });
export type SetAssigneesRequest = z.infer<typeof setAssigneesRequestSchema>;

export const reorderRequestSchema = z.object({
  parentId: z.string().nullable(),
  orderedIds: z.array(z.string()).min(1).max(LIMITS.itemsPerRoadmap),
});
export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

export const priorityLabelRequestSchema = z.object({ label: z.enum(PRIORITY_LABELS).nullable() });
export type PriorityLabelRequest = z.infer<typeof priorityLabelRequestSchema>;

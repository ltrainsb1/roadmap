import { z } from 'zod';
import { PRIORITY_LABELS, PROJECT_STATUSES, calendarDateSchema, linkSchema, milestoneSchema } from './projects.ts';

export const SNAPSHOT_LIMITS = { name: 80, passwordMin: 10, passwordMax: 128, perRoadmap: 50, notes: 5000, maxExpiryDays: 730 } as const;
export const SNAPSHOT_VIEWS = ['list', 'timeline'] as const;
export type SnapshotView = (typeof SNAPSHOT_VIEWS)[number];

export const snapshotIncludeSchema = z.object({ notes: z.boolean(), assignees: z.boolean() });
export const createSnapshotRequestSchema = z.object({
  name: z.string().trim().min(1).max(SNAPSHOT_LIMITS.name),
  asOf: calendarDateSchema,
  password: z.string().min(SNAPSHOT_LIMITS.passwordMin).max(SNAPSHOT_LIMITS.passwordMax),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  include: snapshotIncludeSchema,
});
export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;
export const createSnapshotResponseSchema = z.object({ id: z.string(), linkId: z.string() });

// Admin list
export const snapshotSummarySchema = z.object({
  id: z.string(),
  linkId: z.string(),
  name: z.string(),
  asOf: calendarDateSchema,
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  expiresAt: z.string().nullable(),
  include: snapshotIncludeSchema,
  itemCount: z.number().int(),
  noteCount: z.number().int(),
  lockedUntil: z.string().nullable(),
  openCount: z.number().int(),
  lastOpenedAt: z.string().nullable(),
});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;
export const snapshotListSchema = z.object({ snapshots: z.array(snapshotSummarySchema) });

// Viewer
export const snapshotItemSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int().min(1).max(4),
  title: z.string(),
  description: z.string(),
  status: z.enum(PROJECT_STATUSES),
  startDate: calendarDateSchema.nullable(),
  endDate: calendarDateSchema.nullable(),
  milestones: z.array(milestoneSchema),
  tags: z.array(z.string()),
  links: z.array(linkSchema),
  blockedBy: z.array(z.string()),
  priorityLabel: z.enum(PRIORITY_LABELS).nullable(),
  rank: z.number().int(),
  /** Names; absent when assignees are not included. */
  assignees: z.array(z.string()).optional(),
  /** Absent when notes are not included. */
  noteCount: z.number().int().optional(),
});
export type SnapshotItem = z.infer<typeof snapshotItemSchema>;
export const snapshotNoteSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  parentId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  mentions: z.array(z.string()),
  createdAt: z.string(),
  edited: z.boolean(),
  deleted: z.boolean(),
});
export type SnapshotNote = z.infer<typeof snapshotNoteSchema>;
export const snapshotContentSchema = z.object({
  roadmapName: z.string(),
  asOf: calendarDateSchema,
  frozenAt: z.string(),
  include: snapshotIncludeSchema,
  items: z.array(snapshotItemSchema),
  /** Only when asked for with `?notes=all`. */
  notes: z.array(snapshotNoteSchema).optional(),
});
export type SnapshotContent = z.infer<typeof snapshotContentSchema>;
export const snapshotNotesSchema = z.object({ notes: z.array(snapshotNoteSchema) });
export const snapshotStatusSchema = z.object({ unlocked: z.boolean() });
export const unlockRequestSchema = z.object({ password: z.string().min(1).max(SNAPSHOT_LIMITS.passwordMax) });
export const snapshotPdfRequestSchema = z.object({ view: z.enum(SNAPSHOT_VIEWS) });

/** 'expired' once `expiresAt` has passed. */
export function snapshotState(s: { expiresAt: string | null }, now: Date): 'active' | 'expired' {
  return s.expiresAt !== null && Date.parse(s.expiresAt) <= now.getTime() ? 'expired' : 'active';
}

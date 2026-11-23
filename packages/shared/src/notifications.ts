import { z } from 'zod';

export const NOTIFICATION_TYPES = ['assigned', 'mentioned', 'dates_changed', 'due_soon'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const EMAIL_MODES = ['instant', 'digest', 'off'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

export type NotificationPrefs = Record<NotificationType, EmailMode>;

export const DEFAULT_PREFS: NotificationPrefs = {
  assigned: 'instant',
  mentioned: 'instant',
  dates_changed: 'digest',
  due_soon: 'digest',
};

export const NOTIFICATION_LIMITS = { excerpt: 200, pageSize: 30, keepDays: 90, dueSoonDays: 3, digestHour: 8 } as const;

const dateRangeSchema = z.object({ startDate: z.string().nullable(), endDate: z.string().nullable() });

export const notificationDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assigned') }),
  z.object({ kind: z.literal('mentioned'), excerpt: z.string() }),
  z.object({ kind: z.literal('dates'), before: dateRangeSchema, after: dateRangeSchema }),
  z.object({ kind: z.literal('milestone'), change: z.enum(['moved', 'added', 'removed']), name: z.string(), date: z.string() }),
  z.object({ kind: z.literal('due_end'), date: z.string() }),
  z.object({ kind: z.literal('due_milestone'), name: z.string(), date: z.string() }),
]);
export type NotificationDetail = z.infer<typeof notificationDetailSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  roadmapId: z.string(),
  roadmapName: z.string(),
  projectId: z.string(),
  projectTitle: z.string(),
  /** Null when there is no actor (see `hasActor`) or the actor's account is gone. */
  actorName: z.string().nullable(),
  hasActor: z.boolean(),
  detail: notificationDetailSchema,
  createdAt: z.string(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unread: z.number().int(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ unread: z.number().int() });
export type UnreadCount = z.infer<typeof unreadCountSchema>;

export const notificationPrefsSchema = z.object({
  assigned: z.enum(EMAIL_MODES),
  mentioned: z.enum(EMAIL_MODES),
  dates_changed: z.enum(EMAIL_MODES),
  due_soon: z.enum(EMAIL_MODES),
});

export const prefsResponseSchema = z.object({ prefs: notificationPrefsSchema, timezone: z.string() });
export type PrefsResponse = z.infer<typeof prefsResponseSchema>;

/** Fixed names, not Intl: short month names differ between ICU versions ("Sep" or "Sept"). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** One calendar date (`YYYY-MM-DD`) as "3 Mar 2027". */
export function formatDayUtc(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!} ${d.getUTCFullYear()}`;
}

/** The row and email sentence, with no trailing full stop when `forSubject`. */
export function notificationSentence(
  n: Pick<Notification, 'projectTitle' | 'actorName' | 'hasActor' | 'detail'>,
  opts?: { forSubject?: boolean },
): string {
  const who = n.actorName ?? 'A former member';
  const title = n.projectTitle;
  const d = n.detail;
  let text: string;
  switch (d.kind) {
    case 'assigned':
      text = `${who} assigned you to ${title}`;
      break;
    case 'mentioned':
      text = `${who} mentioned you on ${title}`;
      break;
    case 'dates':
      text = `${who} changed the dates on ${title}`;
      break;
    case 'milestone':
      text =
        d.change === 'moved'
          ? `${who} moved the milestone ${d.name} on ${title} to ${formatDayUtc(d.date)}`
          : `${who} ${d.change} the milestone ${d.name} on ${title}`;
      break;
    case 'due_end':
      text = `${title} is due ${formatDayUtc(d.date)}`;
      break;
    case 'due_milestone':
      text = `The milestone ${d.name} on ${title} is on ${formatDayUtc(d.date)}`;
      break;
  }
  return opts?.forSubject ? text : `${text}.`;
}

/** Plain text, line breaks as spaces, trimmed, at most 200 characters without splitting a surrogate pair. */
export function noteExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= NOTIFICATION_LIMITS.excerpt) return flat;
  return chars.slice(0, NOTIFICATION_LIMITS.excerpt).join('').trimEnd();
}

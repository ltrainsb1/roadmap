import { NOTIFICATION_LIMITS, type NotificationDetail } from '@roadmap/shared';
import { isDuplicateKey } from '../db/errors.ts';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { ProjectDoc } from '../db/types.ts';
import { notificationRow } from '../notifications/outbox.ts';
import { errorText } from './instant.ts';
import { addDays, localDate } from './local-time.ts';
import type { WorkerDeps } from './run.ts';
import { openItemsWithDates, workerDb } from './worker-db.ts';

interface DueDate {
  /** `end`, or the milestone's id. */
  kind: string;
  date: string;
  detail: NotificationDetail;
}

function dueDates(item: ProjectDoc, from: string, to: string): DueDate[] {
  const inRange = (d: string | null): d is string => d !== null && d >= from && d <= to;
  const dates: DueDate[] = inRange(item.endDate) ? [{ kind: 'end', date: item.endDate, detail: { kind: 'due_end', date: item.endDate } }] : [];
  for (const m of item.milestones) {
    if (inRange(m.date)) dates.push({ kind: m.id, date: m.date, detail: { kind: 'due_milestone', name: m.name, date: m.date } });
  }
  return dates;
}

/** One tenant's reminders: returns how many were written. */
async function forTenant(deps: WorkerDeps, s: ScopedDb, now: Date, from: string, to: string): Promise<number> {
  const items = await s.collection('projects').find(openItemsWithDates(from, to));
  const userIds = [...new Set(items.flatMap((i) => i.assigneeIds))];
  const roadmapIds = [...new Set(items.map((i) => i.roadmapId))];
  const [users, members] = await Promise.all([
    s.collection('users').find({ _id: { $in: userIds } }),
    s.collection('memberships').find({ roadmapId: { $in: roadmapIds }, userId: { $in: userIds } }),
  ]);
  const todayOf = new Map(users.map((u) => [u._id, localDate(now, u.timezone)]));
  const member = new Set(members.map((m) => `${m.roadmapId}:${m.userId}`));

  const candidates = items.flatMap((item) =>
    dueDates(item, from, to).flatMap((due) =>
      item.assigneeIds.flatMap((userId) => {
        const today = todayOf.get(userId);
        if (today === undefined || !member.has(`${item.roadmapId}:${userId}`)) return [];
        if (due.date < today || due.date > addDays(today, NOTIFICATION_LIMITS.dueSoonDays)) return [];
        const dedupeKey = `due:${item._id}:${due.kind}:${due.date}`;
        return [notificationRow({ roadmapId: item.roadmapId, userId, type: 'due_soon', actorId: null, item, detail: due.detail, now, dedupeKey })];
      }),
    ),
  );
  if (candidates.length === 0) return 0;

  // Most candidates were reminded on an earlier pass; one read skips them before any insert is tried.
  const existing = await s.collection('notifications').find({ dedupeKey: { $in: candidates.map((c) => c.dedupeKey!) } });
  const seen = new Set(existing.map((n) => `${n.userId}:${n.dedupeKey}`));
  let written = 0;
  for (const row of candidates) {
    if (seen.has(`${row.userId}:${row.dedupeKey}`)) continue;
    // One at a time and outside any transaction: the unique index refusing a row means a concurrent pass wrote it.
    try {
      await s.collection('notifications').insertOne(row);
      written += 1;
    } catch (err) {
      if (isDuplicateKey(err)) continue;
      deps.log.error({ step: 'due_soon', tenantId: s.tenantId, projectId: row.projectId, err: errorText(err) }, 'reminder failed');
    }
  }
  return written;
}

/**
 * Writes a "due soon" row for each assignee whose item ends, or has a milestone, between their own today and 3 days
 * on. The cross-tenant read looks from yesterday to 4 days ahead in UTC, which covers every zone's window.
 */
export async function writeDueSoon(deps: WorkerDeps): Promise<{ reminders: number }> {
  const now = deps.now();
  const utcToday = localDate(now, 'UTC');
  const from = addDays(utcToday, -1);
  const to = addDays(utcToday, NOTIFICATION_LIMITS.dueSoonDays + 1);
  let reminders = 0;
  for (const tenantId of await workerDb(deps.db).tenantsWithDates(from, to)) {
    try {
      reminders += await forTenant(deps, scoped(deps.db, tenantId), now, from, to);
    } catch (err) {
      deps.log.error({ step: 'due_soon', tenantId, err: errorText(err) }, 'reminders failed for a tenant');
    }
  }
  return { reminders };
}

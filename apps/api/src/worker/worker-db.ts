import type { Db, Filter } from 'mongodb';
import type { NotificationDoc, ProjectDoc } from '../db/types.ts';

// The worker's only reads across tenants: each finds which tenants (and rows or people in them) have work, and
// everything done about that work goes through `scoped()` for that tenant. Collections are looked up per call, so
// one unreachable collection fails only the step that reads it.

/** A row whose email may be handled now: pending and due, or claimed by a pass whose lease has run out. */
export function emailDue(now: Date): Filter<NotificationDoc> {
  return {
    $or: [
      { 'email.state': 'pending', 'email.nextAttemptAt': { $lte: now } },
      { 'email.state': 'sending', 'email.leaseUntil': { $lte: now } },
    ],
  };
}

/** Items that are still open, have someone assigned, and have an end date or milestone from `from` to `to`. */
export function openItemsWithDates(from: string, to: string): Filter<ProjectDoc> {
  const between = { $gte: from, $lte: to };
  return {
    archived: false,
    status: { $nin: ['done', 'cancelled'] },
    'assigneeIds.0': { $exists: true },
    $or: [{ endDate: between }, { milestones: { $elemMatch: { date: between } } }],
  };
}

export function workerDb(db: Db) {
  return {
    /** Up to `limit` rows whose email is due, in `_id` order after `afterId`. */
    dueRows: (now: Date, afterId: string | null, limit: number): Promise<NotificationDoc[]> =>
      db
        .collection<NotificationDoc>('notifications')
        .find(afterId === null ? emailDue(now) : { $and: [emailDue(now), { _id: { $gt: afterId } }] })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray(),

    /** Each person with at least one row whose email is due: the people a digest may be for. */
    async peopleWithDueRows(now: Date): Promise<Array<{ tenantId: string; userId: string }>> {
      const groups = await db
        .collection<NotificationDoc>('notifications')
        .aggregate<{ _id: { tenantId: string; userId: string } }>([
          { $match: emailDue(now) },
          { $group: { _id: { tenantId: '$tenantId', userId: '$userId' } } },
        ])
        .toArray();
      return groups.map((g) => g._id);
    },

    /** The tenants with open, assigned items that have a date from `from` to `to`. */
    tenantsWithDates: async (from: string, to: string): Promise<string[]> =>
      db.collection<ProjectDoc>('projects').distinct('tenantId', openItemsWithDates(from, to)),
  };
}

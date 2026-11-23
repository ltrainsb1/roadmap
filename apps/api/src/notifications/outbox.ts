import { noteExcerpt, type Milestone, type NotificationDetail, type NotificationType } from '@roadmap/shared';
import { v7 as uuidv7 } from 'uuid';
import type { ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, ProjectDoc } from '../db/types.ts';

// Each function runs inside the caller's transaction, after the change it reports, so a change that rolls back leaves
// no row. None writes a row for the actor or for anyone who is not a member of the roadmap when it runs.

interface Event {
  roadmapId: string;
  item: ProjectDoc;
  actorId: string;
  now: Date;
}

/** One row per recipient and detail; drops the actor and anyone not a member of the roadmap. */
async function write(
  s: ScopedDb,
  e: Event,
  type: NotificationType,
  userIds: string[],
  details: NotificationDetail[],
): Promise<void> {
  const candidates = [...new Set(userIds)].filter((id) => id !== e.actorId);
  if (candidates.length === 0 || details.length === 0) return;
  const members = await s.collection('memberships').find({ roadmapId: e.roadmapId, userId: { $in: candidates } });
  const memberIds = new Set(members.map((m) => m.userId));
  const recipients = candidates.filter((id) => memberIds.has(id));
  if (recipients.length === 0) return;
  // The guard against a concurrent member removal: removal deletes these same membership documents, so one of the two
  // transactions conflicts and retries. Either the removal sees this row and deletes it, or this sees no membership.
  await s
    .collection('memberships')
    .updateMany({ _id: { $in: members.map((m) => m._id) } }, { $inc: { notifyRevision: 1 } });
  const rows: Array<Omit<NotificationDoc, 'tenantId'>> = recipients.flatMap((userId) =>
    details.map((detail) => ({
      _id: uuidv7(),
      roadmapId: e.roadmapId,
      userId,
      type,
      actorId: e.actorId,
      projectId: e.item._id,
      projectTitle: e.item.title,
      detail,
      createdAt: e.now,
      readAt: null,
      email: { state: 'pending', attempts: 0, nextAttemptAt: e.now, leaseUntil: null, sentAt: null },
    })),
  );
  await s.collection('notifications').insertMany(rows);
}

/** "Assigned" for each person newly added to the item's assignees. */
export async function notifyAssigned(
  s: ScopedDb,
  e: { roadmapId: string; item: ProjectDoc; actorId: string; addedUserIds: string[]; now: Date },
): Promise<void> {
  await write(s, e, 'assigned', e.addedUserIds, [{ kind: 'assigned' }]);
}

/** The milestone rows: added and re-dated ones (by id) in the new order, then removed ones. A rename alone is none. */
function milestoneDetails(before: Milestone[], after: Milestone[]): NotificationDetail[] {
  const old = new Map(before.map((m) => [m.id, m]));
  const kept = new Set(after.map((m) => m.id));
  const changed = after.flatMap((m): NotificationDetail[] => {
    const was = old.get(m.id);
    if (!was) return [{ kind: 'milestone', change: 'added', name: m.name, date: m.date }];
    return was.date === m.date ? [] : [{ kind: 'milestone', change: 'moved', name: m.name, date: m.date }];
  });
  const removed = before
    .filter((m) => !kept.has(m.id))
    .map((m): NotificationDetail => ({ kind: 'milestone', change: 'removed', name: m.name, date: m.date }));
  return [...changed, ...removed];
}

/**
 * "Dates changed" for the item's assignees after the change: one row for a new start or end date, and one per
 * milestone added, removed or re-dated.
 */
export async function notifyDatesChanged(
  s: ScopedDb,
  e: { roadmapId: string; before: ProjectDoc; after: ProjectDoc; actorId: string; now: Date },
): Promise<void> {
  const { before, after } = e;
  const details: NotificationDetail[] = [];
  if (before.startDate !== after.startDate || before.endDate !== after.endDate) {
    details.push({
      kind: 'dates',
      before: { startDate: before.startDate, endDate: before.endDate },
      after: { startDate: after.startDate, endDate: after.endDate },
    });
  }
  details.push(...milestoneDetails(before.milestones, after.milestones));
  await write(s, { ...e, item: after }, 'dates_changed', after.assigneeIds, details);
}

/** "Mentioned" for each person given, with a plain excerpt of the note. On an edit, pass only the newly mentioned. */
export async function notifyMentioned(
  s: ScopedDb,
  e: { roadmapId: string; item: ProjectDoc; actorId: string; noteBody: string; userIds: string[]; now: Date },
): Promise<void> {
  await write(s, e, 'mentioned', e.userIds, [{ kind: 'mentioned', excerpt: noteExcerpt(e.noteBody) }]);
}

import { DEFAULT_PREFS, type Notification, type NotificationPrefs } from '@roadmap/shared';
import type { ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';

/** The person's email settings: what they chose, and the defaults for the rest. */
export const effectivePrefs = (user: UserDoc): NotificationPrefs => ({ ...DEFAULT_PREFS, ...user.notificationPrefs });

/**
 * Rows as the list and the emails show them: with the roadmap's current name and the actor's current name. A roadmap
 * that is gone reads as '', an actor whose account is gone as null.
 */
export async function toNotifications(db: ScopedDb, rows: NotificationDoc[]): Promise<Notification[]> {
  const actorIds = [...new Set(rows.flatMap((n) => (n.actorId === null ? [] : [n.actorId])))];
  const roadmapIds = [...new Set(rows.map((n) => n.roadmapId))];
  const [users, roadmaps] = await Promise.all([
    actorIds.length > 0 ? db.collection('users').find({ _id: { $in: actorIds } }) : [],
    roadmapIds.length > 0 ? db.collection('roadmaps').find({ _id: { $in: roadmapIds } }) : [],
  ]);
  const userNames = new Map(users.map((u) => [u._id, u.name]));
  const roadmapNames = new Map(roadmaps.map((m) => [m._id, m.name]));
  return rows.map((n) => ({
    id: n._id,
    type: n.type,
    roadmapId: n.roadmapId,
    roadmapName: roadmapNames.get(n.roadmapId) ?? '',
    projectId: n.projectId,
    projectTitle: n.projectTitle,
    actorName: n.actorId === null ? null : (userNames.get(n.actorId) ?? null),
    hasActor: n.actorId !== null,
    detail: n.detail,
    createdAt: n.createdAt.toISOString(),
    read: n.readAt !== null,
  }));
}

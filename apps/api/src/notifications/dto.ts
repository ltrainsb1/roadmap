import { DEFAULT_PREFS, type Notification, type NotificationPrefs } from '@roadmap/shared';
import type { ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';

/** The person's email settings: what they chose, and the defaults for the rest. */
export const effectivePrefs = (user: UserDoc): NotificationPrefs => ({ ...DEFAULT_PREFS, ...user.notificationPrefs });

/**
 * Rows as the list and the emails show them: with the roadmap's current name and the actor's current name. Rows whose
 * roadmap or item is gone are left out: a cascade is deleting them, or (for a due-soon reminder written just after the
 * item's delete) it missed them. An actor whose account is gone reads as null.
 */
export async function toNotifications(db: ScopedDb, rows: NotificationDoc[]): Promise<Notification[]> {
  const actorIds = [...new Set(rows.flatMap((n) => (n.actorId === null ? [] : [n.actorId])))];
  const roadmapIds = [...new Set(rows.map((n) => n.roadmapId))];
  const projectIds = [...new Set(rows.map((n) => n.projectId))];
  const [users, roadmaps, projects] = await Promise.all([
    actorIds.length > 0 ? db.collection('users').find({ _id: { $in: actorIds } }) : [],
    roadmapIds.length > 0 ? db.collection('roadmaps').find({ _id: { $in: roadmapIds } }) : [],
    projectIds.length > 0 ? db.collection('projects').find({ _id: { $in: projectIds } }) : [],
  ]);
  const userNames = new Map(users.map((u) => [u._id, u.name]));
  const roadmapNames = new Map(roadmaps.map((m) => [m._id, m.name]));
  const items = new Set(projects.map((p) => `${p.roadmapId}:${p._id}`));
  return rows.flatMap((n): Notification[] => {
    const roadmapName = roadmapNames.get(n.roadmapId);
    if (roadmapName === undefined || !items.has(`${n.roadmapId}:${n.projectId}`)) return [];
    return [
      {
        id: n._id,
        type: n.type,
        roadmapId: n.roadmapId,
        roadmapName,
        projectId: n.projectId,
        projectTitle: n.projectTitle,
        actorName: n.actorId === null ? null : (userNames.get(n.actorId) ?? null),
        hasActor: n.actorId !== null,
        detail: n.detail,
        createdAt: n.createdAt.toISOString(),
        read: n.readAt !== null,
      },
    ];
  });
}

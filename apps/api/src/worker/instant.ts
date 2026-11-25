import type { Notification } from '@roadmap/shared';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';
import { effectivePrefs, toNotifications } from '../notifications/dto.ts';
import { signUnsubscribe } from '../mail/unsubscribe.ts';
import { instantEmail } from './emails.ts';
import type { WorkerDeps } from './run.ts';
import { workerDb } from '../db/worker-db.ts';
import { claim, dropGone, errorText, markFailed, markSent, skip } from './claims.ts';

const BATCH = 100;

/** The batch as the emails show it (current roadmap and actor names), with one lookup per tenant. */
async function asShown(deps: WorkerDeps, batch: NotificationDoc[]): Promise<Map<string, Notification>> {
  const byTenant = new Map<string, NotificationDoc[]>();
  for (const r of batch) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
  const shown = new Map<string, Notification>();
  for (const [tenantId, rows] of byTenant) {
    for (const n of await toNotifications(scoped(deps.db, tenantId), rows)) shown.set(n.id, n);
  }
  return shown;
}

/** Sends each due row whose recipient wants it instantly; skips those turned off; leaves the digest's alone. */
export async function sendInstant(deps: WorkerDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now();
  const users = new Map<string, Promise<UserDoc | null>>();
  const memberships = new Map<string, Promise<boolean>>();
  const userOf = (s: ScopedDb, userId: string) => {
    const key = `${s.tenantId}:${userId}`;
    if (!users.has(key)) users.set(key, s.collection('users').findOne({ _id: userId }));
    return users.get(key)!;
  };
  const isMember = (s: ScopedDb, roadmapId: string, userId: string) => {
    const key = `${s.tenantId}:${roadmapId}:${userId}`;
    if (!memberships.has(key)) {
      memberships.set(key, s.collection('memberships').findOne({ roadmapId, userId }).then((m) => m !== null));
    }
    return memberships.get(key)!;
  };

  async function handle(r: NotificationDoc, shown: Map<string, Notification>): Promise<'sent' | 'failed' | null> {
    const s = scoped(deps.db, r.tenantId);
    const user = await userOf(s, r.userId);
    // Not shown: the item or roadmap is gone (see toNotifications). The row goes, whatever the email setting.
    const n = shown.get(r._id);
    if (!n) {
      await dropGone(s, r._id);
      return null;
    }
    const mode = user ? effectivePrefs(user)[r.type] : 'off';
    if (mode === 'digest') return null;
    if (!user || mode === 'off' || !(await isMember(s, r.roadmapId, r.userId))) {
      await skip(s, r._id, now);
      return null;
    }
    const claimed = await claim(s, r._id, deps.now());
    if (!claimed) return null;
    try {
      await deps.mailer.send({ to: user.email, ...instantEmail(n, {
          appOrigin: deps.appOrigin,
          timeZone: user.timezone,
          unsubscribeToken: signUnsubscribe(deps.unsubscribeKey, r.tenantId, r.userId),
        }) });
    } catch (err) {
      const attempts = await markFailed(s, claimed, deps.now());
      deps.log.error({ step: 'instant', notificationId: r._id, attempts, err: errorText(err) }, 'email failed');
      return 'failed';
    }
    await markSent(s, claimed, deps.now());
    return 'sent';
  }

  const counts = { sent: 0, failed: 0 };
  const rows = workerDb(deps.db);
  let after: string | null = null;
  for (;;) {
    const batch = await rows.dueRows(now, after, BATCH);
    const shown = await asShown(deps, batch);
    for (const r of batch) {
      try {
        const out = await handle(r, shown);
        if (out) counts[out] += 1;
      } catch (err) {
        deps.log.error({ step: 'instant', notificationId: r._id, err: errorText(err) }, 'notification failed');
      }
    }
    if (batch.length < BATCH) break;
    after = batch[batch.length - 1]!._id;
  }
  return counts;
}

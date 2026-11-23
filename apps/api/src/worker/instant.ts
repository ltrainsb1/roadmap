import type { Notification } from '@roadmap/shared';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';
import { effectivePrefs, toNotifications } from '../notifications/dto.ts';
import { instantEmail } from './emails.ts';
import type { WorkerDeps } from './run.ts';
import { emailDue, workerDb } from './worker-db.ts';

/** How long a claim keeps other passes off a row; a pass that dies holding one gives it up after this. */
export const LEASE_MS = 5 * 60_000;
/** The waits after the 1st to 4th failed send; the 5th failure marks the row failed. */
export const RETRY_MINUTES = [1, 5, 15, 60] as const;
const BATCH = 100;

/** An error as one log line: never an email address (a provider may name the recipient). */
export function errorText(err: unknown): string {
  return String(err)
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[email]')
    .slice(0, 500);
}

/** Claims a row for sending with one conditional update; null when another pass has it or it is no longer due. */
export function claim(s: ScopedDb, id: string, now: Date): Promise<NotificationDoc | null> {
  return s
    .collection('notifications')
    .findOneAndUpdate(
      { $and: [{ _id: id }, emailDue(now)] },
      { $set: { 'email.state': 'sending', 'email.leaseUntil': new Date(now.getTime() + LEASE_MS) } },
    );
}

/** The claimed row, while this pass still holds its claim. */
const held = (r: NotificationDoc) => ({ _id: r._id, 'email.state': 'sending' as const, 'email.leaseUntil': r.email.leaseUntil });

export async function markSent(s: ScopedDb, r: NotificationDoc, now: Date): Promise<void> {
  await s
    .collection('notifications')
    .updateOne(held(r), { $set: { 'email.state': 'sent', 'email.sentAt': now, 'email.leaseUntil': null } });
}

/** Back to pending with the next retry due, or failed after the fifth try. */
export async function markFailed(s: ScopedDb, r: NotificationDoc, now: Date): Promise<number> {
  const attempts = r.email.attempts + 1;
  const wait = RETRY_MINUTES[attempts - 1];
  await s.collection('notifications').updateOne(held(r), {
    $set:
      wait === undefined
        ? { 'email.state': 'failed', 'email.attempts': attempts, 'email.leaseUntil': null }
        : {
            'email.state': 'pending',
            'email.attempts': attempts,
            'email.nextAttemptAt': new Date(now.getTime() + wait * 60_000),
            'email.leaseUntil': null,
          },
  });
  return attempts;
}

/** No email for this row, unless another pass has claimed it meanwhile. */
export async function skip(s: ScopedDb, id: string, now: Date): Promise<void> {
  await s
    .collection('notifications')
    .updateOne({ $and: [{ _id: id }, emailDue(now)] }, { $set: { 'email.state': 'skipped', 'email.leaseUntil': null } });
}

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
    const mode = user ? effectivePrefs(user)[r.type] : 'off';
    if (mode === 'digest') return null;
    if (!user || mode === 'off' || !(await isMember(s, r.roadmapId, r.userId))) {
      await skip(s, r._id, now);
      return null;
    }
    const claimed = await claim(s, r._id, now);
    if (!claimed) return null;
    const n = shown.get(r._id)!;
    try {
      await deps.mailer.send({ to: user.email, ...instantEmail(n, { appOrigin: deps.appOrigin, timeZone: user.timezone }) });
    } catch (err) {
      const attempts = await markFailed(s, claimed, now);
      deps.log.error({ step: 'instant', notificationId: r._id, attempts, err: errorText(err) }, 'email failed');
      return 'failed';
    }
    await markSent(s, claimed, now);
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

import { NOTIFICATION_LIMITS, NOTIFICATION_TYPES } from '@roadmap/shared';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';
import { effectivePrefs, toNotifications } from '../notifications/dto.ts';
import { digestEmail } from './emails.ts';
import { claim, errorText, markFailed, markSent, skip } from './instant.ts';
import { localDate, localHour } from './local-time.ts';
import type { WorkerDeps } from './run.ts';
import { emailDue, workerDb } from './worker-db.ts';

/** Gives the day back, so the digest goes out on a later pass today. */
async function releaseDay(s: ScopedDb, user: UserDoc, today: string): Promise<void> {
  const prev = user.digestSentOn;
  await s
    .collection('users')
    .updateOne({ _id: user._id, digestSentOn: today }, prev === undefined ? { $unset: { digestSentOn: '' } } : { $set: { digestSentOn: prev } });
}

/** One person's digest, if one is due: 'sent', 'failed', or null when there was nothing to send. */
async function forPerson(deps: WorkerDeps, s: ScopedDb, userId: string, now: Date): Promise<'sent' | 'failed' | null> {
  const user = await s.collection('users').findOne({ _id: userId });
  if (!user) return null;
  const prefs = effectivePrefs(user);
  const types = NOTIFICATION_TYPES.filter((type) => prefs[type] === 'digest');
  if (types.length === 0 || localHour(now, user.timezone) < NOTIFICATION_LIMITS.digestHour) return null;
  const today = localDate(now, user.timezone);
  if (user.digestSentOn === today) return null;
  const notifications = s.collection('notifications');
  const waiting = await notifications.find({ $and: [{ userId, type: { $in: types } }, emailDue(now)] }, { sort: { createdAt: 1, _id: 1 } });
  if (waiting.length === 0) return null;

  // The day is claimed once, from the value just read: of two passes, only one gets it.
  const claimedDay = await s
    .collection('users')
    .updateOne(
      { _id: userId, digestSentOn: user.digestSentOn === undefined ? { $exists: false } : user.digestSentOn },
      { $set: { digestSentOn: today } },
    );
  if (claimedDay.matched === 0) return null;

  const memberships = await s.collection('memberships').find({ userId, roadmapId: { $in: [...new Set(waiting.map((r) => r.roadmapId))] } });
  const mine = new Set(memberships.map((m) => m.roadmapId));
  const rows: NotificationDoc[] = [];
  for (const r of waiting) {
    if (!mine.has(r.roadmapId)) {
      await skip(s, r._id, now);
      continue;
    }
    // Claimed like an instant email, so a switch to "instantly" meanwhile can't send a row twice.
    const claimed = await claim(s, r._id, now);
    if (claimed) rows.push(claimed);
  }
  if (rows.length === 0) {
    await releaseDay(s, user, today);
    return null;
  }

  const content = digestEmail(await toNotifications(s, rows), { appOrigin: deps.appOrigin, date: today });
  try {
    await deps.mailer.send({ to: user.email, ...content });
  } catch (err) {
    await releaseDay(s, user, today);
    for (const r of rows) await markFailed(s, r, now);
    deps.log.error({ step: 'digest', tenantId: s.tenantId, userId, rows: rows.length, err: errorText(err) }, 'digest failed');
    return 'failed';
  }
  for (const r of rows) await markSent(s, r, now);
  return 'sent';
}

/** Sends each person's digest at 8 am or later in their zone, once per local day, when something is waiting. */
export async function sendDigests(deps: WorkerDeps): Promise<{ digests: number; failed: number }> {
  const now = deps.now();
  const counts = { digests: 0, failed: 0 };
  for (const { tenantId, userId } of await workerDb(deps.db).peopleWithDueRows(now)) {
    try {
      const out = await forPerson(deps, scoped(deps.db, tenantId), userId, now);
      if (out === 'sent') counts.digests += 1;
      if (out === 'failed') counts.failed += 1;
    } catch (err) {
      deps.log.error({ step: 'digest', tenantId, userId, err: errorText(err) }, 'digest failed for a person');
    }
  }
  return counts;
}

import { NOTIFICATION_LIMITS, NOTIFICATION_TYPES } from '@roadmap/shared';
import { scoped, type ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc, UserDoc } from '../db/types.ts';
import { effectivePrefs, toNotifications } from '../notifications/dto.ts';
import { signUnsubscribe } from '../mail/unsubscribe.ts';
import { digestEmail } from './emails.ts';
import { claim, dropGone, errorText, markFailed, markSent, skip } from './claims.ts';
import { localDate, localHour } from './local-time.ts';
import type { WorkerDeps } from './run.ts';
import { emailDue, workerDb } from '../db/worker-db.ts';

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
  // The instant step skips a blocked person's rows (digest ones too); a digest is never built for them.
  if (!user || user.emailBlocked) return null;
  const prefs = effectivePrefs(user);
  const types = NOTIFICATION_TYPES.filter((type) => prefs[type] === 'digest');
  if (types.length === 0 || localHour(now, user.timezone) < NOTIFICATION_LIMITS.digestHour) return null;
  const today = localDate(now, user.timezone);
  if (user.digestSentOn === today) return null;
  const notifications = s.collection('notifications');
  // Plan decision: the digest arrives at 8 am. A day's digest takes only rows written before 8:00 local time that day;
  // later ones wait for tomorrow's, so a quiet morning never turns the first change after 8 into its own email. A
  // worker that was down at 8 still sends on its next pass, with the same rows.
  const beforeEight = (at: Date) =>
    localDate(at, user.timezone) < today || localHour(at, user.timezone) < NOTIFICATION_LIMITS.digestHour;
  const waiting = (
    await notifications.find({ $and: [{ userId, type: { $in: types } }, emailDue(now)] }, { sort: { createdAt: 1, _id: 1 } })
  ).filter((r) => beforeEight(r.createdAt));
  if (waiting.length === 0) return null;

  // The day is claimed once, from the value just read: of two passes, only one gets it. A crash between this claim and
  // the send leaves the day taken and the rows pending (or leased, then due again), so that digest moves to the next
  // day: late, not lost, not doubled.
  const claimedDay = await s
    .collection('users')
    .updateOne(
      { _id: userId, digestSentOn: user.digestSentOn === undefined ? { $exists: false } : user.digestSentOn },
      { $set: { digestSentOn: today } },
    );
  if (claimedDay.matched === 0) return null;

  const [memberships, items] = await Promise.all([
    s.collection('memberships').find({ userId, roadmapId: { $in: [...new Set(waiting.map((r) => r.roadmapId))] } }),
    s.collection('projects').find({ _id: { $in: [...new Set(waiting.map((r) => r.projectId))] } }),
  ]);
  const mine = new Set(memberships.map((m) => m.roadmapId));
  // A row can outlive its item's delete (a due-soon reminder written just after it); it is deleted, in no digest.
  const live = new Set(items.map((p) => `${p.roadmapId}:${p._id}`));
  const rows: NotificationDoc[] = [];
  for (const r of waiting) {
    if (!live.has(`${r.roadmapId}:${r.projectId}`)) {
      await dropGone(s, r._id);
      continue;
    }
    if (!mine.has(r.roadmapId)) {
      await skip(s, r._id, now);
      continue;
    }
    // Claimed like an instant email, so a switch to "instantly" meanwhile can't send a row twice.
    const claimed = await claim(s, r._id, deps.now());
    if (claimed) rows.push(claimed);
  }
  if (rows.length === 0) {
    await releaseDay(s, user, today);
    return null;
  }

  const content = digestEmail(await toNotifications(s, rows), {
    appOrigin: deps.appOrigin,
    date: today,
    unsubscribeToken: signUnsubscribe(deps.unsubscribeKey, s.tenantId, userId),
  });
  try {
    await deps.mailer.send({ to: user.email, ...content });
  } catch (err) {
    await releaseDay(s, user, today);
    for (const r of rows) await markFailed(s, r, deps.now());
    deps.log.error({ step: 'digest', tenantId: s.tenantId, userId, rows: rows.length, err: errorText(err) }, 'digest failed');
    return 'failed';
  }
  for (const r of rows) await markSent(s, r, deps.now());
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

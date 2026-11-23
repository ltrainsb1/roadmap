import type { ScopedDb } from '../db/scoped.ts';
import type { NotificationDoc } from '../db/types.ts';
import { emailDue } from '../db/worker-db.ts';

// Claims and retries shared by the instant and digest steps. Every time written here (a lease, a sent time, the next
// try) is the moment the caller passes in, read from the clock just then, never a step's start time: a pass that runs
// long must not hand out leases that have already run out.

/** How long a claim keeps other passes off a row; a pass that dies holding one gives it up after this. */
export const LEASE_MS = 5 * 60_000;
/** The waits after the 1st to 4th failed send; the 5th failure marks the row failed. */
export const RETRY_MINUTES = [1, 5, 15, 60] as const;

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

/**
 * Deletes a row whose item (or roadmap) is gone: a due-soon reminder written just after its item's delete outlives
 * the cascade. Deleting it, whatever the email setting, keeps the unread count in step with the list.
 */
export async function dropGone(s: ScopedDb, id: string): Promise<void> {
  await s.collection('notifications').deleteOne({ _id: id });
}

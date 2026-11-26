import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createAuditLog } from '../audit/audit.ts';
import { scoped } from '../db/scoped.ts';
import { workerDb } from '../db/worker-db.ts';
import { errorText } from './claims.ts';
import type { WorkerDeps } from './run.ts';

/** The part of the SQS client we use, so tests can stand in for it. */
export interface SqsLikeClient {
  send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown>;
}

const BATCH = 10;
const MAX_BATCHES = 10;

type Reason = 'bounced' | 'complained';

/** The addresses and reason an SES event asks us to block, or null for anything else (SNS delivers the event JSON as is). */
function blockFrom(body: string | undefined): { reason: Reason; addresses: string[] } | null {
  let event: unknown;
  try {
    event = JSON.parse(body ?? '');
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;
  const e = event as {
    eventType?: unknown;
    bounce?: { bounceType?: unknown; bouncedRecipients?: Array<{ emailAddress?: unknown }> };
    complaint?: { complainedRecipients?: Array<{ emailAddress?: unknown }> };
  };
  const emails = (list: Array<{ emailAddress?: unknown }> | undefined): string[] =>
    Array.isArray(list) ? list.flatMap((r) => (typeof r?.emailAddress === 'string' && r.emailAddress !== '' ? [r.emailAddress] : [])) : [];
  if (e.eventType === 'Bounce' && e.bounce?.bounceType === 'Permanent') return { reason: 'bounced', addresses: emails(e.bounce.bouncedRecipients) };
  if (e.eventType === 'Complaint') return { reason: 'complained', addresses: emails(e.complaint?.complainedRecipients) };
  return null;
}

/**
 * Stops notification emails to addresses SES reports: a permanent bounce or a spam complaint blocks every user with that
 * address, in every tenant (the first reason and date stay). Reads up to 10 batches of 10 messages without waiting, so a
 * pass never sits on an empty queue. Every message is deleted once handled, ignored ones too; a delete that fails is
 * logged and the message comes back later, when handling it changes nothing. Does nothing when no queue is configured.
 */
export async function sesEventsStep(deps: WorkerDeps): Promise<{ blocked: number; ignored: number }> {
  const counts = { blocked: 0, ignored: 0 };
  const { sqs, sesEventsQueueUrl: queue } = deps;
  if (!sqs || !queue) return counts;
  const audit = createAuditLog();
  const rows = workerDb(deps.db);

  async function block(address: string, reason: Reason): Promise<number> {
    let blocked = 0;
    for (const { tenantId, userId } of await rows.usersWithEmail(address)) {
      const done = await scoped(deps.db, tenantId).withTransaction(async (s) => {
        const at = deps.now();
        const set = await s.collection('users').updateOne({ _id: userId, emailBlocked: { $exists: false } }, { $set: { emailBlocked: { reason, at } } });
        if (set.matched === 0) return false;
        await audit.record(s, {
          action: 'user.email_blocked',
          actor: { type: 'system' },
          target: { type: 'user', id: userId },
          after: { reason },
          ip: null,
        });
        return true;
      });
      if (done) blocked += 1;
    }
    return blocked;
  }

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const got = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: BATCH, WaitTimeSeconds: 0 }))) as {
      Messages?: Array<{ MessageId?: string; ReceiptHandle?: string; Body?: string }>;
    };
    const messages = got.Messages ?? [];
    for (const m of messages) {
      let blocked = 0;
      try {
        const found = blockFrom(m.Body);
        if (found) for (const address of new Set(found.addresses)) blocked += await block(address, found.reason);
      } catch (err) {
        // Left in the queue: it is delivered again once its visibility timeout ends.
        deps.log.error({ step: 'ses_events', messageId: m.MessageId, err: errorText(err) }, 'SES event not handled');
        continue;
      }
      if (blocked > 0) counts.blocked += blocked;
      else counts.ignored += 1;
      try {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: m.ReceiptHandle! }));
      } catch (err) {
        deps.log.error({ step: 'ses_events', messageId: m.MessageId, err: errorText(err) }, 'SES event message not deleted');
      }
    }
    if (messages.length < BATCH) break;
  }
  return counts;
}

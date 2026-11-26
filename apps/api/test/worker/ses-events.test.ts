import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import type { AuditEventDoc, UserDoc } from '../../src/db/types.ts';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { runPass } from '../../src/worker/run.ts';
import { sesEventsStep, type SqsLikeClient } from '../../src/worker/ses-events.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { clock, person, row, workerDeps } from './fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/roadmap-ses-events';
const T0 = '2026-11-22T12:00:00.000Z';

/** A queue that hands out messages in order and records what was asked of it. */
class FakeSqs implements SqsLikeClient {
  waiting: Array<{ MessageId: string; ReceiptHandle: string; Body: string }> = [];
  deleted: string[] = [];
  received: ReceiveMessageCommand['input'][] = [];
  failDeletes = false;
  push(body: unknown): void {
    const n = this.waiting.length + this.deleted.length + 1;
    this.waiting.push({ MessageId: `m${n}`, ReceiptHandle: `h${n}`, Body: typeof body === 'string' ? body : JSON.stringify(body) });
  }
  send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown> {
    if (command instanceof ReceiveMessageCommand) {
      this.received.push(command.input);
      return Promise.resolve({ Messages: this.waiting.splice(0, command.input.MaxNumberOfMessages ?? 1) });
    }
    if (this.failDeletes) return Promise.reject(new Error('sqs down'));
    this.deleted.push(command.input.ReceiptHandle!);
    return Promise.resolve({});
  }
}

const bounce = (email: string, bounceType = 'Permanent') => ({
  eventType: 'Bounce',
  bounce: { bounceType, bouncedRecipients: [{ emailAddress: email }] },
});
const complaint = (email: string) => ({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: email }] } });

const userNow = (u: UserDoc) => scoped(t.db, u.tenantId).collection('users').findOne({ _id: u._id });

function setup() {
  const c = clock(T0);
  const sqs = new FakeSqs();
  const deps = { ...workerDeps(t, c), sqs, sesEventsQueueUrl: QUEUE };
  return { c, sqs, deps };
}

async function twoTenants(email: string) {
  const a = (await t.seed.tenant())._id;
  const b = (await t.seed.tenant())._id;
  const ua = await t.seed.user(a, { email });
  const ub = await t.seed.user(b, { email: email.toUpperCase().replace('@EXAMPLE.COM', '@Example.com') });
  return { ua, ub };
}

describe('worker: SES events', () => {
  test('FR-5: a Permanent bounce blocks every user with that address, in every tenant, with reason bounced, and deletes the message', async () => {
    const { c, sqs, deps } = setup();
    const email = `bounce-${Date.now()}@example.com`;
    const { ua, ub } = await twoTenants(email);
    sqs.push(bounce(email));
    expect(await sesEventsStep(deps)).toEqual({ blocked: 2, ignored: 0 });
    for (const u of [ua, ub]) expect((await userNow(u))!.emailBlocked).toEqual({ reason: 'bounced', at: c.now() });
    expect(sqs.deleted).toEqual(['h1']);
    expect(JSON.stringify(deps.lines)).not.toContain(email);
  });

  test('FR-5: a Complaint blocks with reason complained', async () => {
    const { c, sqs, deps } = setup();
    const email = `spam-${Date.now()}@example.com`;
    const u = await t.seed.user((await t.seed.tenant())._id, { email });
    sqs.push(complaint(email));
    expect(await sesEventsStep(deps)).toEqual({ blocked: 1, ignored: 0 });
    expect((await userNow(u))!.emailBlocked).toEqual({ reason: 'complained', at: c.now() });
  });

  test('FR-5: a Transient bounce, a Delivery event, a body that isn\'t JSON, an address nobody has, and an SNS SubscriptionConfirmation body change no user and delete the message', async () => {
    const { sqs, deps } = setup();
    const email = `fine-${Date.now()}@example.com`;
    const u = await t.seed.user((await t.seed.tenant())._id, { email });
    sqs.push(bounce(email, 'Transient'));
    sqs.push({ eventType: 'Delivery', delivery: { recipients: [email] } });
    sqs.push('this is not json');
    sqs.push(bounce(`nobody-${Date.now()}@example.com`));
    sqs.push({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.example/confirm', Token: 'x' });
    expect(await sesEventsStep(deps)).toEqual({ blocked: 0, ignored: 5 });
    expect((await userNow(u))!.emailBlocked).toBeUndefined();
    expect(sqs.deleted).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
  });

  test('FR-5: a user already blocked keeps the first reason and date', async () => {
    const { c, sqs, deps } = setup();
    const email = `twice-${Date.now()}@example.com`;
    const u = await t.seed.user((await t.seed.tenant())._id, { email });
    sqs.push(bounce(email));
    await sesEventsStep(deps);
    const first = (await userNow(u))!.emailBlocked;
    c.set('2026-11-23T12:00:00.000Z');
    sqs.push(complaint(email));
    expect(await sesEventsStep(deps)).toEqual({ blocked: 0, ignored: 1 });
    expect((await userNow(u))!.emailBlocked).toEqual(first);
    const events = await t.db.collection<AuditEventDoc>('auditEvents').find({ tenantId: u.tenantId, action: 'user.email_blocked' }).toArray();
    expect(events).toHaveLength(1);
  });

  test("FR-5: each new block records user.email_blocked with actor { type: 'system' }", async () => {
    const { sqs, deps } = setup();
    const email = `audit-${Date.now()}@example.com`;
    const u = await t.seed.user((await t.seed.tenant())._id, { email });
    sqs.push(complaint(email));
    await sesEventsStep(deps);
    const events = await t.db.collection<AuditEventDoc>('auditEvents').find({ tenantId: u.tenantId, action: 'user.email_blocked' }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { type: 'system' }, target: { type: 'user', id: u._id }, after: { reason: 'complained' } });
    expect(JSON.stringify(events[0]!.after)).not.toContain(email);
  });

  test('FR-5: a failed delete is logged, the step goes on, and the message is handled again harmlessly on its next delivery', async () => {
    const { sqs, deps } = setup();
    const email = `redeliver-${Date.now()}@example.com`;
    const u = await t.seed.user((await t.seed.tenant())._id, { email });
    sqs.failDeletes = true;
    sqs.push(bounce(email));
    sqs.push(bounce(`other-${Date.now()}@example.com`));
    expect(await sesEventsStep(deps)).toEqual({ blocked: 1, ignored: 1 });
    expect(deps.lines.filter((l) => l.level === 'error' && l.msg === 'SES event message not deleted')).toHaveLength(2);
    expect(JSON.stringify(deps.lines)).not.toContain(email);
    const first = (await userNow(u))!.emailBlocked;
    // SQS delivers it again.
    sqs.failDeletes = false;
    sqs.push(bounce(email));
    expect(await sesEventsStep(deps)).toEqual({ blocked: 0, ignored: 1 });
    expect((await userNow(u))!.emailBlocked).toEqual(first);
  });

  test('FR-5: the step reads at most 10 batches of 10 per pass', async () => {
    const { sqs, deps } = setup();
    for (let i = 0; i < 150; i += 1) sqs.push({ eventType: 'Delivery' });
    expect(await sesEventsStep(deps)).toEqual({ blocked: 0, ignored: 100 });
    expect(sqs.waiting).toHaveLength(50);
    expect(sqs.received).toHaveLength(10);
    expect(sqs.received[0]).toMatchObject({ QueueUrl: QUEUE, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 });
  });

  test('FR-5: with no queue configured the step does nothing', async () => {
    const { sqs, deps } = setup();
    sqs.push(bounce('x@example.com'));
    expect(await sesEventsStep({ ...deps, sesEventsQueueUrl: undefined })).toEqual({ blocked: 0, ignored: 0 });
    expect(sqs.received).toHaveLength(0);
  });
});

describe('worker: a blocked address', () => {
  async function world(prefs: Partial<UserDoc['notificationPrefs']> = {}) {
    const tenantId = (await t.seed.tenant())._id;
    const priya = await person(t, tenantId, { name: 'Priya Shah' });
    const sam = await person(t, tenantId, { name: 'Sam Lee', timezone: 'UTC', prefs });
    const roadmap = await t.seed.roadmap(tenantId, priya._id, 'Launch');
    await t.seed.member(tenantId, roadmap._id, sam._id, 'contributor');
    const item = await t.seed.project(tenantId, roadmap._id, { title: 'Launch plan', assigneeIds: [sam._id] });
    await scoped(t.db, tenantId).collection('users').updateOne({ _id: sam._id }, { $set: { emailBlocked: { reason: 'bounced', at: new Date(T0) } } });
    return { tenantId, priya, sam, roadmap, item };
  }

  test('FR-5: an instant notification for a blocked user is skipped, not sent, and not retried', async () => {
    const c = clock(T0);
    const w = await world({ assigned: 'instant' });
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    const r = await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() });
    await runPass(d);
    await runPass(d);
    expect(mail.sent).toHaveLength(0);
    const after = await scoped(t.db, w.tenantId).collection('notifications').findOne({ _id: r._id });
    expect(after!.email.state).toBe('skipped');
  });

  test("FR-5: a blocked user's digest rows are skipped and no digest is sent", async () => {
    const c = clock('2026-11-22T09:00:00.000Z');
    const w = await world({ assigned: 'digest' });
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    const r = await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: new Date('2026-11-22T06:00:00.000Z') });
    const counts = await runPass(d);
    expect(counts.digests).toBe(0);
    expect(mail.sent).toHaveLength(0);
    const after = await scoped(t.db, w.tenantId).collection('notifications').findOne({ _id: r._id });
    expect(after!.email.state).toBe('skipped');
  });

  test('FR-5: account emails (invites, password reset) still go to a blocked address', async () => {
    const tenantId = (await t.seed.tenant())._id;
    const u = await t.seed.user(tenantId, { email: `blocked-reset-${Date.now()}@example.com` });
    await scoped(t.db, tenantId).collection('users').updateOne({ _id: u._id }, { $set: { emailBlocked: { reason: 'complained', at: new Date(T0) } } });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: '10.9.8.7', payload: { email: u.email } });
    expect(res.statusCode).toBe(202);
    // The email is sent just after the reply.
    await vi.waitFor(() => expect(t.mail.sent.some((m) => m.to === u.email)).toBe(true), { timeout: 10_000 });
  });
});

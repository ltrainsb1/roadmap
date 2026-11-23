import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { notificationRow } from '../../src/notifications/outbox.ts';
import { runPass } from '../../src/worker/run.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { FOOTER, FlakyMailer, clock, dates, itemUrl, person, row, rowsFor, setPref, workerDeps } from './fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const T0 = '2026-11-22T12:00:00.000Z';

/** A roadmap "Launch" with actor Priya, recipient Sam (in Los Angeles, where it is 4 am at T0) and item "Launch plan". */
async function world(o: { samZone?: string } = {}) {
  const tenantId = (await t.seed.tenant())._id;
  const priya = await person(t, tenantId, { name: 'Priya Shah' });
  const sam = await person(t, tenantId, { name: 'Sam Lee', timezone: o.samZone ?? 'America/Los_Angeles' });
  const roadmap = await t.seed.roadmap(tenantId, priya._id, 'Launch');
  await t.seed.member(tenantId, roadmap._id, sam._id, 'contributor');
  const item = await t.seed.project(tenantId, roadmap._id, { title: 'Launch plan', assigneeIds: [sam._id] });
  return { tenantId, priya, sam, roadmap, item };
}

describe('worker: instant emails', () => {
  test('FR-5.1: an instant notification is emailed once, to the recipient only, with the exact subject, the item link and the settings footer', async () => {
    const c = clock(T0);
    const w = await world();
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    const base = { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() };
    await row(t, w.tenantId, base);

    const first = await runPass(d);
    expect(first).toMatchObject({ sent: 1, failed: 0 });
    expect(mail.sent).toHaveLength(1);
    const [m] = mail.sent;
    expect(m!.to).toBe(w.sam.email);
    expect(m!.subject).toBe('Priya Shah assigned you to Launch plan');
    expect(m!.text).toBe(
      [
        'Priya Shah assigned you to Launch plan.',
        'Launch · 22 Nov 2026',
        '',
        `Open the item: ${itemUrl(w.roadmap._id, w.item._id)}`,
        '',
        FOOTER,
      ].join('\n'),
    );
    expect(m!.html).toContain(`href="${itemUrl(w.roadmap._id, w.item._id)}"`);
    expect(m!.html).toContain('You get this email because of your notification settings. Change them:');
    expect(m!.html).not.toContain(w.priya.email);
    const [sent] = await rowsFor(t, w.sam);
    expect(sent!.email).toMatchObject({ state: 'sent', attempts: 0, sentAt: c.now() });

    // Nothing is sent again on later passes.
    c.set('2026-11-22T12:10:00.000Z');
    expect((await runPass(d)).sent).toBe(0);
    expect(mail.sent).toHaveLength(1);

    // The mention and the dates change carry their facts: the excerpt, and the old and new dates.
    await setPref(t, w.sam, 'dates_changed', 'instant');
    await row(t, w.tenantId, { ...base, type: 'mentioned', detail: { kind: 'mentioned', excerpt: 'Can you check the copy?' } });
    await row(t, w.tenantId, { ...base, type: 'dates_changed', detail: dates });
    await runPass(d);
    expect(mail.sent.map((x) => x.subject)).toEqual([
      'Priya Shah assigned you to Launch plan',
      'Priya Shah mentioned you on Launch plan',
      'Priya Shah changed the dates on Launch plan',
    ]);
    expect(mail.sent[1]!.text.split('\n').slice(0, 3)).toEqual([
      'Priya Shah mentioned you on Launch plan.',
      '“Can you check the copy?”',
      'Launch · 22 Nov 2026',
    ]);
    expect(mail.sent[2]!.text.split('\n').slice(0, 2)).toEqual([
      'Priya Shah changed the dates on Launch plan.',
      'From 3 Mar 2027 → 3 Mar to 28 Apr 2027 · Launch · 22 Nov 2026',
    ]);
    expect(mail.sent.every((x) => x.to === w.sam.email)).toBe(true);
  });

  test('FR-5.2: an "off" preference skips the email, a "digest" preference waits for the digest, and a change of preference before sending is honoured', async () => {
    const c = clock(T0);
    const w = await world();
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    const base = { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() };

    await setPref(t, w.sam, 'assigned', 'off');
    await setPref(t, w.sam, 'mentioned', 'digest');
    const off = await row(t, w.tenantId, base);
    const waiting = await row(t, w.tenantId, { ...base, type: 'mentioned', detail: { kind: 'mentioned', excerpt: 'Hi' } });
    await runPass(d);
    expect(mail.sent).toHaveLength(0);
    const byId = new Map((await rowsFor(t, w.sam)).map((r) => [r._id, r]));
    expect(byId.get(off._id)!.email.state).toBe('skipped');
    expect(byId.get(waiting._id)!.email.state).toBe('pending');

    // Waiting for the digest, then switched to instant: the next pass sends it.
    await setPref(t, w.sam, 'mentioned', 'instant');
    c.set('2026-11-22T12:01:00.000Z');
    await runPass(d);
    expect(mail.sent.map((x) => x.subject)).toEqual(['Priya Shah mentioned you on Launch plan']);

    // Written while instant, turned off before the worker ran: no email.
    const late = await row(t, w.tenantId, { ...base, type: 'mentioned', detail: { kind: 'mentioned', excerpt: 'Again' } });
    await setPref(t, w.sam, 'mentioned', 'off');
    await runPass(d);
    expect(mail.sent).toHaveLength(1);
    expect((await rowsFor(t, w.sam)).find((r) => r._id === late._id)!.email.state).toBe('skipped');
  });

  test('FR-5.1: rows waiting for a digest never hold back an instant email behind them', async () => {
    const c = clock(T0);
    const w = await world();
    await setPref(t, w.sam, 'dates_changed', 'digest');
    // 150 older rows waiting for Sam's digest (it is 4 am for him), more than one batch, then one instant row.
    await scoped(t.db, w.tenantId)
      .collection('notifications')
      .insertMany(
        Array.from({ length: 150 }, () =>
          notificationRow({ roadmapId: w.roadmap._id, userId: w.sam._id, type: 'dates_changed', actorId: w.priya._id, item: w.item, detail: dates, now: c.now() }),
        ),
      );
    await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() });
    const mail = new MemoryMailer();
    expect(await runPass(workerDeps(t, c, mail))).toMatchObject({ sent: 1, digests: 0 });
    expect(mail.sent.map((m) => m.subject)).toEqual(['Priya Shah assigned you to Launch plan']);
    // Leave nothing waiting for the later tests in this file.
    await scoped(t.db, w.tenantId).collection('notifications').deleteMany({ userId: w.sam._id, type: 'dates_changed' });
  });

  test('FR-5.1: a recipient removed from the roadmap before sending gets no email', async () => {
    const c = clock(T0);
    const w = await world();
    const mail = new MemoryMailer();
    await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() });
    await scoped(t.db, w.tenantId).collection('memberships').deleteOne({ roadmapId: w.roadmap._id, userId: w.sam._id });

    await runPass(workerDeps(t, c, mail));
    expect(mail.sent).toHaveLength(0);
    expect((await rowsFor(t, w.sam))[0]!.email.state).toBe('skipped');
  });

  test('FR-5.1: a row whose item was deleted a moment ago is skipped, not emailed', async () => {
    const c = clock(T0);
    const w = await world();
    const mail = new MemoryMailer();
    // As a due-soon reminder written just after the item's delete would leave it: the row outlived the cascade.
    await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() });
    await scoped(t.db, w.tenantId).collection('projects').deleteOne({ _id: w.item._id });

    await runPass(workerDeps(t, c, mail));
    expect(mail.sent).toHaveLength(0);
    expect((await rowsFor(t, w.sam))[0]!.email.state).toBe('skipped');
  });

  test('FR-5.1: two passes running at once send each email once', async () => {
    const c = clock(T0);
    const w = await world();
    const others = [w.sam];
    for (let i = 0; i < 4; i++) {
      const u = await person(t, w.tenantId, { name: `Member ${i}`, timezone: 'America/Los_Angeles' });
      await t.seed.member(w.tenantId, w.roadmap._id, u._id, 'contributor');
      others.push(u);
    }
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    for (let round = 0; round < 20; round++) {
      const s = scoped(t.db, w.tenantId);
      await s.collection('notifications').insertMany(
        Array.from({ length: 50 }, (_, i) =>
          notificationRow({
            roadmapId: w.roadmap._id,
            userId: others[i % others.length]!._id,
            type: 'assigned',
            actorId: w.priya._id,
            item: { _id: w.item._id, title: `Item ${round}-${i}` },
            detail: { kind: 'assigned' },
            now: c.now(),
          }),
        ),
      );
      const [a, b] = await Promise.all([runPass(d), runPass(d)]);
      expect(a.sent + b.sent, `round ${round}`).toBe(50);
      expect(await s.collection('notifications').countDocuments({ 'email.state': 'sent' })).toBe(50 * (round + 1));
    }
    expect(mail.sent).toHaveLength(1000);
    expect(new Set(mail.sent.map((m) => m.subject)).size).toBe(1000);
  }, 60_000);

  test('FR-5.1: a failed send is retried after 1, 5, 15 and 60 minutes and then marked failed; a lease left by a crashed pass is taken over after 5 minutes', async () => {
    const c = clock(T0);
    const w = await world();
    const flaky = new FlakyMailer();
    const d = workerDeps(t, c, flaky);
    const r = await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: c.now() });
    const state = async () => (await rowsFor(t, w.sam)).find((x) => x._id === r._id)!.email;
    const at = (minutes: number, seconds = 0) => new Date(Date.parse(T0) + minutes * 60_000 + seconds * 1000).toISOString();

    expect(await runPass(d)).toMatchObject({ sent: 0, failed: 1 });
    expect(await state()).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: new Date(at(1)), leaseUntil: null });
    // Each wait, one second short and then on time.
    let tried = 1;
    for (const [due, attempts] of [[1, 2], [6, 3], [21, 4], [81, 5]] as const) {
      c.set(at(due, -1));
      await runPass(d);
      expect(flaky.attempts).toBe(tried);
      c.set(at(due));
      await runPass(d);
      tried += 1;
      expect(flaky.attempts).toBe(tried);
      expect((await state()).attempts).toBe(attempts);
    }
    expect(await state()).toMatchObject({ state: 'failed', attempts: 5 });
    c.set(at(500));
    await runPass(d);
    expect(flaky.attempts).toBe(5);
    // The error is logged without the address it was going to.
    const errors = d.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(5);
    expect(JSON.stringify(d.lines)).not.toContain(w.sam.email);

    // A pass that claimed a row and died: its lease runs 5 minutes, then another pass takes the row over.
    flaky.failing = false;
    const claimedAt = Date.parse(at(600));
    const crashed = await row(t, w.tenantId, { roadmapId: w.roadmap._id, userId: w.sam._id, item: w.item, actorId: w.priya._id, now: new Date(claimedAt) });
    await scoped(t.db, w.tenantId)
      .collection('notifications')
      .updateOne({ _id: crashed._id }, { $set: { 'email.state': 'sending', 'email.leaseUntil': new Date(claimedAt + 5 * 60_000) } });
    c.set(at(604, 59));
    await runPass(d);
    expect(flaky.sent).toHaveLength(0);
    c.set(at(605));
    await runPass(d);
    expect(flaky.sent).toHaveLength(1);
    expect((await rowsFor(t, w.sam)).find((x) => x._id === crashed._id)!.email.state).toBe('sent');
  });

  test('FR-5.1: a lease runs 5 minutes from its claim, so a second worker never takes a row claimed late in a long pass', async () => {
    const c = clock(T0);
    const w = await world();
    const base = { roadmapId: w.roadmap._id, userId: w.sam._id, actorId: w.priya._id, now: c.now() };
    await row(t, w.tenantId, { ...base, item: { _id: w.item._id, title: 'First' } });
    await row(t, w.tenantId, { ...base, item: { _id: w.item._id, title: 'Second' } });
    const other = new MemoryMailer();
    const leases: Array<Date | null> = [];
    // The first send takes 6 minutes; during the second, another worker runs a pass.
    const slow = {
      sent: [] as string[],
      async send(m: { subject: string }) {
        const r = (await rowsFor(t, w.sam)).find((x) => m.subject.endsWith(x.projectTitle))!;
        leases.push(r.email.leaseUntil);
        if (this.sent.length === 0) c.set('2026-11-22T12:06:00.000Z');
        else await runPass(workerDeps(t, c, other));
        this.sent.push(m.subject);
      },
    };
    const d = workerDeps(t, c, slow);
    expect((await runPass(d)).sent).toBe(2);
    expect(leases).toEqual([new Date('2026-11-22T12:05:00.000Z'), new Date('2026-11-22T12:11:00.000Z')]);
    expect(other.sent.filter((m) => m.to === w.sam.email)).toHaveLength(0);
    // Sent and retry times are when they happened, too.
    const second = (await rowsFor(t, w.sam)).find((x) => x.projectTitle === 'Second')!;
    expect(second.email.sentAt).toEqual(new Date('2026-11-22T12:06:00.000Z'));
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import type { UserDoc } from '../../src/db/types.ts';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { runPass } from '../../src/worker/run.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { FOOTER, FlakyMailer, clock, dates, itemUrl, person, row, rowsFor, workerDeps } from './fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

/** A person in `timezone` on roadmaps Alpha and Beta, each with one item; Priya makes the changes. */
async function world(timezone: string) {
  const tenantId = (await t.seed.tenant())._id;
  const priya = await person(t, tenantId, { name: 'Priya Shah' });
  const me = await person(t, tenantId, { name: 'Sam Lee', timezone });
  const alpha = await t.seed.roadmap(tenantId, priya._id, 'Alpha');
  const beta = await t.seed.roadmap(tenantId, priya._id, 'Beta');
  for (const r of [alpha, beta]) await t.seed.member(tenantId, r._id, me._id, 'contributor');
  const a = await t.seed.project(tenantId, alpha._id, { title: 'Ship it', assigneeIds: [me._id] });
  const b = await t.seed.project(tenantId, beta._id, { title: 'Plan it', assigneeIds: [me._id] });
  /** A "dates changed" row (a digest by default) for `me`. */
  const change = (on: 'alpha' | 'beta', at: string) =>
    row(t, tenantId, {
      roadmapId: on === 'alpha' ? alpha._id : beta._id,
      userId: me._id,
      item: on === 'alpha' ? a : b,
      type: 'dates_changed',
      actorId: priya._id,
      detail: dates,
      now: new Date(at),
    });
  return { tenantId, priya, me, alpha, beta, a, b, change };
}

const to = (mail: MemoryMailer, u: UserDoc) => mail.sent.filter((m) => m.to === u.email);

describe('worker: digests', () => {
  test('FR-5.2: the digest goes out at 8 am local time, once per local day, grouped by roadmap, and not on a day with nothing in it', async () => {
    // Local 07:59, 08:00, 08:30 on 1 Nov 2026, then 08:00 on 2 and 3 Nov, as UTC instants. 1 Nov is the day New York
    // leaves daylight saving (at 2 am), so 8 am there is 13:00 UTC, not 12:00.
    const cases = [
      { zone: 'UTC', times: ['2026-11-01T07:59:00Z', '2026-11-01T08:00:00Z', '2026-11-01T08:30:00Z', '2026-11-02T08:00:00Z', '2026-11-03T08:00:00Z'] },
      { zone: 'America/New_York', times: ['2026-11-01T12:59:00Z', '2026-11-01T13:00:00Z', '2026-11-01T13:30:00Z', '2026-11-02T13:00:00Z', '2026-11-03T13:00:00Z'] },
      { zone: 'Pacific/Kiritimati', times: ['2026-10-31T17:59:00Z', '2026-10-31T18:00:00Z', '2026-10-31T18:30:00Z', '2026-11-01T18:00:00Z', '2026-11-02T18:00:00Z'] },
    ];
    for (const { zone, times } of cases) {
      const [before, eight, half, nextDay, dayAfter] = times as [string, string, string, string, string];
      const w = await world(zone);
      const c = clock(before);
      const mail = new MemoryMailer();
      const d = workerDeps(t, c, mail);
      const early = new Date(Date.parse(before) - 2 * 3600_000).toISOString();
      const first = await w.change('alpha', early);
      const second = await w.change('beta', early);
      const third = await w.change('alpha', early);

      await runPass(d);
      expect(to(mail, w.me), `${zone} 07:59`).toHaveLength(0);

      c.set(eight);
      const counts = await runPass(d);
      expect(counts.digests, zone).toBe(1);
      expect(to(mail, w.me), `${zone} 08:00`).toHaveLength(1);
      const [m] = to(mail, w.me);
      expect(m!.subject).toBe('Your roadmap updates for 1 Nov 2026');
      const line = (item: { _id: string; roadmapId: string }) =>
        `Priya Shah changed the dates on ${item._id === w.a._id ? 'Ship it' : 'Plan it'}. ${itemUrl(item.roadmapId, item._id)}`;
      expect(m!.text).toBe(
        [
          "Here's what happened since your last digest.",
          '',
          'Alpha',
          line(w.a),
          line(w.a),
          '',
          'Beta',
          line(w.b),
          '',
          FOOTER,
        ].join('\n'),
      );
      expect(m!.html).toContain('<h2>Alpha</h2>');
      expect(m!.html.indexOf('<h2>Alpha</h2>')).toBeLessThan(m!.html.indexOf('<h2>Beta</h2>'));
      const rows = new Map((await rowsFor(t, w.me)).map((r) => [r._id, r]));
      for (const r of [first, second, third]) expect(rows.get(r._id)!.email.state).toBe('sent');
      const stored = await scoped(t.db, w.tenantId).collection('users').findOne({ _id: w.me._id });
      expect(stored!.digestSentOn).toBe('2026-11-01');

      // A change after the digest waits for tomorrow's.
      await w.change('beta', eight);
      c.set(half);
      await runPass(d);
      expect(to(mail, w.me), `${zone} 08:30`).toHaveLength(1);

      c.set(nextDay);
      await runPass(d);
      expect(to(mail, w.me), `${zone} next day`).toHaveLength(2);
      expect(to(mail, w.me)[1]!.subject).toBe('Your roadmap updates for 2 Nov 2026');
      expect(to(mail, w.me)[1]!.text).not.toContain('Alpha');

      // Nothing waiting: no digest.
      c.set(dayAfter);
      await runPass(d);
      expect(to(mail, w.me), `${zone} day after`).toHaveLength(2);
    }
  });

  test('FR-5.2: a worker down over 8 am sends the digest on its next pass that day', async () => {
    const w = await world('UTC');
    await w.change('alpha', '2026-11-05T06:00:00Z');
    const c = clock('2026-11-05T15:42:00Z');
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(1);
    expect(to(mail, w.me)[0]!.subject).toBe('Your roadmap updates for 5 Nov 2026');
    c.set('2026-11-05T23:59:00Z');
    await w.change('alpha', '2026-11-05T23:00:00Z');
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(1);
  });

  test('FR-5.2: a digest whose rows all belong to a roadmap the person left is not sent', async () => {
    const w = await world('UTC');
    await w.change('beta', '2026-11-06T06:00:00Z');
    await w.change('beta', '2026-11-06T06:30:00Z');
    await scoped(t.db, w.tenantId).collection('memberships').deleteOne({ roadmapId: w.beta._id, userId: w.me._id });
    const c = clock('2026-11-06T09:00:00Z');
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(0);
    expect((await rowsFor(t, w.me)).map((r) => r.email.state)).toEqual(['skipped', 'skipped']);

    // Nothing was sent, so the day is given back; a change made after 8 am waits for tomorrow's digest.
    expect((await scoped(t.db, w.tenantId).collection('users').findOne({ _id: w.me._id }))!.digestSentOn).toBeUndefined();
    await w.change('alpha', '2026-11-06T09:30:00Z');
    c.set('2026-11-06T10:00:00Z');
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(0);
    c.set('2026-11-07T08:00:00Z');
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(1);
    expect(to(mail, w.me)[0]!.text).not.toContain('Beta');
  });

  test('FR-5.2: the digest leaves out a row whose item was deleted a moment ago, and skips it', async () => {
    const w = await world('UTC');
    const kept = await w.change('alpha', '2026-11-10T06:00:00Z');
    const gone = await w.change('beta', '2026-11-10T06:30:00Z');
    // As a due-soon reminder written just after the item's delete would leave it: the row outlived the cascade.
    await scoped(t.db, w.tenantId).collection('projects').deleteOne({ _id: w.b._id });
    const mail = new MemoryMailer();
    await runPass(workerDeps(t, clock('2026-11-10T08:00:00Z'), mail));
    const sent = to(mail, w.me);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Ship it');
    expect(sent[0]!.text).not.toContain('Plan it');
    expect(sent[0]!.text).not.toContain('Beta');
    const states = new Map((await rowsFor(t, w.me)).map((r) => [r._id, r.email.state]));
    expect([states.get(kept._id), states.get(gone._id)]).toEqual(['sent', 'skipped']);
  });

  test('FR-5.2: on a day with nothing waiting at 8 am, a change made later waits for the next morning', async () => {
    const w = await world('UTC');
    const c = clock('2026-11-08T08:00:00Z');
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    await runPass(d);
    await w.change('alpha', '2026-11-08T10:00:00Z');
    c.set('2026-11-08T10:01:00Z');
    await runPass(d);
    c.set('2026-11-08T23:59:00Z');
    await runPass(d);
    expect(to(mail, w.me)).toHaveLength(0);
    c.set('2026-11-09T08:00:00Z');
    await runPass(d);
    expect(to(mail, w.me).map((m) => m.subject)).toEqual(['Your roadmap updates for 9 Nov 2026']);
  });

  test('FR-5.2: a failed digest is retried with its rows kept pending, and two passes at once send it once', async () => {
    const w = await world('UTC');
    const r = await w.change('alpha', '2026-11-07T06:00:00Z');
    const c = clock('2026-11-07T09:00:00Z');
    const flaky = new FlakyMailer();
    const d = workerDeps(t, c, flaky);
    expect(await runPass(d)).toMatchObject({ digests: 0, failed: 1 });
    const stored = async () => scoped(t.db, w.tenantId).collection('users').findOne({ _id: w.me._id });
    expect((await stored())!.digestSentOn).toBeUndefined();
    expect((await rowsFor(t, w.me)).find((x) => x._id === r._id)!.email).toMatchObject({
      state: 'pending',
      attempts: 1,
      nextAttemptAt: new Date('2026-11-07T09:01:00Z'),
    });
    // Not before the retry is due.
    flaky.failing = false;
    c.set('2026-11-07T09:00:59Z');
    await runPass(d);
    expect(flaky.sent).toHaveLength(0);
    c.set('2026-11-07T09:01:00Z');
    const [a, b] = await Promise.all([runPass(d), runPass(d)]);
    expect(a.digests + b.digests).toBe(1);
    expect(flaky.sent).toHaveLength(1);
    expect((await stored())!.digestSentOn).toBe('2026-11-07');
    expect(JSON.stringify(d.lines)).not.toContain(w.me.email);
  });
});

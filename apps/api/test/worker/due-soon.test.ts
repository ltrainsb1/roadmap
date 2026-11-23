import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { scoped } from '../../src/db/scoped.ts';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { writeDueSoon } from '../../src/worker/due-soon.ts';
import { runPass } from '../../src/worker/run.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { clock, person, rowsFor, workerDeps } from './fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

describe('worker: due soon', () => {
  test('FR-5.1: due soon writes one reminder per assignee for an end date and for each milestone 3 days ahead, none for done, cancelled or archived items, and a new one when the date moves', async () => {
    // 22 Nov 2026 in UTC: the window is 22 to 25 Nov.
    const c = clock('2026-11-22T12:00:00.000Z');
    const tenantId = (await t.seed.tenant())._id;
    const s = scoped(t.db, tenantId);
    const owner = await person(t, tenantId, { name: 'Olive' });
    const sam = await person(t, tenantId, { name: 'Sam' });
    const ann = await person(t, tenantId, { name: 'Ann' });
    const roadmap = await t.seed.roadmap(tenantId, owner._id, 'Launch');
    await t.seed.member(tenantId, roadmap._id, sam._id, 'contributor');
    await t.seed.member(tenantId, roadmap._id, ann._id, 'contributor');

    const item = await t.seed.project(tenantId, roadmap._id, { title: 'Launch plan', endDate: '2026-11-25', assigneeIds: [sam._id, ann._id] });
    await s.collection('projects').updateOne(
      { _id: item._id },
      {
        $set: {
          milestones: [
            { id: 'm1', name: 'Beta', date: '2026-11-25' },
            { id: 'm2', name: 'GA', date: '2026-11-26' },
            { id: 'm3', name: 'Alpha', date: '2026-11-21' },
          ],
        },
      },
    );
    for (const o of [{ status: 'done' as const }, { status: 'cancelled' as const }, { archived: true }]) {
      await t.seed.project(tenantId, roadmap._id, { title: 'Quiet', endDate: '2026-11-24', assigneeIds: [sam._id], ...o });
    }
    await t.seed.project(tenantId, roadmap._id, { title: 'Nobody', endDate: '2026-11-24' });

    const d = workerDeps(t, c, new MemoryMailer());
    expect(await writeDueSoon(d)).toEqual({ reminders: 4 });
    for (const u of [sam, ann]) {
      const rows = await rowsFor(t, u);
      expect(rows.map((r) => [r.type, r.actorId, r.projectId, r.dedupeKey, r.detail])).toEqual(
        expect.arrayContaining([
          ['due_soon', null, item._id, `due:${item._id}:end:2026-11-25`, { kind: 'due_end', date: '2026-11-25' }],
          ['due_soon', null, item._id, `due:${item._id}:m1:2026-11-25`, { kind: 'due_milestone', name: 'Beta', date: '2026-11-25' }],
        ]),
      );
      expect(rows).toHaveLength(2);
    }
    expect(await s.collection('notifications').countDocuments({ userId: owner._id })).toBe(0);

    // A later pass the same day writes nothing new.
    c.set('2026-11-22T12:00:30.000Z');
    expect(await writeDueSoon(d)).toEqual({ reminders: 0 });

    // The end date moves: a new reminder for the new date.
    await s.collection('projects').updateOne({ _id: item._id }, { $set: { endDate: '2026-11-24' } });
    expect(await writeDueSoon(d)).toEqual({ reminders: 2 });
    expect((await rowsFor(t, sam)).map((r) => r.dedupeKey)).toContain(`due:${item._id}:end:2026-11-24`);
    expect(await s.collection('notifications').countDocuments({ type: 'due_soon' })).toBe(6);
    expect(d.lines.filter((l) => l.level === 'error')).toEqual([]);

    // Two passes at once still write each reminder once.
    await s.collection('projects').updateOne({ _id: item._id }, { $set: { endDate: '2026-11-23' } });
    const [a, b] = await Promise.all([runPass(d), runPass(d)]);
    expect(a.reminders + b.reminders).toBe(2);
    expect(await s.collection('notifications').countDocuments({ type: 'due_soon' })).toBe(8);
    expect(d.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  test("FR-5.1: due soon counts days in each person's time zone", async () => {
    // 12:00 UTC on 22 Nov: 02:00 on 23 Nov in Kiritimati (+14), 01:00 on 22 Nov in Pago Pago (−11).
    const c = clock('2026-11-22T12:00:00.000Z');
    const tenantId = (await t.seed.tenant())._id;
    const kiri = await person(t, tenantId, { name: 'Kiri', timezone: 'Pacific/Kiritimati' });
    const pago = await person(t, tenantId, { name: 'Pago', timezone: 'Pacific/Pago_Pago' });
    const roadmap = await t.seed.roadmap(tenantId, kiri._id, 'Islands');
    await t.seed.member(tenantId, roadmap._id, pago._id, 'contributor');
    await t.seed.project(tenantId, roadmap._id, { title: 'Ferry', endDate: '2026-11-26', assigneeIds: [kiri._id, pago._id] });

    const d = workerDeps(t, c, new MemoryMailer());
    expect(await writeDueSoon(d)).toEqual({ reminders: 1 });
    expect(await rowsFor(t, kiri)).toHaveLength(1);
    expect(await rowsFor(t, pago)).toHaveLength(0);

    // A day later it is 23 Nov in Pago Pago too, and 26 Nov is 3 days away there.
    // (The earlier test's items share this database, so only these two people's rows are counted.)
    c.set('2026-11-23T12:00:00.000Z');
    await writeDueSoon(d);
    expect(await rowsFor(t, pago)).toHaveLength(1);
    expect(await rowsFor(t, kiri)).toHaveLength(1);
  });

  test('FR-5.1: due soon reminds no assignee who is not a member of the roadmap', async () => {
    const c = clock('2026-12-01T12:00:00.000Z');
    const tenantId = (await t.seed.tenant())._id;
    const owner = await person(t, tenantId, { name: 'Olive' });
    const gone = await person(t, tenantId, { name: 'Nora' });
    const roadmap = await t.seed.roadmap(tenantId, owner._id, 'Launch');
    await t.seed.project(tenantId, roadmap._id, { title: 'Left behind', endDate: '2026-12-02', assigneeIds: [gone._id, owner._id] });
    await writeDueSoon(workerDeps(t, c, new MemoryMailer()));
    expect(await rowsFor(t, gone)).toHaveLength(0);
    expect(await rowsFor(t, owner)).toHaveLength(1);
  });

  test('FR-5.1: due-soon reminders set to "instantly" are emailed with their exact subjects', async () => {
    const c = clock('2026-12-10T12:00:00.000Z');
    const tenantId = (await t.seed.tenant())._id;
    const sam = await person(t, tenantId, { name: 'Sam', prefs: { due_soon: 'instant' } });
    const roadmap = await t.seed.roadmap(tenantId, sam._id, 'Harbour');
    const item = await t.seed.project(tenantId, roadmap._id, { title: 'Ferry plan', endDate: '2026-12-12', assigneeIds: [sam._id] });
    await scoped(t.db, tenantId)
      .collection('projects')
      .updateOne({ _id: item._id }, { $set: { milestones: [{ id: 'b', name: 'Beta', date: '2026-12-11' }] } });
    const mail = new MemoryMailer();
    const d = workerDeps(t, c, mail);
    await runPass(d); // writes the reminders (after this pass's instant step)
    c.set('2026-12-10T12:00:30.000Z');
    await runPass(d); // sends them
    const mine = mail.sent.filter((m) => m.to === sam.email);
    expect(mine.map((m) => m.subject).sort()).toEqual(['Ferry plan is due 12 Dec 2026', 'The milestone Beta on Ferry plan is on 11 Dec 2026']);
    const end = mine.find((m) => m.subject.startsWith('Ferry'))!;
    expect(end.text.split('\n').slice(0, 2)).toEqual(['Ferry plan is due 12 Dec 2026.', 'Harbour · 10 Dec 2026']);
  });
});

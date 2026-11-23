import { noteExcerpt } from '@roadmap/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { runPass } from '../../src/worker/run.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { clock, dates, person, row, workerDeps } from './fixtures.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

/** Priya and Sam (UTC) on one roadmap; Sam gets one instant row (assigned) and one digest row (dates changed). */
async function world(o: { roadmapName?: string; title?: string; actorName?: string } = {}) {
  const tenantId = (await t.seed.tenant())._id;
  const priya = await person(t, tenantId, { name: o.actorName ?? 'Priya Shah' });
  const sam = await person(t, tenantId, { name: 'Sam Lee' });
  const roadmap = await t.seed.roadmap(tenantId, priya._id, o.roadmapName ?? 'Launch');
  await t.seed.member(tenantId, roadmap._id, sam._id, 'contributor');
  const item = await t.seed.project(tenantId, roadmap._id, { title: o.title ?? 'Launch plan', assigneeIds: [sam._id] });
  const base = { roadmapId: roadmap._id, userId: sam._id, item, actorId: priya._id };
  return { tenantId, priya, sam, roadmap, item, base };
}

describe('worker: one pass', () => {
  test('FR-5.1: email HTML escapes titles, names and excerpts; the subject is one line', async () => {
    const c = clock('2026-11-10T09:00:00Z');
    const title = '<script>alert("x")</script>\nSecond line\r\nThird';
    const w = await world({ title, actorName: 'Bob "The Builder" O\'Neil', roadmapName: 'R&D <team>' });
    const note = `<img src=x onerror="alert(1)"> ${'long words '.repeat(500)}`.slice(0, 5000);
    expect(note).toHaveLength(5000);
    const mention = { kind: 'mentioned', excerpt: noteExcerpt(note) } as const;
    await row(t, w.tenantId, { ...w.base, item: w.item, type: 'mentioned', detail: mention, now: c.now() });
    // The same row in a digest: Olive gets her mentions in one.
    const olive = await person(t, w.tenantId, { name: 'Olive', prefs: { mentioned: 'digest' } });
    await t.seed.member(w.tenantId, w.roadmap._id, olive._id, 'contributor');
    await row(t, w.tenantId, { ...w.base, userId: olive._id, type: 'mentioned', detail: mention, now: c.now() });

    const mail = new MemoryMailer();
    await runPass(workerDeps(t, c, mail));
    expect(mail.sent).toHaveLength(2);
    for (const m of mail.sent) {
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.html).not.toMatch(/<script|<img|onerror="/i);
      expect(m.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      expect(m.html).toContain('Bob &quot;The Builder&quot; O&#39;Neil');
      expect(m.html).not.toContain('long words '.repeat(30));
    }
    const instant = mail.sent.find((m) => m.to === w.sam.email)!;
    expect(instant.subject).toBe('Bob "The Builder" O\'Neil mentioned you on <script>alert("x")</script> Second line Third');
    expect(instant.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(instant.html).toContain('R&amp;D &lt;team&gt;');
    const digest = mail.sent.find((m) => m.to === olive.email)!;
    expect(digest.html).toContain('<h2>R&amp;D &lt;team&gt;</h2>');
  });

  test("FR-5.1: one failing step doesn't stop the others in the same pass", async () => {
    const c = clock('2026-11-11T09:00:00Z');
    const w = await world();
    await row(t, w.tenantId, { ...w.base, now: c.now() });
    await row(t, w.tenantId, { ...w.base, type: 'dates_changed', detail: dates, now: c.now() });
    // The due-soon step is the one that reads items; make every read of them fail.
    const broken = new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'collection') {
          return (name: string) => {
            if (name === 'projects') throw new Error('projects are unreachable');
            return target.collection(name);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const mail = new MemoryMailer();
    const d = { ...workerDeps(t, c, mail), db: broken };

    const counts = await runPass(d);
    expect(counts).toEqual({ sent: 1, reminders: 0, digests: 1, failed: 0 });
    expect(mail.sent.map((m) => m.subject)).toEqual(['Priya Shah assigned you to Launch plan', 'Your roadmap updates for 11 Nov 2026']);
    expect(d.lines.filter((l) => l.level === 'error')).toEqual([
      { level: 'error', o: { step: 'due_soon', err: 'Error: projects are unreachable' }, msg: 'worker step failed' },
    ]);
  });

  test("Tenant isolation: a pass across two tenants sends each person only their own tenant's notifications, and the digest links point at their own roadmaps", async () => {
    const c = clock('2026-11-12T09:00:00Z');
    const one = await world({ roadmapName: 'One' });
    const two = await world({ roadmapName: 'Two' });
    for (const w of [one, two]) {
      await row(t, w.tenantId, { ...w.base, now: c.now() });
      await row(t, w.tenantId, { ...w.base, type: 'dates_changed', detail: dates, now: c.now() });
    }
    const mail = new MemoryMailer();
    expect(await runPass(workerDeps(t, c, mail))).toMatchObject({ sent: 2, digests: 2 });
    for (const [mine, theirs] of [[one, two], [two, one]] as const) {
      const got = mail.sent.filter((m) => m.to === mine.sam.email);
      expect(got).toHaveLength(2);
      for (const m of got) {
        expect(m.text).toContain(`/r/${mine.roadmap._id}/projects/${mine.item._id}`);
        expect(m.text + m.html).not.toContain(theirs.roadmap._id);
        expect(m.text + m.html).not.toContain(theirs.sam.email);
      }
      const digest = got.find((m) => m.subject.startsWith('Your roadmap updates'))!;
      expect(digest.text).toContain(mine.roadmap.name);
      expect(digest.text).not.toContain(theirs.roadmap.name);
    }
    expect(mail.sent).toHaveLength(4);
  });
});

import { noteExcerpt } from '@roadmap/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryMailer } from '../../src/mail/mailer.ts';
import { passAndBeat, runPass } from '../../src/worker/run.ts';
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
    const early = new Date('2026-11-10T07:00:00Z');
    const title = '<script>alert("x")</script>\nSecond line\r\nThird';
    const w = await world({ title, actorName: 'Bob "The Builder" O\'Neil', roadmapName: 'R&D <team>' });
    const note = `<img src=x onerror="alert(1)"> ${'long words '.repeat(500)}`.slice(0, 5000);
    expect(note).toHaveLength(5000);
    // Stored raw, as if a row held more than an excerpt should: the worker cuts it again.
    const mention = { kind: 'mentioned', excerpt: note } as const;
    await row(t, w.tenantId, { ...w.base, item: w.item, type: 'mentioned', detail: mention, now: early });
    // The same row in a digest: Olive gets her mentions in one.
    const olive = await person(t, w.tenantId, { name: 'Olive', prefs: { mentioned: 'digest' } });
    await t.seed.member(w.tenantId, w.roadmap._id, olive._id, 'contributor');
    await row(t, w.tenantId, { ...w.base, userId: olive._id, type: 'mentioned', detail: mention, now: early });

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
    const quoted = instant.text.split('\n')[1]!;
    expect(quoted).toBe(`“${noteExcerpt(note)}”`);
    expect(quoted.length).toBeLessThanOrEqual(202);
    const digest = mail.sent.find((m) => m.to === olive.email)!;
    expect(digest.html).toContain('<h2>R&amp;D &lt;team&gt;</h2>');
  });

  test("FR-5.1: one failing step doesn't stop the others in the same pass", async () => {
    const c = clock('2026-11-11T09:00:00Z');
    const early = new Date('2026-11-11T07:00:00Z');
    const w = await world();
    await row(t, w.tenantId, { ...w.base, now: early });
    await row(t, w.tenantId, { ...w.base, type: 'dates_changed', detail: dates, now: early });
    // The due-soon step is the one that scans items across tenants (a `distinct`); make that scan fail. The other
    // steps read items too, by id, and those reads still work.
    const broken = new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'collection') {
          return (name: string) => {
            const col = target.collection(name);
            if (name !== 'projects') return col;
            return new Proxy(col, {
              get(c, p) {
                if (p === 'distinct') return () => Promise.reject(new Error('projects are unreachable'));
                const v: unknown = Reflect.get(c, p, c);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
              },
            });
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
    const early = new Date('2026-11-12T07:00:00Z');
    const one = await world({ roadmapName: 'One' });
    const two = await world({ roadmapName: 'Two' });
    for (const w of [one, two]) {
      await row(t, w.tenantId, { ...w.base, now: early });
      await row(t, w.tenantId, { ...w.base, type: 'dates_changed', detail: dates, now: early });
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

  test('FR-5.1: the heartbeat is written after a pass, but not after one in which every step failed', async () => {
    const c = clock('2026-11-13T09:00:00Z');
    let beats = 0;
    const beat = () => {
      beats += 1;
      return Promise.resolve();
    };
    const d = workerDeps(t, c);
    await passAndBeat(d, beat);
    expect(beats).toBe(1);
    expect(d.lines.at(-1)).toMatchObject({ level: 'info', msg: 'pass done', o: { sent: 0, reminders: 0, digests: 0, failed: 0 } });

    // MongoDB unreachable: all three steps throw, and the health check must see a stale heartbeat.
    const down = new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'collection') {
          return () => {
            throw new Error('connection refused');
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const broken = { ...workerDeps(t, c), db: down };
    await passAndBeat(broken, beat);
    expect(beats).toBe(1);
    expect(broken.lines.filter((l) => l.msg === 'worker step failed').map((l) => (l.o as { step: string }).step)).toEqual(['instant', 'due_soon', 'digest']);
    expect(broken.lines.at(-1)).toMatchObject({ level: 'error', msg: 'every step failed; no heartbeat' });

    // A heartbeat that can't be written is logged, and the pass still counts.
    const failing = workerDeps(t, c);
    await passAndBeat(failing, () => Promise.reject(new Error('read-only file system')));
    expect(failing.lines.at(-1)).toMatchObject({ level: 'error', msg: 'heartbeat not written' });
  });
});

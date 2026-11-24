import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { calendarWorld, parseFeed } from './world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const HOST = 'localhost:5173';
const urlFor = (roadmapId: string, projectId: string) => `/api/roadmaps/${roadmapId}/projects/${projectId}/calendar.ics`;

describe("one item's calendar file", () => {
  test("FR-4.5: an item's file holds its event and its milestones, with the same UIDs the feed uses", async () => {
    const w = await calendarWorld(t);
    const a = await w.item(w.launch._id, {
      title: 'Beta, phase 1',
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      milestones: [{ name: 'Freeze', date: '2026-03-05' }],
    });
    await w.item(w.launch._id, { title: 'Other', endDate: '2026-04-01' });
    const res = await w.call('pat', 'GET', urlFor(w.launch._id, a._id));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const file = parseFeed(res.body);
    expect(file.name).toBe('Roadmap dates');
    expect(file.events).toEqual([
      { uid: `item-${a._id}@${HOST}`, summary: 'Beta, phase 1', sequence: 1, start: '2026-03-01', end: '2026-03-11' },
      { uid: `milestone-${a.milestones[0]!.id}@${HOST}`, summary: 'Freeze · Beta, phase 1', sequence: 1, start: '2026-03-05', end: '2026-03-06' },
    ]);
    // The feed shows the same events with the same UIDs.
    const feed = parseFeed((await w.fetchFeed(await w.create())).body);
    const uids = new Set(feed.events.map((e) => e.uid));
    for (const e of file.events) expect(uids.has(e.uid)).toBe(true);
  });

  test('FR-4.5: the file name is the item\'s title, cleaned, a slash becoming "-", and works with a title in another script', async () => {
    const w = await calendarWorld(t);
    const plain = await w.item(w.launch._id, { title: 'Beta/launch "plan"', endDate: '2026-03-10' });
    const h1 = (await w.call('pat', 'GET', urlFor(w.launch._id, plain._id))).headers['content-disposition'] as string;
    expect(h1).toBe(`attachment; filename="Beta-launch plan.ics"; filename*=UTF-8''Beta-launch%20%22plan%22.ics`);
    const slashed = await w.item(w.launch._id, { title: 'iOS/Android launch', endDate: '2026-03-10' });
    const h3 = (await w.call('pat', 'GET', urlFor(w.launch._id, slashed._id))).headers['content-disposition'] as string;
    expect(decodeURIComponent(h3.split("filename*=UTF-8''")[1]!)).toBe('iOS-Android launch.ics');
    const title = 'Запуск «Бета»';
    const other = await w.item(w.launch._id, { title, endDate: '2026-03-10' });
    const h2 = (await w.call('pat', 'GET', urlFor(w.launch._id, other._id))).headers['content-disposition'] as string;
    expect(h2).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(h2.split("filename*=UTF-8''")[1]!)).toBe(`${title}.ics`);
  });

  test('FR-4.5: an item with no dates is 422, and an archived or unknown item is 404', async () => {
    const w = await calendarWorld(t);
    const none = await w.item(w.launch._id, { title: 'Undated' });
    const res = await w.call('pat', 'GET', urlFor(w.launch._id, none._id));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'no_dates' });
    const onlyMilestone = await w.item(w.launch._id, { title: 'Ms', milestones: [{ name: 'M', date: '2026-05-01' }] });
    expect((await w.call('pat', 'GET', urlFor(w.launch._id, onlyMilestone._id))).statusCode).toBe(200);
    const archived = await w.item(w.launch._id, { title: 'Old', endDate: '2026-02-03', archived: true });
    expect((await w.call('pat', 'GET', urlFor(w.launch._id, archived._id))).statusCode).toBe(404);
    expect((await w.call('pat', 'GET', urlFor(w.launch._id, 'nope'))).statusCode).toBe(404);
  });

  test("Tenant isolation: another roadmap's member and another tenant get 404", async () => {
    const w = await calendarWorld(t);
    const secretItem = await w.item(w.secret._id, { title: 'Hidden', endDate: '2026-03-10' });
    // Pat is not a member of Secret.
    expect((await w.call('pat', 'GET', urlFor(w.secret._id, secretItem._id))).statusCode).toBe(404);
    // A member of Launch asking for a Secret item through Launch's id.
    expect((await w.call('pat', 'GET', urlFor(w.launch._id, secretItem._id))).statusCode).toBe(404);
    const other = await calendarWorld(t);
    const mine = await w.item(w.launch._id, { title: 'Mine', endDate: '2026-03-10' });
    expect((await other.call('pat', 'GET', urlFor(w.launch._id, mine._id))).statusCode).toBe(404);
  });
});

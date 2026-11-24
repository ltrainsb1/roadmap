import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { CALENDAR_LIMITS, DEFAULT_FEED_CHOICES, type FeedState } from '@roadmap/shared';
import { eventsFor } from '../../src/calendar/ics.ts';
import { scoped } from '../../src/db/scoped.ts';
import type { ProjectDoc } from '../../src/db/types.ts';
import { redactUrl, serializeRequest } from '../../src/logging.ts';
import { makeTestApp, signInAs, type TestApp } from '../helpers.ts';
import { calendarWorld, parseFeed, pathOf, tokenOf } from './world.ts';

let clock = new Date();
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ now: () => clock });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const HOST = 'localhost:5173';
const itemUid = (id: string) => `item-${id}@${HOST}`;
const milestoneUid = (id: string) => `milestone-${id}@${HOST}`;
const uidsOf = (body: string) => parseFeed(body).events.map((e) => e.uid).sort();

async function setChoices(w: Awaited<ReturnType<typeof calendarWorld>>, choices: Record<string, unknown>) {
  const res = await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', { ...DEFAULT_FEED_CHOICES, ...choices });
  expect(res.statusCode).toBe(200);
}

describe('the calendar feed', () => {
  test('FR-4.1: the feed answers text/calendar with private caching, an ETag and noindex', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const a = await w.item(w.launch._id, { title: 'Beta, phase 1', startDate: '2026-03-01', endDate: '2026-03-10' });
    const res = await w.fetchFeed(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.body).toContain('\r\n');
    const feed = parseFeed(res.body);
    expect(feed.name).toBe('Roadmap dates');
    expect(feed.events).toEqual([
      { uid: itemUid(a._id), summary: 'Beta, phase 1', sequence: 1, start: '2026-03-01', end: '2026-03-11' },
    ]);
  });

  test('FR-4.4: "new link" makes the old URL answer 404 at once and the new one work; "turn off" makes it 404', async () => {
    const w = await calendarWorld(t);
    const first = await w.create();
    expect((await w.fetchFeed(first)).statusCode).toBe(200);
    const second = (await w.call('pat', 'POST', '/api/me/calendar-feed/new-link')).json<{ url: string }>().url;
    const old = await w.fetchFeed(first);
    expect(old.statusCode).toBe(404);
    expect(old.body).toBe('');
    expect((await w.fetchFeed(second)).statusCode).toBe(200);
    expect((await w.call('pat', 'DELETE', '/api/me/calendar-feed')).statusCode).toBe(204);
    const off = await w.fetchFeed(second);
    expect(off.statusCode).toBe(404);
    expect(off.body).toBe('');
  });

  test('FR-4.4: a token with one character changed, a malformed token and another tenant\'s token are all the same 404 with an empty body', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const token = tokenOf(url);
    const changed = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    // A real secret from another tenant that is not a feed token: a signed-in person's session token.
    const other = await calendarWorld(t);
    const sessionToken = other.sess.pat.cookie.split('=')[1]!;
    const replaced = await other.create();
    await other.call('pat', 'POST', '/api/me/calendar-feed/new-link');
    const paths = [
      `/api/calendar/${changed}.ics`,
      '/api/calendar/short.ics',
      `/api/calendar/${'x'.repeat(90)}.ics`,
      `/api/calendar/${token}%00.ics`,
      `/api/calendar/${sessionToken}.ics`,
      pathOf(replaced),
    ];
    for (const path of paths) {
      const res = await t.app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(404);
      expect(res.body, path).toBe('');
      expect(res.headers['content-type'], path).toBeUndefined();
    }
    expect((await w.fetchFeed(url)).statusCode).toBe(200);
  });

  test('FR-4.2: the feed shows only the chosen roadmaps, only item dates or only milestones as chosen, and only the person\'s items when asked', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const mine = await w.item(w.launch._id, {
      title: 'Mine',
      startDate: '2026-04-01',
      endDate: '2026-04-05',
      assigneeIds: [w.pat._id],
      milestones: [{ name: 'Kickoff', date: '2026-04-01' }],
    });
    const theirs = await w.item(w.launch._id, {
      title: 'Theirs',
      endDate: '2026-04-09',
      assigneeIds: [w.sam._id],
      milestones: [{ name: 'Review', date: '2026-04-08' }],
    });
    const growth = await w.item(w.growth._id, { title: 'Growth item', startDate: '2026-05-01' });
    await w.item(w.secret._id, { title: 'Not a member', startDate: '2026-05-02' });
    await w.item(w.launch._id, { title: 'No dates at all' });

    const all = await w.fetchFeed(url);
    expect(uidsOf(all.body)).toEqual(
      [itemUid(mine._id), milestoneUid(mine.milestones[0]!.id), itemUid(theirs._id), milestoneUid(theirs.milestones[0]!.id), itemUid(growth._id)].sort(),
    );
    const titles = parseFeed(all.body).events.map((e) => e.summary);
    expect(titles).toContain('Kickoff · Mine');
    expect(titles).not.toContain('Not a member');

    await setChoices(w, { roadmaps: [w.growth._id] });
    expect(uidsOf((await w.fetchFeed(url)).body)).toEqual([itemUid(growth._id)]);

    await setChoices(w, { itemDates: false });
    expect(uidsOf((await w.fetchFeed(url)).body)).toEqual(
      [milestoneUid(mine.milestones[0]!.id), milestoneUid(theirs.milestones[0]!.id)].sort(),
    );

    await setChoices(w, { milestones: false });
    expect(uidsOf((await w.fetchFeed(url)).body)).toEqual([itemUid(mine._id), itemUid(theirs._id), itemUid(growth._id)].sort());

    await setChoices(w, { onlyMine: true });
    expect(uidsOf((await w.fetchFeed(url)).body)).toEqual([itemUid(mine._id), milestoneUid(mine.milestones[0]!.id)].sort());
  });

  test('FR-4.2: a roadmap the person was removed from, a deleted roadmap, and archived, cancelled or deleted items never show; done items do', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const done = await w.item(w.launch._id, { title: 'Done', status: 'done', endDate: '2026-02-01' });
    await w.item(w.launch._id, { title: 'Cancelled', status: 'cancelled', endDate: '2026-02-02' });
    await w.item(w.launch._id, { title: 'Archived', archived: true, endDate: '2026-02-03' });
    const parent = await w.item(w.launch._id, { title: 'Parent', endDate: '2026-02-04' });
    await w.item(w.launch._id, { title: 'Child', parentId: parent._id, endDate: '2026-02-05' });
    const gone = await w.item(w.launch._id, { title: 'Deleted', endDate: '2026-02-06' });
    await w.item(w.growth._id, { title: 'Growth', endDate: '2026-02-07' });
    const third = await t.seed.roadmap(w.tenantId, w.sam._id, 'Third');
    await t.seed.member(w.tenantId, third._id, w.pat._id, 'contributor');
    await w.item(third._id, { title: 'Third', endDate: '2026-02-08' });

    const before = parseFeed((await w.fetchFeed(url)).body).events.map((e) => e.summary).sort();
    expect(before).toEqual(['Child', 'Deleted', 'Done', 'Growth', 'Parent', 'Third']);

    const projectUrl = (id: string) => `/api/roadmaps/${w.launch._id}/projects/${id}`;
    expect((await w.call('pat', 'POST', `${projectUrl(parent._id)}/archive`)).statusCode).toBe(204);
    expect((await w.call('pat', 'DELETE', projectUrl(gone._id))).statusCode).toBe(200);
    expect((await w.call('sam', 'DELETE', `/api/roadmaps/${w.growth._id}/members/${w.pat._id}`)).statusCode).toBe(204);
    expect((await w.call('sam', 'DELETE', `/api/roadmaps/${third._id}`, { confirmName: 'Third' })).statusCode).toBe(204);

    const after = parseFeed((await w.fetchFeed(url)).body);
    expect(after.events.map((e) => e.uid)).toEqual([itemUid(done._id)]);
  });

  test('FR-4.2: a chosen roadmap the person has since left shows nothing, and an emptied list shows an empty calendar', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    await w.item(w.growth._id, { title: 'Growth', endDate: '2026-02-07' });
    await setChoices(w, { roadmaps: [w.growth._id] });
    expect(parseFeed((await w.fetchFeed(url)).body).events).toHaveLength(1);
    expect((await w.call('sam', 'DELETE', `/api/roadmaps/${w.growth._id}/members/${w.pat._id}`)).statusCode).toBe(204);
    expect(parseFeed((await w.fetchFeed(url)).body).events).toHaveLength(0);
    // Pat is still the owner of Launch, but an empty chosen list means no roadmaps.
    await w.item(w.launch._id, { title: 'Launch', endDate: '2026-02-08' });
    await t.db.collection('calendarFeeds').updateOne({ userId: w.pat._id }, { $set: { 'choices.roadmaps': [] } });
    const empty = await w.fetchFeed(url);
    expect(empty.statusCode).toBe(200);
    expect(parseFeed(empty.body)).toEqual({ name: 'Roadmap dates', events: [] });
  });

  test('FR-4.3: after an item\'s dates change, the next fetch has the same UID with a higher SEQUENCE and a new ETag', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const a = await w.item(w.launch._id, { title: 'A', startDate: '2026-06-01', endDate: '2026-06-03' });
    const first = await w.fetchFeed(url);
    const [ev1] = parseFeed(first.body).events;
    const patch = await w.call('pat', 'PATCH', `/api/roadmaps/${w.launch._id}/projects/${a._id}`, {
      version: 1,
      endDate: '2026-06-09',
    });
    expect(patch.statusCode).toBe(200);
    const second = await w.fetchFeed(url);
    const [ev2] = parseFeed(second.body).events;
    expect(ev2!.uid).toBe(ev1!.uid);
    expect(ev2!.sequence).toBeGreaterThan(ev1!.sequence);
    expect(ev2!.end).toBe('2026-06-10');
    expect(second.headers.etag).not.toBe(first.headers.etag);
  });

  test('FR-4.1: an unchanged feed fetched with its ETag answers 304 with no body', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    await w.item(w.launch._id, { title: 'A', endDate: '2026-06-03' });
    const first = await w.fetchFeed(url);
    const etag = first.headers.etag as string;
    const again = await w.fetchFeed(url, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['cache-control']).toBe('private, max-age=300');
    expect((await w.fetchFeed(url, { 'if-none-match': `"other", ${etag}` })).statusCode).toBe(304);
    expect((await w.fetchFeed(url, { 'if-none-match': '"other"' })).statusCode).toBe(200);
  });

  test('FR-4.1: 2,000 items with 5,000 milestones stop at 5,000 events and the calendar name says so', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
    const now = new Date();
    const docs: Array<Omit<ProjectDoc, 'tenantId'>> = Array.from({ length: 2000 }, (_, i) => ({
      _id: uuidv7(),
      roadmapId: w.launch._id,
      parentId: null,
      depth: 1,
      path: [],
      title: `Item ${i}`,
      description: '',
      status: 'not_started',
      startDate: day(i % 300),
      endDate: day((i % 300) + 5),
      milestones: Array.from({ length: i % 2 === 0 ? 3 : 2 }, (_, k) => ({ id: uuidv7(), name: `M${k}`, date: day((i * 7 + k) % 400) })),
      tags: [],
      links: [],
      blockedBy: [],
      assigneeIds: [],
      rank: i,
      priorityLabel: null,
      archived: false,
      version: 1,
      createdBy: 'seed',
      createdAt: now,
      updatedAt: now,
    }));
    expect(docs.reduce((n, d) => n + d.milestones.length, 0)).toBe(5000);
    await scoped(t.db, w.tenantId).collection('projects').insertMany(docs);

    const res = await w.fetchFeed(url);
    expect(res.statusCode).toBe(200);
    const feed = parseFeed(res.body);
    expect(feed.name).toBe('Roadmap dates (first 5,000 dates)');
    expect(feed.events).toHaveLength(CALENDAR_LIMITS.events);
    const expected = docs
      .flatMap((d) => eventsFor(d, { origin: t.config.appOrigin, itemDates: true, milestones: true }))
      .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
      .slice(0, CALENDAR_LIMITS.events)
      .map((e) => e.uid);
    expect(feed.events.map((e) => e.uid)).toEqual(expected);
  });

  test('FR-4.1: lastFetchedAt is written on the first fetch and at most every 10 minutes', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const lastFetched = async () => (await w.state()).feed!.lastFetchedAt;
    expect(await lastFetched()).toBeNull();
    const start = new Date();
    clock = start;
    await w.fetchFeed(url);
    expect(await lastFetched()).toBe(start.toISOString());
    clock = new Date(start.getTime() + 10 * 60_000);
    await w.fetchFeed(url);
    expect(await lastFetched()).toBe(start.toISOString());
    const later = new Date(start.getTime() + 10 * 60_000 + 1);
    clock = later;
    await w.fetchFeed(url);
    expect(await lastFetched()).toBe(later.toISOString());
    clock = new Date();
  });

  test('FR-4.1: the 61st fetch in a minute for one token is 429', async () => {
    const w = await calendarWorld(t);
    const url = await w.create();
    const other = await calendarWorld(t);
    const otherUrl = await other.create();
    for (let i = 0; i < CALENDAR_LIMITS.fetchesPerMinute; i++) {
      // From many addresses: the limit is per token, not per address.
      const res = await t.app.inject({ method: 'GET', url: pathOf(url), remoteAddress: `10.1.0.${i}` });
      expect(res.statusCode).toBe(200);
    }
    const over = await t.app.inject({ method: 'GET', url: pathOf(url), remoteAddress: '10.1.1.1' });
    expect(over.statusCode).toBe(429);
    // Another token is counted on its own.
    expect((await other.fetchFeed(otherUrl)).statusCode).toBe(200);
  });

  test('FR-4.1: request logs don\'t contain the token', async () => {
    const token = 'AbCdEf_the-secret-rest-of-the-calendar-token';
    expect(redactUrl(`/api/calendar/${token}.ics`)).toBe('/api/calendar/AbCdEf….ics');
    expect(redactUrl(`/api/calendar/${token}.ics?x=1`)).toBe('/api/calendar/AbCdEf….ics?x=1');
    expect(redactUrl('/api/me/calendar-feed')).toBe('/api/me/calendar-feed');

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const app = Fastify({ logger: { stream, serializers: { req: serializeRequest } } });
    app.get('/api/calendar/:token.ics', () => 'ok');
    await app.inject({ url: `/api/calendar/${token}.ics` });
    await app.close();
    const logged = lines.join('');
    expect(logged).toContain('/api/calendar/AbCdEf….ics');
    expect(logged).not.toContain('the-secret-rest');
  });

  test('Tenant isolation: a feed never shows another tenant\'s items', async () => {
    const w = await calendarWorld(t);
    const other = await calendarWorld(t);
    await other.item(other.launch._id, { title: 'Other tenant', endDate: '2026-02-01' });
    const url = await w.create();
    // Even a chosen list naming another tenant's roadmap, and a membership row in that tenant for Pat's id, show nothing.
    await t.db.collection('calendarFeeds').updateOne({ userId: w.pat._id }, { $set: { 'choices.roadmaps': [other.launch._id] } });
    await t.seed.member(other.tenantId, other.launch._id, w.pat._id, 'contributor');
    expect(parseFeed((await w.fetchFeed(url)).body).events).toEqual([]);
    await t.db.collection('calendarFeeds').updateOne({ userId: w.pat._id }, { $set: { 'choices.roadmaps': 'all' } });
    expect(parseFeed((await w.fetchFeed(url)).body).events).toEqual([]);
    // A signed-in session from the other tenant changes nothing.
    const theirs = await signInAs(t.app, t.db, other.pat._id);
    const res = await t.app.inject({ method: 'GET', url: pathOf(url), headers: { cookie: theirs.cookie } });
    expect(parseFeed(res.body).events).toEqual([]);
    expect((await w.state()).feed).not.toBeNull();
    expect((await other.state()) satisfies FeedState).toEqual({ feed: null });
  });
});

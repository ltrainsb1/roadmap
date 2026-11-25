import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_FEED_CHOICES, type FeedLink, type FeedState } from '@roadmap/shared';
import { hashToken } from '../../src/auth/tokens.ts';
import type { AuditEventDoc } from '../../src/db/types.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';
import { calendarWorld, tokenOf } from './world.ts';

/** The app's clock: the real time unless a test sets it. */
let clock: Date | null = null;
let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ now: () => clock ?? new Date() });
}, 120_000);
afterAll(async () => {
  await t?.close();
});

const feeds = () => t.db.collection<Record<string, unknown>>('calendarFeeds');
const auditOf = (userId: string) =>
  t.db
    .collection<AuditEventDoc>('auditEvents')
    .find({ action: 'user.calendar_feed', 'target.id': userId })
    .sort({ timestamp: 1, _id: 1 })
    .toArray();

describe('calendar feed settings', () => {
  test('FR-4.1: creating a feed returns its URL once; reading it afterwards never returns the URL or the token', async () => {
    const w = await calendarWorld(t);
    expect(await w.state()).toEqual({ feed: null });

    const res = await w.call('pat', 'POST', '/api/me/calendar-feed');
    expect(res.statusCode).toBe(201);
    const link = res.json<FeedLink>();
    expect(link.url).toMatch(/^http:\/\/localhost:5173\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(link.feed).toMatchObject({ choices: DEFAULT_FEED_CHOICES, lastFetchedAt: null });
    expect(Number.isNaN(Date.parse(link.feed!.createdAt))).toBe(false);

    const later = await w.call('pat', 'GET', '/api/me/calendar-feed');
    expect(later.statusCode).toBe(200);
    expect(later.json()).toEqual({ feed: link.feed });
    expect(later.body).not.toContain(tokenOf(link.url));
    expect(later.body).not.toContain('url');

    const again = await w.call('pat', 'POST', '/api/me/calendar-feed');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'feed_exists' });
  });

  test('FR-4.1: only the token\'s SHA-256 hash is stored, and the audit event holds neither', async () => {
    const w = await calendarWorld(t);
    const token = tokenOf(await w.create());
    const stored = await feeds().find({ userId: w.pat._id }).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ tenantId: w.tenantId, userId: w.pat._id, tokenHash: hashToken(token) });
    expect(JSON.stringify(stored)).not.toContain(token);

    const events = await auditOf(w.pat._id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'user.calendar_feed',
      actor: { type: 'user', userId: w.pat._id },
      target: { type: 'user', id: w.pat._id },
      after: { change: 'created', choices: DEFAULT_FEED_CHOICES },
    });
    expect(events[0]!.roadmapId).toBeUndefined();
    const text = JSON.stringify(events);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashToken(token));
  });

  test('FR-4.2: changing the choices returns them, keeps them and records before and after', async () => {
    const w = await calendarWorld(t);
    await w.create();
    const choices = { roadmaps: [w.launch._id], itemDates: false, milestones: true, onlyMine: true };
    const res = await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', choices);
    expect(res.statusCode).toBe(200);
    expect(res.json<FeedState>().feed!.choices).toEqual(choices);
    expect((await w.state()).feed!.choices).toEqual(choices);

    const events = await auditOf(w.pat._id);
    expect(events.map((e) => (e.after as { change: string }).change)).toEqual(['created', 'choices']);
    expect(events[1]).toMatchObject({ before: { choices: DEFAULT_FEED_CHOICES }, after: { change: 'choices', choices } });
  });

  test('FR-4.2: choices with nothing to show or no roadmap are refused', async () => {
    const w = await calendarWorld(t);
    await w.create();
    const none = { roadmaps: 'all', itemDates: false, milestones: false, onlyMine: false };
    expect((await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', none)).statusCode).toBe(400);
    const empty = { roadmaps: [], itemDates: true, milestones: true, onlyMine: false };
    expect((await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', empty)).statusCode).toBe(400);
    expect((await w.state()).feed!.choices).toEqual(DEFAULT_FEED_CHOICES);
  });

  test('FR-4.2: choosing a roadmap the person isn\'t a member of is refused', async () => {
    const w = await calendarWorld(t);
    await w.create();
    for (const roadmaps of [[w.secret._id], [w.launch._id, w.secret._id], ['no-such-roadmap']]) {
      const res = await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', { ...DEFAULT_FEED_CHOICES, roadmaps });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'unknown_roadmap' });
    }
    expect((await w.state()).feed!.choices).toEqual(DEFAULT_FEED_CHOICES);
    expect(await auditOf(w.pat._id)).toHaveLength(1);
  });

  test('FR-4.4: a new link starts afresh: no calendar app has checked it, and it was made now; the feed\'s own createdAt stays', async () => {
    const w = await calendarWorld(t);
    const made = new Date('2026-09-03T10:00:00.000Z');
    clock = made;
    try {
      const first = await w.call('pat', 'POST', '/api/me/calendar-feed');
      expect(first.json<FeedLink>().feed).toMatchObject({ createdAt: made.toISOString(), linkCreatedAt: made.toISOString() });
      clock = new Date('2026-11-20T13:05:00.000Z');
      await w.fetchFeed(first.json<FeedLink>().url);
      expect((await w.state()).feed!.lastFetchedAt).toBe('2026-11-20T13:05:00.000Z');

      const renewed = new Date('2026-11-22T08:00:00.000Z');
      clock = renewed;
      const res = await w.call('pat', 'POST', '/api/me/calendar-feed/new-link');
      expect(res.statusCode).toBe(200);
      const expected = { createdAt: made.toISOString(), linkCreatedAt: renewed.toISOString(), lastFetchedAt: null };
      expect(res.json<FeedLink>().feed).toMatchObject(expected);
      expect((await w.state()).feed).toMatchObject(expected);
    } finally {
      clock = null;
    }
  });

  test('FR-4.4: a feed stored before links had their own date reads its link date as createdAt', async () => {
    const w = await calendarWorld(t);
    await w.create();
    const stored = (await feeds().findOne({ userId: w.pat._id }))!;
    await feeds().updateOne({ _id: stored._id }, { $unset: { linkCreatedAt: '' } });
    const { feed } = await w.state();
    expect(feed!.linkCreatedAt).toBe(feed!.createdAt);
  });

  test('FR-4.4: "new link" replaces the hash and returns a new URL; "turn off" deletes the feed; both are recorded', async () => {
    const w = await calendarWorld(t);
    const first = await w.create();
    const res = await w.call('pat', 'POST', '/api/me/calendar-feed/new-link');
    expect(res.statusCode).toBe(200);
    const second = res.json<FeedLink>();
    expect(second.url).not.toBe(first);
    expect(second.feed!.choices).toEqual(DEFAULT_FEED_CHOICES);
    const stored = await feeds().find({ userId: w.pat._id }).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).toBe(hashToken(tokenOf(second.url)));

    const off = await w.call('pat', 'DELETE', '/api/me/calendar-feed');
    expect(off.statusCode).toBe(204);
    expect(off.body).toBe('');
    expect(await feeds().countDocuments({ userId: w.pat._id })).toBe(0);
    expect(await w.state()).toEqual({ feed: null });

    const events = await auditOf(w.pat._id);
    expect(events.map((e) => (e.after as { change: string }).change)).toEqual(['created', 'new_link', 'turned_off']);
    expect(events[2]).toMatchObject({ before: { choices: DEFAULT_FEED_CHOICES }, after: { change: 'turned_off', choices: null } });
    const text = JSON.stringify(events);
    for (const url of [first, second.url]) {
      expect(text).not.toContain(tokenOf(url));
      expect(text).not.toContain(hashToken(tokenOf(url)));
    }

    // A feed can be made again after it was turned off.
    expect((await w.call('pat', 'POST', '/api/me/calendar-feed')).statusCode).toBe(201);
  });

  test('FR-4.4: with no feed, changing choices, a new link and turning off are 404', async () => {
    const w = await calendarWorld(t);
    const choices = await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', DEFAULT_FEED_CHOICES);
    expect(choices.statusCode).toBe(404);
    expect(choices.json()).toEqual({ error: 'not_found' });
    expect((await w.call('pat', 'POST', '/api/me/calendar-feed/new-link')).statusCode).toBe(404);
    expect((await w.call('pat', 'DELETE', '/api/me/calendar-feed')).statusCode).toBe(404);
  });

  test('FR-4.1: the settings routes need a full session and a CSRF token on writes', async () => {
    const w = await calendarWorld(t);
    expect((await t.app.inject({ method: 'GET', url: '/api/me/calendar-feed' })).statusCode).toBe(401);
    expect((await w.call('pat', 'POST', '/api/me/calendar-feed', undefined, false)).statusCode).toBe(403);
    await w.create();
    for (const [method, url] of [
      ['PUT', '/api/me/calendar-feed/choices'],
      ['POST', '/api/me/calendar-feed/new-link'],
      ['DELETE', '/api/me/calendar-feed'],
    ] as const) {
      const res = await w.call('pat', method, url, method === 'PUT' ? DEFAULT_FEED_CHOICES : undefined, false);
      expect(res.statusCode).toBe(403);
    }
  });

  test('FR-4.2: deleting a roadmap takes it out of every chosen list in that tenant, and a list left empty stays empty', async () => {
    const w = await calendarWorld(t);
    await w.create('pat');
    await w.create('sam');
    await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', { ...DEFAULT_FEED_CHOICES, roadmaps: [w.growth._id] });
    await w.call('sam', 'PUT', '/api/me/calendar-feed/choices', { ...DEFAULT_FEED_CHOICES, roadmaps: [w.growth._id, w.secret._id] });

    const del = await w.call('sam', 'DELETE', `/api/roadmaps/${w.growth._id}`, { confirmName: 'Growth' });
    expect(del.statusCode).toBe(204);
    expect((await w.state('pat')).feed!.choices.roadmaps).toEqual([]);
    expect((await w.state('sam')).feed!.choices.roadmaps).toEqual([w.secret._id]);
  });

  test('Tenant isolation: the settings routes can\'t reach another person\'s feed', async () => {
    const w = await calendarWorld(t);
    const other = await calendarWorld(t);
    const theirs = await other.create('pat');
    const theirHash = hashToken(tokenOf(theirs));

    // Neither a person in the same tenant nor one in another tenant sees or changes it.
    for (const v of [w, other]) {
      expect(await v.state('sam')).toEqual({ feed: null });
      expect((await v.call('sam', 'PUT', '/api/me/calendar-feed/choices', DEFAULT_FEED_CHOICES)).statusCode).toBe(404);
      expect((await v.call('sam', 'POST', '/api/me/calendar-feed/new-link')).statusCode).toBe(404);
      expect((await v.call('sam', 'DELETE', '/api/me/calendar-feed')).statusCode).toBe(404);
    }
    expect(await w.state('pat')).toEqual({ feed: null });
    // Another tenant's roadmap is a roadmap Pat doesn't belong to.
    await w.create('pat');
    const res = await w.call('pat', 'PUT', '/api/me/calendar-feed/choices', { ...DEFAULT_FEED_CHOICES, roadmaps: [other.launch._id] });
    expect(res.statusCode).toBe(422);

    const kept = await feeds().findOne({ userId: other.pat._id });
    expect(kept).toMatchObject({ tokenHash: theirHash, choices: DEFAULT_FEED_CHOICES });
  });
});

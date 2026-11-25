import ICAL from 'ical.js';
import type { FeedLink, FeedState, Milestone } from '@roadmap/shared';
import { v7 as uuidv7 } from 'uuid';
import type { ProjectDoc } from '../../src/db/types.ts';
import { signInAs, type TestApp } from '../helpers.ts';

type Session = { cookie: string; csrf: string };

// ical.js doesn't know X-WR-CALNAME; calendar apps read it as TEXT, so the tests do too.
(ICAL.design.defaultSet.property as Record<string, { defaultType: string }>)['x-wr-calname'] = { defaultType: 'text' };

/** Parses a feed back with ical.js: the calendar's name and its events' UIDs, summaries and sequences. */
export function parseFeed(ics: string) {
  const cal = new ICAL.Component(ICAL.parse(ics) as unknown[]);
  const events = cal.getAllSubcomponents('vevent').map((e) => ({
    uid: String(e.getFirstPropertyValue('uid')),
    summary: String(e.getFirstPropertyValue('summary')),
    sequence: Number(e.getFirstPropertyValue('sequence')),
    start: String(e.getFirstPropertyValue('dtstart')),
    end: String(e.getFirstPropertyValue('dtend')),
  }));
  return { name: String(cal.getFirstPropertyValue('x-wr-calname')), events };
}

/** The path a feed URL points at, for `inject`. */
export const pathOf = (url: string): string => new URL(url).pathname;
/** The token inside a feed URL. */
export const tokenOf = (url: string): string => /\/api\/calendar\/([^/]+)\.ics$/.exec(url)![1]!;

export async function calendarWorld(t: TestApp) {
  const tenantId = (await t.seed.tenant())._id;
  const pat = await t.seed.user(tenantId);
  const sam = await t.seed.user(tenantId);
  const launch = await t.seed.roadmap(tenantId, pat._id, 'Launch');
  const growth = await t.seed.roadmap(tenantId, sam._id, 'Growth');
  await t.seed.member(tenantId, growth._id, pat._id, 'contributor');
  // Pat is not a member of this one.
  const secret = await t.seed.roadmap(tenantId, sam._id, 'Secret');
  const sess: Record<'pat' | 'sam', Session> = {
    pat: await signInAs(t.app, t.db, pat._id),
    sam: await signInAs(t.app, t.db, sam._id),
  };

  const call = (who: 'pat' | 'sam', method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, csrf = true) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: sess[who].cookie, ...(csrf && { 'x-csrf-token': sess[who].csrf }) },
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });

  /** Creates the person's feed and returns its URL. */
  async function create(who: 'pat' | 'sam' = 'pat'): Promise<string> {
    const res = await call(who, 'POST', '/api/me/calendar-feed');
    if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
    return res.json<FeedLink>().url;
  }

  const state = async (who: 'pat' | 'sam' = 'pat') => (await call(who, 'GET', '/api/me/calendar-feed')).json<FeedState>();

  const fetchFeed = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: pathOf(url), headers });

  /** An item with dates and milestones, written straight to the collection. */
  async function item(
    roadmapId: string,
    o: { title?: string; startDate?: string; endDate?: string; milestones?: Array<Omit<Milestone, 'id'> & { id?: string }> } & Parameters<
      TestApp['seed']['project']
    >[2] = {},
  ): Promise<ProjectDoc> {
    const { milestones = [], ...rest } = o;
    const doc = await t.seed.project(tenantId, roadmapId, rest);
    if (milestones.length > 0) {
      const ms = milestones.map((m) => ({ id: m.id ?? uuidv7(), name: m.name, date: m.date }));
      await t.db.collection<ProjectDoc>('projects').updateOne({ _id: doc._id }, { $set: { milestones: ms } });
      return { ...doc, milestones: ms };
    }
    return doc;
  }

  return { tenantId, pat, sam, launch, growth, secret, sess, call, create, state, fetchFeed, item };
}

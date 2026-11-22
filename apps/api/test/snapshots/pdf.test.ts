import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import type { SnapshotDoc, SnapshotSessionDoc } from '../../src/db/types.ts';
import { RENDER_HEADER, RENDER_TOKEN_MS, SNAPSHOT_COOKIE } from '../../src/snapshots/access.ts';
import {
  FakePdfRenderer,
  HttpPdfRenderer,
  PdfBusyError,
  PdfFailedError,
  createPdfRenderer,
  type PdfRenderer,
} from '../../src/snapshots/pdf-renderer.ts';
import { TEST_ENV, makeTestApp, type TestApp } from '../helpers.ts';
import { PASSWORD, world } from './world.ts';

const HOUR = 60 * 60_000;

let clock = new Date();
const advance = (ms: number) => void (clock = new Date(clock.getTime() + ms));

type Render = PdfRenderer['render'];
/** What the app's renderer does in the current test; the fake unless a test swaps it. */
let fake = new FakePdfRenderer();
let render: Render = (input) => fake.render(input);

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ now: () => clock, pdfRenderer: { render: (input) => render(input) }, maxPdfRenders: 2 });
}, 120_000);
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  clock = new Date();
  fake = new FakePdfRenderer();
  render = (input) => fake.render(input);
});

let n = 0;
const ip = () => `10.5.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;

type World = Awaited<ReturnType<typeof world>>;

async function make(w: World, over: Record<string, unknown> = {}): Promise<{ id: string; linkId: string }> {
  const res = await w.create('A', { asOf: clock.toISOString().slice(0, 10), ...over });
  if (res.statusCode !== 201) throw new Error(`create: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string; linkId: string }>();
}

const unlock = (linkId: string, password: string, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/snapshots/${linkId}/unlock`,
    remoteAddress: ip(),
    headers,
    payload: { password },
  });

async function open(linkId: string): Promise<string> {
  const res = await unlock(linkId, PASSWORD);
  if (res.statusCode !== 204) throw new Error(`unlock: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === SNAPSHOT_COOKIE);
  if (!c) throw new Error('unlock: no cookie');
  return `${SNAPSHOT_COOKIE}=${c.value}`;
}

const pdf = (linkId: string, view: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url: `/api/snapshots/${linkId}/pdf`, headers, payload: { view } });
const content = (linkId: string, headers: Record<string, string>, query = '') =>
  t.app.inject({ method: 'GET', url: `/api/snapshots/${linkId}/content${query}`, headers });

/** Follows a download link through the app's local file route. */
async function download(url: string) {
  const u = new URL(url);
  return t.app.inject({ method: 'GET', url: `${u.pathname}${u.search}` });
}

const stored = (id: string) => t.db.collection<SnapshotDoc>('snapshots').findOne({ _id: id });
const keysOf = (snapshotId: string) => [...t.files.objects.keys()].filter((k) => k.includes(`/snapshots/${snapshotId}/`));
const renderSessions = (snapshotId: string) =>
  t.db.collection<SnapshotSessionDoc>('snapshotSessions').countDocuments({ snapshotId, kind: 'render' });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('making a PDF', () => {
  test('FR-3.4: the first request makes the PDF, stores it and returns a download link; the second returns a link without rendering again', async () => {
    const w = await world(t);
    await w.item({ title: 'Ship it' });
    const s = await make(w);
    const cookie = await open(s.linkId);

    const first = await pdf(s.linkId, 'list', { cookie });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(fake.calls).toHaveLength(1);
    const key = `${w.tenantId}/${w.roadmap._id}/snapshots/${s.id}/list.pdf`;
    expect(t.files.objects.get(key)?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await stored(s.id))?.pdfs).toEqual({ list: key });

    const file = await download(first.json<{ url: string }>().url);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const second = await pdf(s.linkId, 'list', { cookie });
    expect(second.statusCode).toBe(200);
    expect(typeof second.json<{ url: string }>().url).toBe('string');
    expect(fake.calls).toHaveLength(1);
    expect((await download(second.json<{ url: string }>().url)).statusCode).toBe(200);
  });

  test("FR-3.4: the renderer is given the print path and a token that opens this snapshot's content, and only for two minutes", async () => {
    const w = await world(t);
    await w.item();
    const s = await make(w, { name: 'Mine', include: { notes: true, assignees: false } });
    const other = await make(w, { name: 'Other' });
    const cookie = await open(s.linkId);
    let seen: { path: string; token: string } | undefined;
    const inside: Record<string, number | boolean> = {};

    render = async (input) => {
      seen = input;
      const header = { [RENDER_HEADER]: input.token };
      inside.content = (await content(s.linkId, header)).statusCode;
      inside.notes = (await content(s.linkId, header, '?notes=all')).statusCode;
      inside.other = (await content(other.linkId, header)).statusCode;
      inside.pdf = (await pdf(s.linkId, 'timeline', header)).statusCode;
      const status = await t.app.inject({ method: 'GET', url: `/api/snapshots/${s.linkId}`, headers: header });
      inside.status = status.json<{ unlocked: boolean }>().unlocked;
      const unlocked = await unlock(s.linkId, 'not the password at all', header);
      inside.unlock = unlocked.statusCode;
      inside.unlockCookie = unlocked.cookies.some((c) => c.name === SNAPSHOT_COOKIE);
      advance(RENDER_TOKEN_MS);
      inside.later = (await content(s.linkId, header)).statusCode;
      return fake.render(input);
    };
    expect((await pdf(s.linkId, 'list', { cookie })).statusCode).toBe(200);

    expect(seen?.path).toBe(`/s/${s.linkId}/print/list`);
    expect(inside).toEqual({
      content: 200,
      notes: 200,
      other: 401,
      pdf: 401,
      status: false,
      unlock: 401,
      unlockCookie: false,
      later: 401,
    });
    // Gone once the route has answered, whatever the clock says.
    clock = new Date();
    expect((await content(s.linkId, { [RENDER_HEADER]: seen!.token })).statusCode).toBe(401);
    expect(await renderSessions(s.id)).toBe(0);
    // The token earned nothing else: no second PDF, no viewer session.
    expect(Object.keys((await stored(s.id))?.pdfs ?? {})).toEqual(['list']);
  });

  test('FR-3.4: a render token opens nothing but the content route', async () => {
    const w = await world(t);
    const p = await w.item();
    const s = await make(w, { include: { notes: true, assignees: false } });
    const cookie = await open(s.linkId);
    const codes: number[] = [];
    render = async (input) => {
      const header = { [RENDER_HEADER]: input.token };
      const notes = await t.app.inject({ method: 'GET', url: `/api/snapshots/${s.linkId}/items/${p._id}/notes`, headers: header });
      codes.push(notes.statusCode);
      return fake.render(input);
    };
    expect((await pdf(s.linkId, 'list', { cookie })).statusCode).toBe(200);
    expect(codes).toEqual([401]);
  });

  test('FR-3.4: list and timeline are two PDFs with their own keys and file names', async () => {
    const w = await world(t);
    const s = await make(w, { asOf: '2026-11-01' });
    const cookie = await open(s.linkId);
    const list = await pdf(s.linkId, 'list', { cookie });
    const timeline = await pdf(s.linkId, 'timeline', { cookie });
    expect([list.statusCode, timeline.statusCode]).toEqual([200, 200]);
    expect(fake.calls.map((c) => c.path)).toEqual([`/s/${s.linkId}/print/list`, `/s/${s.linkId}/print/timeline`]);
    const prefix = `${w.tenantId}/${w.roadmap._id}/snapshots/${s.id}`;
    expect((await stored(s.id))?.pdfs).toEqual({ list: `${prefix}/list.pdf`, timeline: `${prefix}/timeline.pdf` });
    expect(keysOf(s.id).sort()).toEqual([`${prefix}/list.pdf`, `${prefix}/timeline.pdf`]);

    const names = await Promise.all(
      [list, timeline].map(async (r) => (await download(r.json<{ url: string }>().url)).headers['content-disposition']),
    );
    expect(names[0]).toContain('filename="Launch plan list 2026-11-01.pdf"');
    expect(names[1]).toContain('filename="Launch plan timeline 2026-11-01.pdf"');
  });

  test('FR-3.4: a third PDF while two are being made is refused with pdf_busy, and the count goes back down after a failure', async () => {
    const w = await world(t);
    const a = await make(w, { name: 'A' });
    const b = await make(w, { name: 'B' });
    const ready = await make(w, { name: 'Ready' });
    const [ca, cb, cr] = [await open(a.linkId), await open(b.linkId), await open(ready.linkId)];
    expect((await pdf(ready.linkId, 'list', { cookie: cr })).statusCode).toBe(200);

    // One render per print path, so each request is held and released by its own promises, whichever order the
    // requests reach the renderer in. (Handing out promises in arrival order let b's request take the one meant
    // for a's, and the test then waited on a request nobody would release.)
    const slots = new Map<string, { entered: ReturnType<typeof deferred<void>>; done: ReturnType<typeof deferred<Buffer>> }>();
    const slot = (path: string) => {
      let s = slots.get(path);
      if (!s) {
        s = { entered: deferred<void>(), done: deferred<Buffer>() };
        slots.set(path, s);
      }
      return s;
    };
    let renders = 0;
    render = (input) => {
      renders += 1;
      const s = slot(input.path);
      s.entered.resolve();
      return s.done.promise;
    };
    const aList = slot(`/s/${a.linkId}/print/list`);
    const bList = slot(`/s/${b.linkId}/print/list`);
    const aTimeline = slot(`/s/${a.linkId}/print/timeline`);
    const aPdf = async () => new FakePdfRenderer().render({ path: '', token: '' });

    const first = pdf(a.linkId, 'list', { cookie: ca });
    const second = pdf(b.linkId, 'list', { cookie: cb });
    await Promise.all([aList.entered.promise, bList.entered.promise]);

    const third = await pdf(a.linkId, 'timeline', { cookie: ca });
    expect(third.statusCode).toBe(503);
    expect(third.json()).toEqual({ error: 'pdf_busy' });
    expect(third.headers['cache-control']).toBe('no-store');
    // A PDF that already exists is never refused as busy.
    expect((await pdf(ready.linkId, 'list', { cookie: cr })).statusCode).toBe(200);

    aList.done.reject(new PdfFailedError('render_failed'));
    expect((await first).statusCode).toBe(502);

    const retry = pdf(a.linkId, 'timeline', { cookie: ca });
    await aTimeline.entered.promise;
    bList.done.resolve(await aPdf());
    aTimeline.done.resolve(await aPdf());
    expect((await second).statusCode).toBe(200);
    expect((await retry).statusCode).toBe(200);
    // Three renders: the refused request never reached the renderer.
    expect(renders).toBe(3);
    expect(await renderSessions(a.id)).toBe(0);
    expect(await renderSessions(b.id)).toBe(0);

    // Both slots are free again.
    render = (input) => fake.render(input);
    const again = await Promise.all([pdf(a.linkId, 'list', { cookie: ca }), pdf(b.linkId, 'timeline', { cookie: cb })]);
    expect(again.map((r) => r.statusCode)).toEqual([200, 200]);
  });

  test('FR-3.4: a renderer that fails, is busy, or returns something that is not a PDF stores nothing and marks nothing', async () => {
    const w = await world(t);
    const s = await make(w);
    const cookie = await open(s.linkId);
    const cases: Array<[Render, number, string]> = [
      [() => Promise.reject(new PdfFailedError('render_failed')), 502, 'pdf_failed'],
      [() => Promise.reject(new PdfBusyError('busy')), 503, 'pdf_busy'],
      [() => Promise.reject(new Error('socket hang up')), 502, 'pdf_failed'],
      [() => Promise.resolve(Buffer.from('<html>not a pdf</html>')), 502, 'pdf_failed'],
      [() => Promise.resolve(Buffer.alloc(0)), 502, 'pdf_failed'],
    ];
    for (const [impl, status, error] of cases) {
      render = impl;
      const res = await pdf(s.linkId, 'list', { cookie });
      expect(res.statusCode, error).toBe(status);
      expect(res.json()).toEqual({ error });
      expect(keysOf(s.id)).toEqual([]);
      expect((await stored(s.id))?.pdfs).toEqual({});
      expect(await renderSessions(s.id)).toBe(0);
    }

    render = (input) => fake.render(input);
    expect((await pdf(s.linkId, 'list', { cookie })).statusCode).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(keysOf(s.id)).toHaveLength(1);
  });

  test('FR-3.4: a PDF finished after the snapshot was revoked is not kept', async () => {
    const w = await world(t);
    const s = await make(w);
    const cookie = await open(s.linkId);
    render = async (input) => {
      const revoked = await w.call('A', 'DELETE', `/snapshots/${s.id}`);
      if (revoked.statusCode !== 204) throw new Error(`revoke: ${revoked.statusCode}`);
      return fake.render(input);
    };
    const res = await pdf(s.linkId, 'list', { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(keysOf(s.id)).toEqual([]);
    expect(await stored(s.id)).toBeNull();
    expect(await renderSessions(s.id)).toBe(0);
  });

  test("FR-3.4: a PDF needs the viewer's cookie", async () => {
    const w = await world(t);
    const s = await make(w, { expiresAt: new Date(clock.getTime() + HOUR).toISOString() });
    const none = await pdf(s.linkId, 'list');
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: 'password_required' });

    const cookie = await open(s.linkId);
    expect((await pdf(s.linkId, 'board', { cookie })).statusCode).toBe(400);
    advance(2 * HOUR);
    const expired = await pdf(s.linkId, 'list', { cookie });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toEqual({ error: 'snapshot_expired' });
    expect((await pdf('no-such-link-id-at-all-here', 'list', { cookie })).statusCode).toBe(404);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('HttpPdfRenderer', () => {
  const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n');

  function stub(respond: (signal: AbortSignal) => Promise<Response>) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = ((url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return respond(init.signal!);
    }) as typeof fetch;
    return { f, seen };
  }
  const reply = (status: number, body: string | Buffer, type: string) => () =>
    Promise.resolve(new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type } }));
  const json = (status: number, error: string) => reply(status, JSON.stringify({ error }), 'application/json');

  test('FR-3.4: HttpPdfRenderer posts the path and token, and maps 503 to busy and other failures to failed', async () => {
    const ok = stub(reply(200, PDF_BYTES, 'application/pdf'));
    const r = new HttpPdfRenderer({ url: 'http://pdf:3000/', timeoutMs: 60_000, fetch: ok.f });
    const out = await r.render({ path: '/s/abc/print/list', token: 'tok' });
    expect(out.equals(PDF_BYTES)).toBe(true);
    expect(ok.seen[0]!.url).toBe('http://pdf:3000/render');
    expect(ok.seen[0]!.init.method).toBe('POST');
    expect(new Headers(ok.seen[0]!.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(ok.seen[0]!.init.body as string)).toEqual({ path: '/s/abc/print/list', token: 'tok' });

    const input = { path: '/s/abc/print/list', token: 'tok' };
    const busy = new HttpPdfRenderer({ url: 'http://pdf:3000', timeoutMs: 60_000, fetch: stub(json(503, 'busy')).f });
    await expect(busy.render(input)).rejects.toBeInstanceOf(PdfBusyError);

    const failures = [
      json(400, 'bad_path'),
      json(502, 'render_failed'),
      json(504, 'timeout'),
      reply(200, '<html></html>', 'text/html'),
      reply(200, 'not a pdf', 'application/pdf'),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const respond of failures) {
      const failing = new HttpPdfRenderer({ url: 'http://pdf:3000', timeoutMs: 60_000, fetch: stub(respond).f });
      await expect(failing.render(input)).rejects.toBeInstanceOf(PdfFailedError);
    }

    // Never answers: the request is aborted after timeoutMs and counts as a failure.
    const hang = stub(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    );
    const slow = new HttpPdfRenderer({ url: 'http://pdf:3000', timeoutMs: 20, fetch: hang.f });
    const err = await slow.render(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfFailedError);
    expect((err as Error).message).toBe('pdf_timeout');
    expect(hang.seen[0]!.init.signal?.aborted).toBe(true);
  });

  test('FR-3.4: the fake renderer returns a small PDF, and the config picks the renderer', async () => {
    const f = new FakePdfRenderer();
    const bytes = await f.render({ path: '/s/x/print/list', token: 't' });
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(f.calls).toEqual([{ path: '/s/x/print/list', token: 't' }]);

    const base = { ...TEST_ENV, MONGO_URI: 'mongodb://unused' };
    expect(createPdfRenderer(loadConfig(base))).toBeInstanceOf(FakePdfRenderer);
    expect(createPdfRenderer(loadConfig({ ...base, PDF: 'service', PDF_URL: 'http://pdf:3000' }))).toBeInstanceOf(
      HttpPdfRenderer,
    );
    expect(() => createPdfRenderer({ ...loadConfig(base), pdf: 'service' })).toThrow(/PDF_URL/);
  });
});

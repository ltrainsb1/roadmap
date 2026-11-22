import { afterEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildPdfApp, loadPdfConfig, RenderTimeoutError, type Render } from '../src/app.ts';

const ORIGIN = 'http://web.internal:5173';
const LINK = 'AAAAAAAAAAAAAAAAAAAAAAAA';
const PDF = Buffer.from('%PDF-1.7 stub');

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function makeApp(render: Render, opts: { maxRenders?: number; timeoutMs?: number } = {}) {
  const app = buildPdfApp({
    render,
    renderOrigin: ORIGIN,
    maxRenders: opts.maxRenders ?? 2,
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  apps.push(app);
  return app;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const post = (app: FastifyInstance, body: unknown) => app.inject({ method: 'POST', url: '/render', payload: body as object });

test('FR-3.4: GET /health answers ok', async () => {
  const app = makeApp(() => Promise.resolve(PDF));
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});

test('FR-3.4: only snapshot print paths are rendered', async () => {
  const calls: Parameters<Render>[0][] = [];
  const app = makeApp((input) => {
    calls.push(input);
    return Promise.resolve(PDF);
  });

  const ok = await post(app, { path: `/s/${LINK}/print/list`, token: 'tok-1' });
  expect(ok.statusCode).toBe(200);
  expect(ok.headers['content-type']).toBe('application/pdf');
  expect(ok.rawPayload.equals(PDF)).toBe(true);
  expect(calls).toEqual([{ url: `${ORIGIN}/s/${LINK}/print/list`, token: 'tok-1', timeoutMs: 10_000 }]);

  const timeline = await post(app, { path: `/s/${LINK}/print/timeline`, token: 'tok-1' });
  expect(timeline.statusCode).toBe(200);
  expect(calls[1]?.url).toBe(`${ORIGIN}/s/${LINK}/print/timeline`);

  for (const path of [
    '/',
    '/s/x/print/list',
    `/s/${LINK}/print/list?next=//evil.example`,
    `//evil.example/s/${LINK}/print/list`,
    `/s/${LINK}/print/board`,
    `/s/${LINK}/print/list#x`,
    `/s/${LINK}/print/list/`,
    `/s/${LINK}/print/list\n`,
    `/s/${LINK}%2F..%2F/print/list`,
    `/s/../${LINK}/print/list`,
    `http://evil.example/s/${LINK}/print/list`,
    `/s/${'A'.repeat(65)}/print/list`,
    42,
  ]) {
    const res = await post(app, { path, token: 'tok-1' });
    expect({ path, status: res.statusCode, body: res.json<unknown>() }).toEqual({ path, status: 400, body: { error: 'bad_path' } });
  }
  expect(calls).toHaveLength(2);
});

test('FR-3.4: a render request without a usable token, or without a JSON body, is refused', async () => {
  let called = false;
  const app = makeApp(() => {
    called = true;
    return Promise.resolve(PDF);
  });
  for (const token of [undefined, '', 'has space', 'line\nbreak', 'x'.repeat(4097)]) {
    const res = await post(app, { path: `/s/${LINK}/print/list`, token });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_token' });
  }
  const notJson = await app.inject({ method: 'POST', url: '/render', payload: '<x/>', headers: { 'content-type': 'application/xml' } });
  expect(notJson.statusCode).toBe(415);
  expect(notJson.json()).toEqual({ error: 'bad_request' });
  const broken = await app.inject({ method: 'POST', url: '/render', payload: '{', headers: { 'content-type': 'application/json' } });
  expect(broken.statusCode).toBe(400);
  expect(broken.json()).toEqual({ error: 'bad_request' });
  const missing = await app.inject({ method: 'GET', url: '/nothing' });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'not_found' });
  expect(called).toBe(false);
});

test('FR-3.4: a third render while two are running is refused at once, and a slot frees when a render ends or fails', async () => {
  const pending: { result: ReturnType<typeof deferred<Buffer>> }[] = [];
  let enteredCount = 0;
  const entered: (() => void)[] = [];
  const app = makeApp(() => {
    enteredCount += 1;
    const result = deferred<Buffer>();
    pending.push({ result });
    entered.shift()?.();
    return result.promise;
  });
  const waitEntered = () => new Promise<void>((resolve) => entered.push(resolve));
  const body = { path: `/s/${LINK}/print/list`, token: 'tok' };

  const firstIn = waitEntered();
  const first = post(app, body);
  await firstIn;
  const secondIn = waitEntered();
  const second = post(app, body);
  await secondIn;

  const third = await post(app, body);
  expect(third.statusCode).toBe(503);
  expect(third.json()).toEqual({ error: 'busy' });
  expect(enteredCount).toBe(2);

  // The first render ends: its slot frees for the next request.
  pending[0]?.result.resolve(PDF);
  expect((await first).statusCode).toBe(200);
  const fourthIn = waitEntered();
  const fourth = post(app, body);
  await fourthIn;
  expect((await post(app, body)).statusCode).toBe(503);

  // The second render fails: its slot frees too.
  pending[1]?.result.reject(new Error('chromium crashed'));
  expect((await second).statusCode).toBe(502);
  const fifthIn = waitEntered();
  const fifth = post(app, body);
  await fifthIn;
  expect(enteredCount).toBe(4);

  pending[2]?.result.resolve(PDF);
  pending[3]?.result.resolve(PDF);
  expect((await fourth).statusCode).toBe(200);
  expect((await fifth).statusCode).toBe(200);
});

test('FR-3.4: a render that throws is 502, and one that times out is 504', async () => {
  const throwing = makeApp(() => Promise.reject(new Error('page reported an error')));
  const failed = await post(throwing, { path: `/s/${LINK}/print/list`, token: 'tok' });
  expect(failed.statusCode).toBe(502);
  expect(failed.json()).toEqual({ error: 'render_failed' });

  const timingOut = makeApp(() => Promise.reject(new RenderTimeoutError()));
  const timedOut = await post(timingOut, { path: `/s/${LINK}/print/list`, token: 'tok' });
  expect(timedOut.statusCode).toBe(504);
  expect(timedOut.json()).toEqual({ error: 'timeout' });
});

test('FR-3.4: a render that never settles is 504 at the deadline, and keeps its slot until it does settle', async () => {
  const hung = deferred<Buffer>();
  let calls = 0;
  const app = makeApp(() => (++calls === 1 ? hung.promise : Promise.resolve(PDF)), { maxRenders: 1, timeoutMs: 100 });
  const body = { path: `/s/${LINK}/print/list`, token: 'tok' };

  const res = await post(app, body);
  expect(res.statusCode).toBe(504);
  expect(res.json()).toEqual({ error: 'timeout' });
  // Chromium is still working on it, so the slot is still taken.
  expect((await post(app, body)).statusCode).toBe(503);

  // A late failure after the reply is swallowed, and the slot frees.
  hung.reject(new Error('late'));
  await hung.promise.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  expect((await post(app, body)).statusCode).toBe(200);
  expect(calls).toBe(2);
});

test('FR-3.4: the app refuses a render origin that is not a bare http or https origin', () => {
  const render: Render = () => Promise.resolve(PDF);
  for (const renderOrigin of ['ftp://web', 'http://web/', 'http://web/path', 'not a url', 'http://user@web']) {
    expect(() => buildPdfApp({ render, renderOrigin, maxRenders: 2, timeoutMs: 1000 })).toThrow(/renderOrigin/);
  }
});

test('FR-3.4: the config reads PORT, RENDER_ORIGIN, MAX_RENDERS and RENDER_TIMEOUT_MS with their defaults', () => {
  expect(loadPdfConfig({ RENDER_ORIGIN: 'http://web:8080' })).toEqual({
    port: 3200,
    renderOrigin: 'http://web:8080',
    maxRenders: 2,
    timeoutMs: 45_000,
  });
  expect(
    loadPdfConfig({ RENDER_ORIGIN: 'https://app.example', PORT: '4000', MAX_RENDERS: '3', RENDER_TIMEOUT_MS: '20000' }),
  ).toEqual({ port: 4000, renderOrigin: 'https://app.example', maxRenders: 3, timeoutMs: 20_000 });
  for (const env of [
    {},
    { RENDER_ORIGIN: 'ftp://web' },
    { RENDER_ORIGIN: 'http://web/path' },
    { RENDER_ORIGIN: 'http://web', MAX_RENDERS: '0' },
    { RENDER_ORIGIN: 'http://web', PORT: 'x' },
  ]) {
    expect(() => loadPdfConfig(env)).toThrow(/Invalid configuration/);
  }
});

test('FR-3.4: a render still unsettled past its deadline and grace fails the health check and asks for a restart once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let stuckCalls = 0;
    const hung = deferred<Buffer>();
    let entered = 0;
    let bothIn!: () => void;
    const bothEntered = new Promise<void>((resolve) => (bothIn = resolve));
    const app = buildPdfApp({
      render: () => {
        if (++entered === 2) bothIn();
        return hung.promise;
      },
      renderOrigin: ORIGIN,
      maxRenders: 2,
      timeoutMs: 1_000,
      stuckGraceMs: 1_000,
      onStuck: () => (stuckCalls += 1),
    });
    apps.push(app);
    const body = { path: `/s/${LINK}/print/list`, token: 'tok' };

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const first = post(app, body);
    const second = post(app, body);
    await bothEntered;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).statusCode).toBe(504);
    expect((await second).statusCode).toBe(504);
    // Past the deadline but inside the grace: not stuck yet.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(stuckCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ status: 'stuck' });
    // Both renders are stuck, but the server is asked to restart only once.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stuckCalls).toBe(1);
    hung.resolve(PDF);
  } finally {
    vi.useRealTimers();
  }
});

test('FR-3.4: a render that settles in time leaves the health check ok', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let stuckCalls = 0;
    const app = buildPdfApp({
      render: () => Promise.resolve(PDF),
      renderOrigin: ORIGIN,
      maxRenders: 2,
      timeoutMs: 1_000,
      stuckGraceMs: 1_000,
      onStuck: () => (stuckCalls += 1),
    });
    apps.push(app);
    expect((await post(app, { path: `/s/${LINK}/print/list`, token: 'tok' })).statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stuckCalls).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

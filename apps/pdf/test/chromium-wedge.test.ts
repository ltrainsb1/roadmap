import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { RenderTimeoutError } from '../src/app.ts';
import { createChromiumRender } from '../src/chromium.ts';

// No real browser: a stand-in for one that is still connected but answers slowly or not at all, with fake timers.
const ORIGIN = 'http://web.internal:5173';
const URL_OK = `${ORIGIN}/s/AAAAAAAAAAAAAAAAAAAAAAAA/print/list`;
const never = () => new Promise<never>(() => undefined);

/** A context whose page never gets anywhere (a slow page), and whose close either works or hangs. */
function fakeContext(closes: boolean) {
  const onClose: (() => void)[] = [];
  return {
    once: (event: string, fn: () => void) => {
      if (event === 'close') onClose.push(fn);
    },
    close: () => {
      if (!closes) return never();
      onClose.forEach((fn) => fn());
      return Promise.resolve();
    },
    routeWebSocket: never,
  };
}

function fakeBrowser(newContext: () => Promise<unknown>, connected = true) {
  return { isConnected: () => connected, newContext, close: () => Promise.resolve() } as unknown as Browser;
}

async function setUp(browser: Browser) {
  let wedged = 0;
  const chromium = await createChromiumRender({ renderOrigin: ORIGIN, browser, onWedged: () => (wedged += 1) });
  return { chromium, wedged: () => wedged };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

test('FR-3.4: a page that is only slow times out with its context closed and does not count as a wedged browser', async () => {
  const { chromium, wedged } = await setUp(fakeBrowser(() => Promise.resolve(fakeContext(true))));
  const result = expect(chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toBeInstanceOf(
    RenderTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  await result;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(wedged()).toBe(0);
});

test('FR-3.4: a context that does not finish closing within its grace reports the browser wedged, once', async () => {
  const { chromium, wedged } = await setUp(fakeBrowser(() => Promise.resolve(fakeContext(false))));
  const first = expect(chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toBeInstanceOf(
    RenderTimeoutError,
  );
  const second = expect(chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toBeInstanceOf(
    RenderTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  // Past the deadline, still inside the close grace: not wedged yet.
  expect(wedged()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  // Both renders end (their slots free), and the wedge is reported only once.
  await first;
  await second;
  expect(wedged()).toBe(1);
});

test('FR-3.4: a context that does not arrive by the deadline reports the browser wedged', async () => {
  const { chromium, wedged } = await setUp(fakeBrowser(never));
  const result = expect(chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toBeInstanceOf(
    RenderTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(wedged()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(wedged()).toBe(1);
});

test('FR-3.4: a context that fails to open, or a browser already gone, is not reported as wedged', async () => {
  const failing = await setUp(fakeBrowser(() => Promise.reject(new Error('cannot open'))));
  await expect(failing.chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toThrow('cannot open');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(failing.wedged()).toBe(0);

  const gone = await setUp(fakeBrowser(never, false));
  const result = expect(gone.chromium.render({ url: URL_OK, token: 't', timeoutMs: 1_000 })).rejects.toBeInstanceOf(
    RenderTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  await result;
  expect(gone.wedged()).toBe(0);
});

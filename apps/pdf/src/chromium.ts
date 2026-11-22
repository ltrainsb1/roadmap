import { chromium, errors, type Browser, type BrowserContext, type Route } from 'playwright-core';
import { RenderTimeoutError, type Render } from './app.ts';

/** How long a render may wait, past its deadline, for its context to close before it lets the slot go. */
const CLOSE_GRACE_MS = 10_000;

/** Run in the page: the footer meta's content, or null. A string, so it needs no DOM types here. */
const FOOTER_META = `document.querySelector('meta[name="pdf-footer"]')?.getAttribute('content') ?? null`;

/** The header that carries the render token. It is only ever sent to the render origin. */
export const TOKEN_HEADER = 'x-snapshot-render';

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** The page's own footer text (untrusted, so escaped), then Chromium's page numbers. */
export function footerTemplate(text: string | null): string {
  const lead = text ? `${escapeHtml(text)} · ` : '';
  return (
    '<div style="width:100%;margin:0 12mm;font-family:sans-serif;font-size:8px;color:#444;text-align:center;">' +
    `${lead}Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`
  );
}

/** Starts one headless Chromium; every render gets its own browser context, closed when the render ends. */
export async function createChromiumRender(opts: {
  renderOrigin: string;
}): Promise<{ render: Render; close(): Promise<void>; browser: Browser }> {
  const { renderOrigin } = opts;
  // Playwright turns Chromium's sandbox off by default; the pages it prints are ours, but it stays on regardless.
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });

  // Closes a context, waiting for it to be really gone (close() returns early while another close is under way), but
  // never longer than CLOSE_GRACE_MS: a browser that hangs must not hold a render slot forever.
  const closeWithin = async (context: BrowserContext, closed: Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_GRACE_MS)));
    const closing = (async () => {
      await context.close().catch(() => undefined);
      // A browser that has gone away takes its contexts with it, and emits nothing more.
      if (browser.isConnected()) await closed;
    })();
    await Promise.race([closing, grace]);
    clearTimeout(timer);
  };

  const print = async (context: BrowserContext, url: string, token: string, left: () => number) => {
    // No WebSocket is ever opened: a route that never connects to the server, closed at once.
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route('**/*', async (route: Route) => {
      const request = route.request();
      try {
        if (originOf(request.url()) !== renderOrigin) return await route.abort('blockedbyclient');
        // Fetched here rather than continued, so a redirect is seen, and refused, before the browser could follow
        // it to another origin with the token (Playwright does not route a redirect's later hops).
        const response = await route.fetch({
          headers: { ...request.headers(), [TOKEN_HEADER]: token },
          maxRedirects: 0,
          timeout: left(),
        });
        if (response.status() >= 300 && response.status() < 400) return await route.abort('blockedbyclient');
        return await route.fulfill({ response });
      } catch {
        // The context closed mid-request, or the fetch failed: the request fails and the render goes on or ends.
        await route.abort('failed').catch(() => undefined);
      }
    });

    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: left() });
    if (!response?.ok()) throw new Error(`the page answered ${response?.status() ?? 'nothing'}`);
    const marker = await page.waitForSelector('html[data-print="ready"], html[data-print="error"]', {
      state: 'attached',
      timeout: left(),
    });
    if ((await marker.getAttribute('data-print')) !== 'ready') throw new Error('the page reported an error');

    // Read in one step, in the page. What comes back is untrusted: anything but a string means no footer text.
    const footer = await page.evaluate<unknown>(FOOTER_META);
    const footerText = typeof footer === 'string' ? footer.slice(0, 300) : null;
    return await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footerTemplate(footerText),
    });
  };

  const render: Render = async ({ url, token, timeoutMs }) => {
    if (originOf(url) !== renderOrigin) throw new Error('the url is not on the render origin');
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    // The deadline covers everything from here, creating the context included; page.pdf has no timeout of its own.
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RenderTimeoutError()), timeoutMs);
    });
    const creating = browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    let context: BrowserContext | undefined;
    let closed: Promise<void> | undefined;

    try {
      context = await Promise.race([creating, expired]);
      const ctx = context;
      closed = new Promise<void>((resolve) => ctx.once('close', () => resolve()));
      return await Promise.race([print(ctx, url, token, left), expired]);
    } catch (err) {
      if (err instanceof errors.TimeoutError) throw new RenderTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
      if (context && closed) await closeWithin(context, closed);
      // A context that arrives after the deadline is closed as soon as it exists.
      else void creating.then((late) => late.close()).catch(() => undefined);
    }
  };

  return { render, close: () => browser.close(), browser };
}

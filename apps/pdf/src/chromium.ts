import { chromium, errors, type Browser, type Route } from 'playwright-core';
import { RenderTimeoutError, type Render } from './app.ts';

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

  const render: Render = async ({ url, token, timeoutMs }) => {
    if (originOf(url) !== renderOrigin) throw new Error('the url is not on the render origin');
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    // close() returns early while another close is under way; the render only ends once the context is really gone.
    const closed = new Promise<void>((resolve) => context.once('close', () => resolve()));
    let timedOut = false;
    // At the deadline the context is closed, which ends any step still waiting (page.pdf has no timeout of its own).
    const timer = setTimeout(() => {
      timedOut = true;
      void context.close().catch(() => undefined);
    }, timeoutMs);

    try {
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

      const meta = page.locator('meta[name="pdf-footer"]').first();
      const footer = (await meta.count()) > 0 ? await meta.getAttribute('content', { timeout: left() }) : null;
      const footerText = footer === null ? null : footer.slice(0, 300);
      return await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: footerTemplate(footerText),
      });
    } catch (err) {
      if (timedOut || err instanceof errors.TimeoutError) throw new RenderTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
      await context.close().catch(() => undefined);
      // A browser that has gone away takes its contexts with it; waiting then could hold the render slot forever.
      if (browser.isConnected()) await closed;
    }
  };

  return { render, close: () => browser.close(), browser };
}

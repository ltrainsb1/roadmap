import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { RenderTimeoutError } from '../src/app.ts';
import { createChromiumRender } from '../src/chromium.ts';

// A real browser is needed: these run only with TEST_PDF=chromium (CI's e2e job, or locally with Playwright's Chromium).
const gated = process.env.TEST_PDF === 'chromium';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

const page = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const becomeReady = (state: string) => `<script>setTimeout(() => document.documentElement.dataset.print = '${state}', 50)</script>`;

async function pdfText(bytes: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      );
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

describe.skipIf(!gated)('the Chromium render', () => {
  const seenByApp: Seen[] = [];
  const seenByOther: Seen[] = [];
  let appServer: Server;
  let otherServer: Server;
  let appOrigin: string;
  let otherOrigin: string;
  let chromium: Awaited<ReturnType<typeof createChromiumRender>>;

  beforeAll(async () => {
    otherServer = createServer((req, res) => {
      seenByOther.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('other');
    });
    otherServer.on('upgrade', (req, socket) => {
      seenByOther.push({ url: req.url ?? '', headers: req.headers });
      socket.destroy();
    });
    otherOrigin = await listen(otherServer);

    appServer = createServer((req, res) => {
      seenByApp.push({ url: req.url ?? '', headers: req.headers });
      const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      switch (req.url) {
        case '/ready':
          return html(
            page(
              `<h1>Atlas roadmap</h1><p>Launch the beta</p>${becomeReady('ready')}`,
              '<meta name="pdf-footer" content="Atlas · As of 12 Mar 2026 <b>&amp;">',
            ),
          );
        case '/plain':
          return html(page(`<h1>No footer text</h1>${becomeReady('ready')}`));
        case '/leaky':
          return html(
            page(
              `<h1>Leaky</h1>
               <img src="${otherOrigin}/pixel.png">
               <img src="/redirect-away">
               <script src="${otherOrigin}/script.js"></script>
               <script>
                 Promise.allSettled([
                   fetch('${otherOrigin}/fetch'),
                   fetch('/redirect-away'),
                   new Promise((done) => { const ws = new WebSocket('${otherOrigin.replace('http', 'ws')}/ws'); ws.onerror = ws.onclose = done; }),
                 ]).then(() => { document.documentElement.dataset.print = 'ready'; });
               </script>`,
            ),
          );
        case '/redirect-away':
          return res.writeHead(302, { location: `${otherOrigin}/redirected` }).end();
        case '/error':
          return html(page(`<h1>Broken</h1>${becomeReady('error')}`));
        case '/never':
          return html(page('<h1>Still loading</h1>'));
        default:
          return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
    });
    appOrigin = await listen(appServer);
    chromium = await createChromiumRender({ renderOrigin: appOrigin });
  });

  afterAll(async () => {
    await chromium?.close();
    await new Promise((resolve) => appServer?.close(resolve));
    await new Promise((resolve) => otherServer?.close(resolve));
  });

  test('FR-3.4: a ready page becomes a PDF with its text and a page-numbered footer', async () => {
    const bytes = await chromium.render({ url: `${appOrigin}/ready`, token: 'tok-ready', timeoutMs: 20_000 });
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const [first] = await pdfText(bytes);
    expect(first).toContain('Atlas roadmap');
    expect(first).toContain('Launch the beta');
    // The page's footer text is shown as text, its markup escaped, then the page numbers.
    expect(first).toMatch(/Atlas · As of 12 Mar 2026 <b>& · Page 1 of 1/);

    const plain = await chromium.render({ url: `${appOrigin}/plain`, token: 'tok-plain', timeoutMs: 20_000 });
    const [plainFirst] = await pdfText(plain);
    expect(plainFirst).toContain('No footer text');
    expect(plainFirst).toContain('Page 1 of 1');
    expect(plainFirst).not.toContain('·');
    expect(chromium.browser.contexts()).toEqual([]);
  });

  test('FR-3.4: the token is sent to the page\'s origin and no other origin is requested', async () => {
    seenByApp.length = 0;
    const bytes = await chromium.render({ url: `${appOrigin}/leaky`, token: 'tok-leaky', timeoutMs: 20_000 });
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const leaky = seenByApp.find((s) => s.url === '/leaky');
    expect(leaky?.headers['x-snapshot-render']).toBe('tok-leaky');
    // The same-origin redirect was asked for (with the token), but its hop to the other origin never happened.
    expect(seenByApp.some((s) => s.url === '/redirect-away')).toBe(true);
    expect(seenByApp.every((s) => s.headers['x-snapshot-render'] === 'tok-leaky')).toBe(true);
    expect(seenByOther).toEqual([]);
    expect(chromium.browser.contexts()).toEqual([]);
  });

  test('FR-3.4: a page that reports an error, or never becomes ready, fails the render and leaves no context open', async () => {
    await expect(chromium.render({ url: `${appOrigin}/error`, token: 't', timeoutMs: 20_000 })).rejects.toThrow(
      /reported an error/,
    );
    expect(chromium.browser.contexts()).toEqual([]);

    await expect(chromium.render({ url: `${appOrigin}/never`, token: 't', timeoutMs: 2_000 })).rejects.toBeInstanceOf(
      RenderTimeoutError,
    );
    expect(chromium.browser.contexts()).toEqual([]);

    await expect(chromium.render({ url: `${appOrigin}/missing`, token: 't', timeoutMs: 20_000 })).rejects.toThrow(
      /answered 404/,
    );
    expect(chromium.browser.contexts()).toEqual([]);

    await expect(chromium.render({ url: `${otherOrigin}/ready`, token: 't', timeoutMs: 20_000 })).rejects.toThrow(
      /not on the render origin/,
    );
    expect(chromium.browser.contexts()).toEqual([]);
    expect(seenByOther).toEqual([]);
  });
});

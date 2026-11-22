import { buildPdfApp, loadPdfConfig } from './app.ts';
import { createChromiumRender } from './chromium.ts';

const config = loadPdfConfig(process.env);
const chromium = await createChromiumRender({ renderOrigin: config.renderOrigin });

let closing = false;
// Exits with `code` once the browser is closed, or after 5 s if closing it hangs.
const closeBrowserAndExit = (code: number) => {
  closing = true;
  setTimeout(() => process.exit(code), 5_000).unref();
  chromium.close().then(
    () => process.exit(code),
    () => process.exit(1),
  );
};

const app = buildPdfApp({
  ...config,
  render: chromium.render,
  logger: true,
  // A render stuck past its deadline means Chromium hangs while still connected: restart rather than fill every slot.
  onStuck: () => closeBrowserAndExit(1),
});

// Without its browser the service can print nothing: exit, and let the container restart it.
chromium.browser.on('disconnected', () => {
  if (closing) return;
  app.log.error('chromium disconnected');
  process.exit(1);
});

const shutdown = () => {
  if (closing) return;
  app.close().then(
    () => closeBrowserAndExit(0),
    (err: unknown) => {
      app.log.error({ err }, 'shutdown failed');
      closeBrowserAndExit(1);
    },
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });

import { buildPdfApp, loadPdfConfig } from './app.ts';
import { createChromiumRender } from './chromium.ts';

const config = loadPdfConfig(process.env);
const chromium = await createChromiumRender({ renderOrigin: config.renderOrigin });
const app = buildPdfApp({ ...config, render: chromium.render, logger: true });

// Without its browser the service can print nothing: exit, and let the container restart it.
let closing = false;
chromium.browser.on('disconnected', () => {
  if (closing) return;
  app.log.error('chromium disconnected');
  process.exit(1);
});

const shutdown = () => {
  closing = true;
  void app
    .close()
    .then(() => chromium.close())
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });

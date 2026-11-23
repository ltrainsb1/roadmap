import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The gated Chromium tests launch a browser once and wait for pages up to a render timeout.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // server.ts only wires process env and a listening socket; chromium.ts is the browser adapter, proven by the
      // gated tests (TEST_PDF=chromium), which the coverage run does not include.
      exclude: ['src/server.ts', 'src/chromium.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});

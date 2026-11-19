import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Generous for container start-up in global setup; testTimeout stays at the default.
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // server.ts only wires process env and a listening socket; it is exercised by running the app.
      exclude: ['src/server.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Generous for container start-up in global setup; testTimeout stays at the default.
    hookTimeout: 120_000,
    // Every test app builds a fresh database and its indexes on the one shared MongoDB, which does that work one
    // build at a time. With 9 workers (cores - 1) a build waited up to 4 s in a queue, close to the 5 s test
    // timeout; 4 workers keep the longest wait under 2 s and cost about 2 s on a 27 s run.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // server.ts only wires process env and a listening socket; it is exercised by running the app.
      exclude: ['src/server.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': apiOrigin } },
  preview: {
    proxy: { '/api': apiOrigin },
    // The same policy the API sends, so the end-to-end run fails on an inline script or style.
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      // Playwright covers the screens; unit coverage counts the API client only.
      include: ['src/api/**'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: {
    coverage: {
      provider: 'v8',
      // Playwright covers the screens; unit coverage counts the API client only.
      include: ['src/api/**'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});

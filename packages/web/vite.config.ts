import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Runtime value (DEFAULT_THRESHOLDS) is taken straight from core's source so the
      // browser bundle never pulls in the Node-only engine code from core's dist entry.
      '@chess-analyzer/core/thresholds': fileURLToPath(
        new URL('../core/src/config/thresholds.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});

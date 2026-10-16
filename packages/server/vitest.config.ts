import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // better-sqlite3 is a native module; keep tests in a single forked process per file.
    pool: 'forks',
  },
});

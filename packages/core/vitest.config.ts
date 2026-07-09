import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration files share live Firebird servers; concurrent DDL from
    // parallel workers conflicts on the system tables.
    fileParallelism: false,
  },
});

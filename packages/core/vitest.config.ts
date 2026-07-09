import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration files share live Firebird servers; concurrent connections
    // from parallel workers deadlock on shared rows / DDL. Force ONE worker
    // running files sequentially.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});

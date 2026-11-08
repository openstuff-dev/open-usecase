import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The database tests share one Postgres and each resets its schema: one file at a time.
    fileParallelism: false,
  },
});

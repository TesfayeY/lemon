import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Rules tests share one emulator; run files serially
    fileParallelism: false,
    testTimeout: 15000,
  },
});

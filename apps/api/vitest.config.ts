import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false, // one shared test database
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
  },
});

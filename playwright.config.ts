import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the local dev servers (`npm run dev` is started if not already running).
// They use the local development database with fresh, randomly numbered test accounts.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:8081',
    reuseExistingServer: true,
    timeout: 240_000,
  },
  projects: [
    { name: 'business-desktop', testMatch: /business\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'worker-android', testMatch: /worker\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
});

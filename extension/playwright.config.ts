import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const outputDir = process.env.PIE_PLAYWRIGHT_OUTPUT_DIR
  ? path.resolve(process.env.PIE_PLAYWRIGHT_OUTPUT_DIR)
  : path.resolve(__dirname, 'test-results', 'browser');

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.pw.ts',
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.PIE_BROWSER_URL ?? 'http://127.0.0.1:1997',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

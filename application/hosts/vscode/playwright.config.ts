import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Use the same workspace test API as the repository-root specs. A package-local
// import can load a second Playwright instance when old private installs remain.
const { defineConfig, devices }: typeof import('@playwright/test') =
  createRequire(path.resolve(__dirname, '../../../package.json'))('@playwright/test');

const outputDir = process.env.PIE_PLAYWRIGHT_OUTPUT_DIR
  ? path.resolve(process.env.PIE_PLAYWRIGHT_OUTPUT_DIR)
  : path.join(os.tmpdir(), `pie-playwright-${process.pid}`);

export default defineConfig({
  testDir: '../../../test/integration/browser',
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

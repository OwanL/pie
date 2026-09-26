import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { defineConfig, devices } from '@playwright/test';

// Browser specs live at the repository root, outside this package's
// node_modules ancestry. Keep Playwright dependencies owned by the host package
// while making them resolvable in the runner and its worker processes.
const ownerNodeModules = path.resolve(__dirname, 'node_modules');
process.env.NODE_PATH = [ownerNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
createRequire(__filename)('node:module').Module._initPaths();

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

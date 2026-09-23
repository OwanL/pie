import { createRequire } from 'node:module';

// Browser/runtime packages remain installed and locked by extensions/playwright.
export const requirePlaywrightDependency = createRequire(new URL('../../extensions/playwright/package.json', import.meta.url));
